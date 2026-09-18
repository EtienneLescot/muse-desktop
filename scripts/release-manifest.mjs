#!/usr/bin/env node

/**
 * Build a deterministic, path-free integrity manifest for a Muse release.
 * The manifest contains no machine paths or timestamps, so it can be checked
 * into a release artifact and compared across build environments.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_MANIFEST_SCHEMA = "muse-desktop.release-manifest.v1";

export function fileDigest(filePath) {
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

export function buildReleaseManifest({ artifactPath, sidecarPath, version, target }) {
  if (!artifactPath || !sidecarPath) throw new Error("artifactPath and sidecarPath are required");
  const checkedVersion = String(version ?? "").trim();
  const checkedTarget = String(target ?? "").trim();
  if (!checkedVersion || !checkedTarget) throw new Error("version and target are required");
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    product: "Muse-Desktop",
    version: checkedVersion,
    target: checkedTarget,
    installer: fileDigest(artifactPath),
    sidecar: fileDigest(sidecarPath),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifactPath = argument("--artifact");
  const sidecarPath = argument("--sidecar");
  const outputPath = argument("--output") ?? `${artifactPath ?? "release"}.manifest.json`;
  const version = argument("--version") ?? "0.0.0";
  const target = argument("--target") ?? "x86_64-pc-windows-msvc";
  try {
    const manifest = buildReleaseManifest({ artifactPath, sidecarPath, version, target });
    writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${resolve(outputPath)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
