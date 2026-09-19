#!/usr/bin/env node

/**
 * Build and apply a deterministic, content-addressed release delta.
 *
 * A delta is deliberately local: callers provide both verified files and the
 * resulting bytes are checked against the target digest before publication.
 * It never downloads, executes or replaces an application by itself.
 */
import { createHash } from "node:crypto";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_DELTA_SCHEMA = "muse-desktop.release-delta.v1";
export const DEFAULT_DELTA_BLOCK_SIZE = 64 * 1024;
const MIN_BLOCK_SIZE = 4 * 1024;
const MAX_BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_BYTES = 128 * 1024 * 1024;

function checkedBlockSize(value) {
  const size = Number(value ?? DEFAULT_DELTA_BLOCK_SIZE);
  if (!Number.isSafeInteger(size) || size < MIN_BLOCK_SIZE || size > MAX_BLOCK_SIZE) {
    throw new Error(`block size must be an integer between ${MIN_BLOCK_SIZE} and ${MAX_BLOCK_SIZE}`);
  }
  return size;
}

function digest(bytes, file) {
  return { file: basename(file), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function readBounded(file, label) {
  const path = resolve(file);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
    throw new Error(`${label} is missing, not a file, or too large`);
  }
  return { path, bytes: await readFile(path) };
}

function blockEntries(bytes, blockSize) {
  const entries = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    entries.push(bytes.subarray(offset, Math.min(offset + blockSize, bytes.length)));
  }
  return entries;
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function assertDigest(label, expected, actual) {
  if (!expected || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
    throw new Error(`${label} does not match the release delta digest`);
  }
}

/** Build a path-free delta object and its compressed representation. */
export function buildReleaseDelta({ sourcePath, targetPath, blockSize = DEFAULT_DELTA_BLOCK_SIZE } = {}) {
  if (!sourcePath || !targetPath) throw new Error("sourcePath and targetPath are required");
  return Promise.all([readBounded(sourcePath, "source"), readBounded(targetPath, "target")]).then(([source, target]) => {
    const size = checkedBlockSize(blockSize);
    const sourceBlocks = blockEntries(source.bytes, size);
    const byHash = new Map();
    sourceBlocks.forEach((block, index) => {
      const key = createHash("sha256").update(block).digest("hex");
      const rows = byHash.get(key) ?? [];
      rows.push({ index, block });
      byHash.set(key, rows);
    });
    const operations = blockEntries(target.bytes, size).map((block) => {
      const key = createHash("sha256").update(block).digest("hex");
      const match = (byHash.get(key) ?? []).find((row) => sameBytes(row.block, block));
      return match
        ? { type: "copy", index: match.index, bytes: block.length }
        : { type: "data", bytes: block.length, data: block.toString("base64") };
    });
    const patch = {
      schema: RELEASE_DELTA_SCHEMA,
      encoding: "gzip+json",
      product: "Muse-Desktop",
      blockSize: size,
      source: digest(source.bytes, source.path),
      target: digest(target.bytes, target.path),
      operations,
    };
    const raw = Buffer.from(JSON.stringify(patch), "utf8");
    const compressed = gzipSync(raw, { level: 9, mtime: 0 });
    return {
      patch,
      bytes: compressed,
      stats: {
        sourceBytes: source.bytes.length,
        targetBytes: target.bytes.length,
        patchBytes: compressed.length,
        changedBlocks: operations.filter((operation) => operation.type === "data").length,
        totalBlocks: operations.length,
        useDelta: compressed.length < target.bytes.length,
      },
    };
  });
}

function validateDelta(patch) {
  if (!patch || typeof patch !== "object" || patch.schema !== RELEASE_DELTA_SCHEMA || patch.product !== "Muse-Desktop") {
    throw new Error("unsupported release delta");
  }
  if (patch.encoding !== "gzip+json") throw new Error("unsupported release delta encoding");
  const blockSize = checkedBlockSize(patch.blockSize);
  for (const [label, digestValue] of [["source", patch.source], ["target", patch.target]]) {
    if (!digestValue || typeof digestValue.file !== "string" || !Number.isSafeInteger(digestValue.bytes) ||
      digestValue.bytes < 0 || digestValue.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(digestValue.sha256)) {
      throw new Error(`${label} digest is invalid`);
    }
  }
  if (!Array.isArray(patch.operations) || patch.operations.length > Math.ceil(patch.target.bytes / blockSize)) {
    throw new Error("release delta operations are invalid");
  }
  const expectedBlocks = Math.ceil(patch.target.bytes / blockSize);
  if (patch.operations.length !== expectedBlocks) throw new Error("release delta block count does not match target");
  patch.operations.forEach((operation, index) => {
    const expectedBytes = Math.min(blockSize, patch.target.bytes - index * blockSize);
    if (!operation || operation.bytes !== expectedBytes) throw new Error("release delta block length is invalid");
    if (operation.type === "copy") {
      if (!Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index >= Math.ceil(patch.source.bytes / blockSize)) {
        throw new Error("release delta copy index is invalid");
      }
    } else if (operation.type === "data") {
      if (typeof operation.data !== "string") throw new Error("release delta data is invalid");
      const decoded = Buffer.from(operation.data, "base64");
      if (decoded.length !== operation.bytes) throw new Error("release delta data length is invalid");
    } else {
      throw new Error("release delta operation type is invalid");
    }
  });
  return patch;
}

export function decodeReleaseDelta(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PATCH_BYTES) {
    throw new Error("release delta is missing or too large");
  }
  let patch;
  try {
    patch = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`release delta cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDelta(patch);
}

/** Apply a delta in memory and verify the complete target digest. */
export function applyReleaseDelta({ sourceBytes, patch }) {
  if (!Buffer.isBuffer(sourceBytes)) throw new Error("sourceBytes must be a Buffer");
  const checked = validateDelta(patch);
  const sourceDigest = digest(sourceBytes, checked.source.file);
  assertDigest("source", checked.source, sourceDigest);
  const sourceBlocks = blockEntries(sourceBytes, checked.blockSize);
  const output = Buffer.concat(checked.operations.map((operation) => operation.type === "copy"
    ? sourceBlocks[operation.index]
    : Buffer.from(operation.data, "base64")));
  const targetDigest = digest(output, checked.target.file);
  assertDigest("target", checked.target, targetDigest);
  return output;
}

/** Apply and atomically publish a delta result at an explicit output path. */
export async function applyReleaseDeltaFile({ sourcePath, deltaPath, outputPath }) {
  const [source, delta] = await Promise.all([
    readBounded(sourcePath, "source"),
    readFile(resolve(deltaPath)),
  ]);
  const output = applyReleaseDelta({ sourceBytes: source.bytes, patch: decodeReleaseDelta(delta) });
  const destination = resolve(outputPath);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, output, { mode: 0o600 });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { path: destination, ...digest(output, destination) };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function cli() {
  const command = process.argv[2];
  if (command === "create") {
    const result = await buildReleaseDelta({
      sourcePath: argument("--from"),
      targetPath: argument("--to"),
      blockSize: argument("--block-size"),
    });
    const output = resolve(argument("--output") ?? "release.delta.gz");
    await access(dirname(output), constants.F_OK);
    await writeFile(output, result.bytes, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ path: output, ...result.stats })}\n`);
    return;
  }
  if (command === "apply") {
    const result = await applyReleaseDeltaFile({
      sourcePath: argument("--from"),
      deltaPath: argument("--patch"),
      outputPath: argument("--output"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("usage: release-delta.mjs create --from FILE --to FILE --output FILE [--block-size N] | apply --from FILE --patch FILE --output FILE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
