#!/usr/bin/env node

/**
 * Build and verify a path-free signed release channel index.
 *
 * The index is metadata only. It does not download or execute an artifact;
 * callers still pass the selected manifest and files to release-update.mjs.
 */
import { createPublicKey, sign, verify } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareReleaseVersions } from "./release-update.mjs";

export const RELEASE_CHANNEL_SCHEMA = "muse-desktop.release-channel.v1";
export const RELEASE_CHANNEL_SIGNATURE_ALGORITHM = "ed25519";
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_RELEASES = 100;
const MAX_TEXT = 120;
const MAX_URL = 2048;

function checkedText(value, label, max = MAX_TEXT) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) throw new Error(`${label} is missing or invalid`);
  return text;
}

function checkedVersion(value) {
  const version = checkedText(value, "version", 64);
  compareReleaseVersions(version, "0.0.0");
  return version;
}

function checkedUrl(value, label) {
  const text = checkedText(value, label, MAX_URL);
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`${label} must be an HTTPS URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragments`);
  }
  return parsed.toString();
}

function checkedDigest(value, label) {
  if (!value || typeof value !== "object" || typeof value.file !== "string" ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`${label} digest is invalid`);
  }
  const file = basename(value.file);
  if (!file || file === "." || file === ".." || file !== value.file || file.includes("\0")) {
    throw new Error(`${label} file name is unsafe`);
  }
  return { file, bytes: value.bytes, sha256: value.sha256 };
}

function checkedManifest(manifest, version, target) {
  if (!manifest || manifest.schema !== "muse-desktop.release-manifest.v1" || manifest.product !== "Muse-Desktop") {
    throw new Error("release manifest is invalid");
  }
  if (checkedVersion(manifest.version) !== version || checkedText(manifest.target, "target") !== target) {
    throw new Error("release manifest does not match its channel entry");
  }
  // Same rule as the builder: a Windows release bundles the engine, so a
  // channel cannot hand out a digest-less (engine-less) Windows manifest.
  if (/windows/.test(target) && manifest.sidecar === null) {
    throw new Error("a Windows release manifest must carry a sidecar digest");
  }
  const checked = {
    schema: manifest.schema,
    product: manifest.product,
    version,
    target,
    installer: checkedDigest(manifest.installer, "installer"),
    // `sidecar: null` is the schema for engine-not-bundled platforms (macOS).
    sidecar: manifest.sidecar === null ? null : checkedDigest(manifest.sidecar, "sidecar"),
  };
  if (manifest.signature !== undefined) {
    if (!manifest.signature || manifest.signature.algorithm !== "ed25519" ||
      typeof manifest.signature.keyId !== "string" || typeof manifest.signature.value !== "string") {
      throw new Error("release manifest signature is invalid");
    }
    checked.signature = {
      algorithm: "ed25519",
      keyId: checkedText(manifest.signature.keyId, "signature key id"),
      value: manifest.signature.value,
    };
  }
  return checked;
}

function checkedAssets(assets) {
  if (assets === undefined) return undefined;
  if (!assets || typeof assets !== "object") throw new Error("release assets are invalid");
  const checked = {};
  for (const kind of ["installer", "sidecar", "delta"]) {
    const asset = assets[kind];
    if (asset === undefined) continue;
    if (!asset || typeof asset !== "object") throw new Error(`${kind} asset is invalid`);
    checked[kind] = { url: checkedUrl(asset.url, `${kind} URL`) };
    if (asset.bytes !== undefined && (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0)) {
      throw new Error(`${kind} asset size is invalid`);
    }
    if (asset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`${kind} asset hash is invalid`);
    }
    if (asset.fromVersion !== undefined) checked[kind].fromVersion = checkedVersion(asset.fromVersion);
    if (asset.bytes !== undefined) checked[kind].bytes = asset.bytes;
    if (asset.sha256 !== undefined) checked[kind].sha256 = asset.sha256;
  }
  return Object.keys(checked).length > 0 ? checked : undefined;
}

function checkedReleases(releases) {
  if (!Array.isArray(releases) || releases.length === 0 || releases.length > MAX_RELEASES) {
    throw new Error(`channel must contain between 1 and ${MAX_RELEASES} releases`);
  }
  const seen = new Set();
  const checked = releases.map((release) => {
    if (!release || typeof release !== "object") throw new Error("release entry is invalid");
    const version = checkedVersion(release.version);
    const target = checkedText(release.target, "target");
    const key = `${version}\u0000${target}`;
    if (seen.has(key)) throw new Error("channel contains a duplicate version and target");
    seen.add(key);
    const result = { version, target, manifest: checkedManifest(release.manifest, version, target) };
    const assets = checkedAssets(release.assets);
    if (assets) result.assets = assets;
    return result;
  });
  return checked.sort((left, right) => {
    const versionOrder = compareReleaseVersions(right.version, left.version);
    return versionOrder || left.target.localeCompare(right.target);
  });
}

