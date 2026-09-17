#!/usr/bin/env node

/** Verify a Muse release manifest against two explicitly supplied files. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_MANIFEST_SCHEMA } from "./release-manifest.mjs";

function digest(filePath) {
  const absolute = resolve(filePath);
  const stats = statSync(absolute);
  if (!stats.isFile()) throw new Error(`release input is not a file: ${absolute}`);
  const bytes = readFileSync(absolute);
  return {
    file: basename(absolute),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function compareFile(label, expected, actual, errors) {
  if (!expected || typeof expected !== "object") {
    errors.push(`${label} entry is missing`);
    return;
  }
  for (const key of ["file", "bytes", "sha256"]) {
    if (expected[key] !== actual[key]) {
      errors.push(`${label}.${key} mismatch (manifest ${String(expected[key])}, actual ${String(actual[key])})`);
    }
  }
}

/**
 * Verify a manifest without using paths stored inside it.
 * `artifactPath` and `sidecarPath` are always explicit caller inputs.
 */
export function verifyReleaseManifest({ manifestPath, artifactPath, sidecarPath, version, target }) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  } catch (error) {
    return {
      valid: false,
      errors: [`could not read release manifest: ${error instanceof Error ? error.message : String(error)}`],
      manifest: null,
    };
  }
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["release manifest must be an object"], manifest: null };
  }
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) errors.push("unsupported release manifest schema");
  if (manifest.product !== "Muse-Desktop") errors.push("unexpected release product");
  if (version !== undefined && manifest.version !== String(version).trim()) errors.push("release version mismatch");
  if (target !== undefined && manifest.target !== String(target).trim()) errors.push("release target mismatch");
  for (const [label, filePath] of [["installer", artifactPath], ["sidecar", sidecarPath]]) {
    if (!filePath) {
      errors.push(`${label} path is required`);
      continue;
    }
    try {
      compareFile(label, manifest[label], digest(filePath), errors);
    } catch (error) {
      errors.push(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { valid: errors.length === 0, errors, manifest };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = argument("--manifest");
  const artifactPath = argument("--artifact");
  const sidecarPath = argument("--sidecar");
  if (!manifestPath || !artifactPath || !sidecarPath) {
    process.stderr.write("Usage: verify-release-manifest.mjs --manifest FILE --artifact FILE --sidecar FILE [--version VERSION] [--target TARGET]\n");
    process.exitCode = 2;
  } else {
    const result = verifyReleaseManifest({
      manifestPath,
      artifactPath,
      sidecarPath,
      version: argument("--version"),
      target: argument("--target"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  }
}
