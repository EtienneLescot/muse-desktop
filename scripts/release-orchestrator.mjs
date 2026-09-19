#!/usr/bin/env node

/**
 * Orchestrate a verified remote release into a local staged candidate.
 *
 * The channel is trusted only after its signature is checked. Asset URLs and
 * digests come from that checked index; each body is fetched with redirects
 * disabled, bounded, hashed, and atomically published before release-update
 * verifies the manifest again. This command never installs or executes files.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchReleaseAsset } from "./release-fetch.mjs";
import { buildReleaseUpdatePlan, stageReleaseUpdate } from "./release-update.mjs";
import {
  readReleaseChannelIndex,
  selectRelease,
  verifyReleaseChannelIndex,
} from "./release-channel.mjs";

export const MAX_RELEASE_CHANNEL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CHANNEL_FETCH_TIMEOUT_MS = 30_000;

function checkedUrl(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2_048) throw new Error("release channel URL is missing or too long");
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error("release channel URL must use HTTPS"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("release channel URL must use HTTPS without credentials or fragments");
  }
  return parsed.toString();
}

function checkedTimeout(value) {
  const timeout = Number(value ?? DEFAULT_CHANNEL_FETCH_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10 * 60 * 1000) {
    throw new Error("release channel timeout is invalid");
  }
  return timeout;
}

async function readResponseBytes(response, maxBytes) {
  const header = response.headers?.get?.("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > maxBytes) {
    throw new Error("release channel exceeds the configured size limit");
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
          throw new Error("release channel exceeds the configured size limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== "function") throw new Error("release channel response has no readable body");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("release channel exceeds the configured size limit");
  return bytes;
}

/** Fetch and parse a signed channel index over HTTPS without following redirects. */
export async function fetchReleaseChannel({
  url,
  timeoutMs = DEFAULT_CHANNEL_FETCH_TIMEOUT_MS,
  maxBytes = MAX_RELEASE_CHANNEL_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const channelUrl = checkedUrl(url);
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RELEASE_CHANNEL_BYTES) {
    throw new Error("release channel size limit is invalid");
  }
  const timeout = checkedTimeout(timeoutMs);
  if (typeof fetchImpl !== "function") throw new Error("HTTPS fetch is unavailable in this runtime");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetchImpl(channelUrl, { redirect: "error", signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`release channel fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response?.ok || response.status < 200 || response.status >= 300) {
    clearTimeout(timer);
    throw new Error(`release channel fetch returned HTTP ${response?.status ?? "unknown"}`);
  }
  let bytes;
  try {
    bytes = await readResponseBytes(response, limit);
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`release channel is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Load a channel from a local index or an HTTPS URL. */
export async function loadReleaseChannel({ indexPath, indexUrl, ...options } = {}) {
  if (indexPath && indexUrl) throw new Error("provide either --index or --index-url, not both");
  if (indexUrl) return fetchReleaseChannel({ url: indexUrl, ...options });
  if (indexPath) return readReleaseChannelIndex(indexPath);
  throw new Error("a release channel index path or HTTPS URL is required");
}

function safeCachePart(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 120 || !/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`${label} is invalid for a release cache path`);
  }
  return text;
}

function assetFor(release, kind) {
  const manifestAsset = release.manifest?.[kind];
  const channelAsset = release.assets?.[kind];
  if (!channelAsset || typeof channelAsset.url !== "string") {
    throw new Error(`channel entry is missing the ${kind} asset URL`);
  }
  if (!manifestAsset || !Number.isSafeInteger(manifestAsset.bytes) || typeof manifestAsset.sha256 !== "string") {
    throw new Error(`channel entry is missing the ${kind} manifest digest`);
  }
  return {
    url: channelAsset.url,
    bytes: channelAsset.bytes ?? manifestAsset.bytes,
    sha256: channelAsset.sha256 ?? manifestAsset.sha256,
    file: basename(manifestAsset.file),
  };
}

/** Select, fetch, verify, and stage the newest compatible release. */
export async function orchestrateReleaseUpdate({
  index,
  indexPath,
  indexUrl,
  target,
  currentVersion,
  cacheDir,
  stagingRoot,
  publicKey,
  requireSignature = false,
  allowPrerelease = false,
  timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const rawIndex = index ?? await loadReleaseChannel({ indexPath, indexUrl, timeoutMs, fetchImpl });
  const checkedIndex = verifyReleaseChannelIndex(rawIndex, { publicKey, requireSignature });
  const release = selectRelease(checkedIndex, { target, currentVersion, allowPrerelease, publicKey, requireSignature });
  if (release === null) {
    return { status: "up-to-date", channel: checkedIndex.channel, currentVersion, target };
  }
  const cacheText = String(cacheDir ?? "").trim();
  const stagingText = String(stagingRoot ?? "").trim();
  if (!cacheText) throw new Error("release cache directory is required");
  if (!stagingText) throw new Error("release staging root is required");
  const root = resolve(cacheText);
  const slots = resolve(stagingText);
  await mkdir(root, { recursive: true });
  const versionPart = safeCachePart(release.version, "release version");
  const targetPart = safeCachePart(target, "release target");
  const cache = await mkdtemp(join(root, `muse-release-${versionPart}-${targetPart}-`));
  const installer = assetFor(release, "installer");
  const sidecar = assetFor(release, "sidecar");
  const installerPath = join(cache, installer.file);
  const sidecarPath = join(cache, sidecar.file);
  const manifestPath = join(cache, "release.manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(release.manifest, null, 2)}\n`, "utf8");
  await fetchReleaseAsset({
    url: installer.url,
    expectedBytes: installer.bytes,
    expectedSha256: installer.sha256,
    outputPath: installerPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fetchImpl,
  });
  await fetchReleaseAsset({
    url: sidecar.url,
    expectedBytes: sidecar.bytes,
    expectedSha256: sidecar.sha256,
    outputPath: sidecarPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fetchImpl,
  });
  const plan = buildReleaseUpdatePlan({
    manifestPath,
    artifactPath: installerPath,
    sidecarPath,
    currentVersion,
    target,
    channel: checkedIndex.channel,
    publicKey,
    requireSignature,
  });
  const planPath = join(cache, "update-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const staged = await stageReleaseUpdate({
    plan,
    artifactPath: installerPath,
    sidecarPath,
    stagingRoot: slots,
    publicKey,
    requireSignature,
  });
  const metadata = await stat(staged.path);
  return {
    status: "staged",
    channel: checkedIndex.channel,
    currentVersion,
    target,
    version: release.version,
    cachePath: cache,
    planPath,
    stagedPath: staged.path,
    stagedBytes: metadata.size,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(name) {
  const value = argument(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function optionalPublicKey() {
  const path = argument("--public-key");
  return path ? readFile(resolve(path), "utf8") : undefined;
}

async function cli() {
  if (process.argv[2] !== "sync") {
    throw new Error("usage: release-orchestrator.mjs sync --index PATH|--index-url HTTPS_URL --target TARGET --current-version VERSION --cache-dir DIR --staging-root DIR [--public-key PATH --require-signature]");
  }
  const result = await orchestrateReleaseUpdate({
    indexPath: argument("--index"),
    indexUrl: argument("--index-url"),
    target: requireArgument("--target"),
    currentVersion: requireArgument("--current-version"),
    cacheDir: requireArgument("--cache-dir"),
    stagingRoot: requireArgument("--staging-root"),
    publicKey: await optionalPublicKey(),
    requireSignature: process.argv.includes("--require-signature"),
    allowPrerelease: process.argv.includes("--allow-prerelease"),
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