export function releaseChannelPayload(index) {
  return JSON.stringify({
    schema: index.schema,
    product: index.product,
    channel: index.channel,
    releases: index.releases,
  });
}

export function buildReleaseChannelIndex({ channel = "stable", releases, signingKey, keyId = "default" } = {}) {
  const index = {
    schema: RELEASE_CHANNEL_SCHEMA,
    product: "Muse-Desktop",
    channel: checkedText(channel, "channel", 32),
    releases: checkedReleases(releases),
  };
  if (!signingKey) return index;
  const id = checkedText(keyId, "signature key id");
  return {
    ...index,
    signature: {
      algorithm: RELEASE_CHANNEL_SIGNATURE_ALGORITHM,
      keyId: id,
      value: sign(null, Buffer.from(releaseChannelPayload(index), "utf8"), signingKey).toString("base64"),
    },
  };
}

export function verifyReleaseChannelIndex(index, { publicKey, requireSignature = false } = {}) {
  const checked = buildReleaseChannelIndex({
    channel: index?.channel,
    releases: index?.releases,
  });
  const signature = index?.signature;
  if (!signature) {
    if (requireSignature) throw new Error("release channel signature is required");
    return checked;
  }
  if (signature.algorithm !== RELEASE_CHANNEL_SIGNATURE_ALGORITHM || typeof signature.keyId !== "string" || typeof signature.value !== "string") {
    throw new Error("release channel signature is invalid");
  }
  if (!publicKey) throw new Error("release channel public key is required");
  let valid = false;
  try {
    const key = typeof publicKey === "object" && publicKey?.type ? publicKey : createPublicKey(publicKey);
    valid = verify(null, Buffer.from(releaseChannelPayload(checked), "utf8"), key, Buffer.from(signature.value, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("release channel signature could not be verified");
  return { ...checked, signature: { algorithm: signature.algorithm, keyId: checkedText(signature.keyId, "signature key id"), value: signature.value } };
}

export function selectRelease(index, { target, currentVersion = "0.0.0", allowPrerelease = false, publicKey, requireSignature = false } = {}) {
  const checked = verifyReleaseChannelIndex(index, { publicKey, requireSignature });
  const requestedTarget = checkedText(target, "target");
  const current = checkedVersion(currentVersion);
  const candidates = checked.releases.filter((release) => release.target === requestedTarget &&
    compareReleaseVersions(release.version, current) > 0 && (allowPrerelease || !release.version.includes("-")));
  return candidates[0] ?? null;
}

export async function readReleaseChannelIndex(indexPath) {
  const path = resolve(indexPath);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_INDEX_BYTES) throw new Error("release channel index is missing or too large");
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    throw new Error(`release channel index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function optionalPublicKey() {
  const path = argument("--public-key");
  return path ? readFile(resolve(path), "utf8") : undefined;
}

async function cli() {
  const command = process.argv[2];
  if (command === "build") {
    const input = JSON.parse(await readFile(resolve(argument("--releases")), "utf8"));
    const signingKeyPath = argument("--signing-key");
    const index = buildReleaseChannelIndex({
      channel: argument("--channel") ?? "stable",
      releases: input,
      ...(signingKeyPath ? { signingKey: await readFile(resolve(signingKeyPath), "utf8") } : {}),
      ...(argument("--key-id") ? { keyId: argument("--key-id") } : {}),
    });
    const output = resolve(argument("--output") ?? "release-channel.json");
    await writeFile(output, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    process.stdout.write(`${output}\n`);
    return;
  }
  if (command === "verify") {
    const index = await readReleaseChannelIndex(argument("--index"));
    const checked = verifyReleaseChannelIndex(index, {
      publicKey: await optionalPublicKey(),
      requireSignature: process.argv.includes("--require-signature"),
    });
    process.stdout.write(`${JSON.stringify({ schema: checked.schema, channel: checked.channel, releases: checked.releases.length })}\n`);
    return;
  }
  if (command === "select") {
    const index = await readReleaseChannelIndex(argument("--index"));
    const release = selectRelease(index, {
      target: argument("--target"),
      currentVersion: argument("--current-version"),
      allowPrerelease: process.argv.includes("--allow-prerelease"),
    });
    process.stdout.write(`${JSON.stringify(release)}\n`);
    return;
  }
  throw new Error("usage: release-channel.mjs build|verify|select …");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}