#!/usr/bin/env node

/**
 * Build a deterministic, path-free integrity manifest for a Muse release.
 * The manifest contains no machine paths or timestamps, so it can be checked
 * into a release artifact and compared across build environments.
 */
import { createHash, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_MANIFEST_SCHEMA = "muse-desktop.release-manifest.v1";
export const RELEASE_SIGNATURE_ALGORITHM = "ed25519";

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

/** Canonical, path-free bytes covered by an optional release signature. */
export function releaseManifestPayload(manifest) {
  return JSON.stringify({
    schema: manifest.schema,
    product: manifest.product,
    version: manifest.version,
    target: manifest.target,
    installer: manifest.installer,
    sidecar: manifest.sidecar,
  });
}

/** Add an Ed25519 signature without including machine paths or timestamps. */
export function signReleaseManifest(manifest, { privateKey, keyId = "default" }) {
  const id = String(keyId ?? "").trim();
  if (!id || id.length > 120 || /[\u0000-\u001f]/.test(id)) {
    throw new Error("release signing key id is invalid");
  }
  if (!privateKey) throw new Error("release signing key is required");
  const value = sign(null, Buffer.from(releaseManifestPayload(manifest), "utf8"), privateKey)
    .toString("base64");
  return {
    ...manifest,
    signature: {
      algorithm: RELEASE_SIGNATURE_ALGORITHM,
      keyId: id,
      value,
    },
  };
}

export function buildReleaseManifest({ artifactPath, sidecarPath, version, target, signingKey, keyId }) {
  if (!artifactPath) throw new Error("artifactPath is required");
  const checkedVersion = String(version ?? "").trim();
  const checkedTarget = String(target ?? "").trim();
  if (!checkedVersion || !checkedTarget) throw new Error("version and target are required");
  const manifest = {
    schema: RELEASE_MANIFEST_SCHEMA,
    product: "Muse-Desktop",
    version: checkedVersion,
    target: checkedTarget,
    installer: fileDigest(artifactPath),
    // Schema decision of 25/09/2026: macOS does not bundle the Muse engine
    // (the app offers the official CLI installer on first launch), so a
    // release without a sidecar carries `sidecar: null` and the whole update
    // chain treats that as "no sidecar file". Windows manifests keep a
    // digest here and stay byte-identical to the previous schema.
    sidecar: sidecarPath ? fileDigest(sidecarPath) : null,
  };
  return signingKey ? signReleaseManifest(manifest, { privateKey: signingKey, keyId }) : manifest;
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
  const signingKeyPath = argument("--signing-key");
  if (!artifactPath) {
    process.stderr.write("Usage: release-manifest.mjs --artifact FILE [--sidecar FILE] [--version VERSION] [--target TARGET] [--output FILE] [--signing-key FILE] [--key-id ID]\n");
    process.exitCode = 2;
  } else {
    try {
      const manifest = buildReleaseManifest({
        artifactPath,
        sidecarPath,
        version,
        target,
        ...(signingKeyPath ? { signingKey: readFileSync(resolve(signingKeyPath), "utf8") } : {}),
        ...(argument("--key-id") ? { keyId: argument("--key-id") } : {}),
      });
      writeFileSync(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      process.stdout.write(`${resolve(outputPath)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
