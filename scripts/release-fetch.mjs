#!/usr/bin/env node

/**
 * Fetch one signed-channel asset without handing control to a shell.
 *
 * The caller supplies the digest and size from a verified channel entry. The
 * response is HTTPS-only, redirects are rejected, the body is bounded before
 * hashing, and the destination is published by a single rename.
 */
import { createHash } from "node:crypto";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_RELEASE_ASSET_BYTES = 512 * 1024 * 1024;
export const DEFAULT_RELEASE_FETCH_TIMEOUT_MS = 120_000;

function checkedUrl(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2048) throw new Error("release asset URL is missing or too long");
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error("release asset URL must use HTTPS"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("release asset URL must use HTTPS without credentials or fragments");
  }
  return parsed.toString();
}

function checkedExpected({ expectedBytes, expectedSha256 }) {
  const bytes = Number(expectedBytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RELEASE_ASSET_BYTES) {
    throw new Error("release asset size is invalid");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("release asset SHA-256 is required");
  }
  return { bytes, sha256: expectedSha256 };
}

function checkedTimeout(value) {
  const timeout = Number(value ?? DEFAULT_RELEASE_FETCH_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10 * 60 * 1000) {
    throw new Error("release fetch timeout is invalid");
  }
  return timeout;
}

async function readResponseBytes(response, maxBytes) {
  const header = response.headers?.get?.("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > maxBytes) {
    throw new Error("release asset exceeds the configured size limit");
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("release asset exceeds the configured size limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== "function") throw new Error("release response has no readable body");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("release asset exceeds the configured size limit");
  return bytes;
}

/** Fetch and atomically publish one asset whose expected digest is known. */
export async function fetchReleaseAsset({
  url,
  expectedBytes,
  expectedSha256,
  outputPath,
  maxBytes = MAX_RELEASE_ASSET_BYTES,
  timeoutMs = DEFAULT_RELEASE_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const checked = checkedExpected({ expectedBytes, expectedSha256 });
  const assetUrl = checkedUrl(url);
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < checked.bytes || limit > MAX_RELEASE_ASSET_BYTES) {
    throw new Error("release asset size limit is invalid");
  }
  const timeout = checkedTimeout(timeoutMs);
  if (typeof fetchImpl !== "function") throw new Error("HTTPS fetch is unavailable in this runtime");
  const destination = resolve(String(outputPath ?? "").trim());
  if (!destination || basename(destination) === "." || basename(destination) === "..") {
    throw new Error("release asset output path is required");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetchImpl(assetUrl, { redirect: "error", signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`release asset fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response?.ok || response.status < 200 || response.status >= 300) {
    clearTimeout(timer);
    throw new Error(`release asset fetch returned HTTP ${response?.status ?? "unknown"}`);
  }
  let bytes;
  try {
    bytes = await readResponseBytes(response, Math.min(limit, MAX_RELEASE_ASSET_BYTES));
  } finally {
    clearTimeout(timer);
  }
  if (bytes.length !== checked.bytes) throw new Error("release asset size does not match the signed channel");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== checked.sha256) throw new Error("release asset SHA-256 does not match the signed channel");
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const metadata = await stat(destination);
  return { path: destination, bytes: metadata.size, sha256, url: assetUrl };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function cli() {
  if (process.argv[2] !== "fetch") {
    throw new Error("usage: release-fetch.mjs fetch --url HTTPS_URL --bytes N --sha256 HASH --output FILE [--timeout-ms N]");
  }
  const result = await fetchReleaseAsset({
    url: argument("--url"),
    expectedBytes: argument("--bytes"),
    expectedSha256: argument("--sha256"),
    outputPath: argument("--output"),
    timeoutMs: argument("--timeout-ms"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}