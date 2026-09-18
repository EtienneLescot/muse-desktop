#!/usr/bin/env node

/**
 * Prepare and apply a verified Muse release without replacing a running
 * executable in place. A launcher can switch between the `current` and
 * `previous` slots after the app exits, and call rollback if startup health
 * checks fail.
 *
 * This module deliberately does not download releases or claim a signature:
 * callers must provide the manifest and the two explicit local files. The
 * transaction handles verification, side-by-side staging and atomic slot
 * changes only.
 */
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileDigest } from "./release-manifest.mjs";
import {
  verifyReleaseManifest,
  verifyReleaseManifestSignature,
} from "./verify-release-manifest.mjs";

export const RELEASE_UPDATE_SCHEMA = "muse-desktop.release-update.v1";
export const RELEASE_UPDATE_STATE_SCHEMA = "muse-desktop.release-slots.v1";
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_VERSION_CHARS = 64;
const MAX_TARGET_CHARS = 80;

function checkedText(value, label, max = MAX_VERSION_CHARS) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${label} is missing or too long`);
  return text;
}

function parseVersion(value) {
  const text = checkedText(value, "version");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) throw new Error(`unsupported release version: ${text}`);
  return {
    text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Compare the bounded semver subset used by package.json/Tauri releases. */
export function compareReleaseVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function safeName(value, label) {
  const name = basename(checkedText(value, label, 240));
  if (name === "." || name === ".." || name.includes("\0")) {
    throw new Error(`${label} has an unsafe name`);
  }
  return name;
}

function isWithin(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === "" || (
    suffix !== ".." &&
    !suffix.startsWith("..\\") &&
    !suffix.startsWith("../") &&
    !isAbsolute(suffix)
  );
}

function assertDigest(label, expected, actual) {
  for (const key of ["file", "bytes", "sha256"]) {
    if (expected?.[key] !== actual[key]) {
      throw new Error(`${label}.${key} does not match the verified release manifest`);
    }
  }
}

async function readJson(path, maxBytes, label) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size > maxBytes) throw new Error(`${label} is missing or too large`);
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Build a path-free update plan and reject downgrades unless explicitly allowed. */
export function buildReleaseUpdatePlan({
  manifestPath,
  artifactPath,
  sidecarPath,
  currentVersion,
  target,
  channel = "stable",
  allowDowngrade = false,
  publicKey,
  requireSignature = false,
}) {
  const current = parseVersion(currentVersion);
  const checkedTarget = checkedText(target, "target", MAX_TARGET_CHARS);
  const checkedChannel = checkedText(channel, "channel", 32);
  const verification = verifyReleaseManifest({
    manifestPath,
    artifactPath,
    sidecarPath,
    target: checkedTarget,
    publicKey,
    requireSignature,
  });
  if (!verification.valid) {
    throw new Error(`release manifest verification failed: ${verification.errors.join("; ")}`);
  }
  const manifestVersion = parseVersion(verification.manifest.version);
  if (!allowDowngrade && compareReleaseVersions(manifestVersion.text, current.text) <= 0) {
    throw new Error(`release ${manifestVersion.text} is not newer than ${current.text}`);
  }
  return {
    schema: RELEASE_UPDATE_SCHEMA,
    product: "Muse-Desktop",
    action: "stage",
    channel: checkedChannel,
    currentVersion: current.text,
    candidateVersion: manifestVersion.text,
    target: checkedTarget,
    installer: verification.manifest.installer,
    sidecar: verification.manifest.sidecar,
    ...(verification.manifest.signature ? { signature: verification.manifest.signature } : {}),
    ...(allowDowngrade ? { allowDowngrade: true } : {}),
  };
}

function validatePlan(plan, { publicKey, requireSignature = false } = {}) {
  if (!plan || typeof plan !== "object") throw new Error("release update plan must be an object");
  if (plan.schema !== RELEASE_UPDATE_SCHEMA || plan.product !== "Muse-Desktop" || plan.action !== "stage") {
    throw new Error("unsupported release update plan");
  }
  parseVersion(plan.currentVersion);
  parseVersion(plan.candidateVersion);
  if (!plan.allowDowngrade && compareReleaseVersions(plan.candidateVersion, plan.currentVersion) <= 0) {
    throw new Error(`release ${plan.candidateVersion} is not newer than ${plan.currentVersion}`);
  }
  checkedText(plan.target, "target", MAX_TARGET_CHARS);
  safeName(plan.installer?.file, "installer file");
  safeName(plan.sidecar?.file, "sidecar file");
  const signatureErrors = verifyReleaseManifestSignature({
    schema: "muse-desktop.release-manifest.v1",
    product: "Muse-Desktop",
    version: plan.candidateVersion,
    target: plan.target,
    installer: plan.installer,
    sidecar: plan.sidecar,
    ...(plan.signature ? { signature: plan.signature } : {}),
  }, { publicKey, requireSignature });
  if (signatureErrors.length > 0) throw new Error(signatureErrors.join("; "));
  return plan;
}

/** Verify a plan again immediately before copying candidate files. */
export function verifyReleaseUpdatePlan({ plan, artifactPath, sidecarPath, publicKey, requireSignature = false }) {
  const checked = validatePlan(plan, { publicKey, requireSignature });
  const artifact = fileDigest(artifactPath);
  const sidecar = fileDigest(sidecarPath);
  assertDigest("installer", checked.installer, artifact);
  assertDigest("sidecar", checked.sidecar, sidecar);
  return checked;
}

function nonce() {
  return randomBytes(8).toString("hex");
}

/** Stage candidate files and publish the directory with one atomic rename. */
export async function stageReleaseUpdate({ plan, artifactPath, sidecarPath, stagingRoot, publicKey, requireSignature = false }) {
  const checked = verifyReleaseUpdatePlan({ plan, artifactPath, sidecarPath, publicKey, requireSignature });
  const root = resolve(stagingRoot);
  await mkdir(root, { recursive: true });
  const name = `candidate-${checked.candidateVersion}-${nonce()}`;
  const temporary = join(root, `.${name}.tmp`);
  const published = join(root, name);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    const installerName = safeName(checked.installer.file, "installer file");
    const sidecarName = safeName(checked.sidecar.file, "sidecar file");
    await copyFile(resolve(artifactPath), join(temporary, installerName));
    await copyFile(resolve(sidecarPath), join(temporary, sidecarName));
    await writeFile(join(temporary, "update-plan.json"), `${JSON.stringify(checked, null, 2)}\n`, "utf8");
    await writeFile(join(temporary, "READY"), "Muse release candidate is verified and ready.\n", "utf8");
    await rename(temporary, published);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { path: published, version: checked.candidateVersion };
}

async function readCandidate(candidatePath, { publicKey, requireSignature = false } = {}) {
  const candidate = resolve(candidatePath);
  const plan = validatePlan(await readJson(join(candidate, "update-plan.json"), MAX_PLAN_BYTES, "update plan"), {
    publicKey,
    requireSignature,
  });
  const installerPath = join(candidate, safeName(plan.installer.file, "installer file"));
  const sidecarPath = join(candidate, safeName(plan.sidecar.file, "sidecar file"));
  assertDigest("installer", plan.installer, fileDigest(installerPath));
  assertDigest("sidecar", plan.sidecar, fileDigest(sidecarPath));
  return { path: candidate, plan, installerPath, sidecarPath };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeState(slotsRoot, currentVersion, previousVersion) {
  const path = join(slotsRoot, "state.json");
  const temporary = `${path}.${nonce()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    schema: RELEASE_UPDATE_STATE_SCHEMA,
    product: "Muse-Desktop",
    currentVersion,
    previousVersion: previousVersion ?? null,
  }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Atomically promote a staged candidate, retaining the prior slot for rollback. */
export async function applyStagedRelease({ stagedPath, slotsRoot, publicKey, requireSignature = false }) {
  const root = resolve(slotsRoot);
  const candidate = resolve(stagedPath);
  if (!isWithin(root, candidate) || candidate === root) {
    throw new Error("staged release must live under the slots root");
  }
  if (!(await exists(join(candidate, "READY")))) throw new Error("staged release is missing its READY marker");
  const verified = await readCandidate(candidate, { publicKey, requireSignature });
  const current = join(root, "current");
  const previous = join(root, "previous");
  const displaced = join(root, `.displaced-${nonce()}`);
  await mkdir(root, { recursive: true });
  let movedCurrent = false;
  try {
    if (await exists(previous)) await rm(previous, { recursive: true, force: true });
    if (await exists(current)) {
      await rename(current, previous);
      movedCurrent = true;
    }
    await rename(candidate, current);
    await writeState(root, verified.plan.candidateVersion, movedCurrent ? verified.plan.currentVersion : null);
  } catch (error) {
    if (await exists(current)) await rename(current, displaced).catch(() => undefined);
    if (movedCurrent && await exists(previous)) await rename(previous, current).catch(() => undefined);
    if (await exists(displaced)) await rename(displaced, candidate).catch(() => undefined);
    throw error;
  }
  return {
    currentVersion: verified.plan.candidateVersion,
    previousVersion: movedCurrent ? verified.plan.currentVersion : null,
    currentPath: current,
  };
}

/** Swap the two slots and persist the resulting active version. */
export async function rollbackRelease({ slotsRoot, publicKey, requireSignature = false }) {
  const root = resolve(slotsRoot);
  const current = join(root, "current");
  const previous = join(root, "previous");
  if (!(await exists(current)) || !(await exists(previous))) {
    throw new Error("rollback requires both current and previous release slots");
  }
  const temporary = join(root, `.rollback-${nonce()}`);
  await rename(current, temporary);
  try {
    await rename(previous, current);
    await rename(temporary, previous);
  } catch (error) {
    if (await exists(current)) await rename(current, previous).catch(() => undefined);
    if (await exists(temporary)) await rename(temporary, current).catch(() => undefined);
    throw error;
  }
  const currentPlan = validatePlan(await readJson(join(current, "update-plan.json"), MAX_PLAN_BYTES, "current update plan"), {
    publicKey,
    requireSignature,
  });
  const previousPlan = validatePlan(await readJson(join(previous, "update-plan.json"), MAX_PLAN_BYTES, "previous update plan"), {
    publicKey,
    requireSignature,
  });
  await writeState(root, currentPlan.candidateVersion, previousPlan.candidateVersion);
  return { currentVersion: currentPlan.candidateVersion, previousVersion: previousPlan.candidateVersion };
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
  return path ? readFile(path, "utf8") : undefined;
}

async function cli() {
  const command = process.argv[2];
  if (command === "plan") {
    const plan = buildReleaseUpdatePlan({
      manifestPath: requireArgument("--manifest"),
      artifactPath: requireArgument("--artifact"),
      sidecarPath: requireArgument("--sidecar"),
      currentVersion: requireArgument("--current-version"),
      target: requireArgument("--target"),
      channel: argument("--channel") ?? "stable",
      allowDowngrade: process.argv.includes("--allow-downgrade"),
      publicKey: await optionalPublicKey(),
      requireSignature: process.argv.includes("--require-signature"),
    });
    const output = resolve(requireArgument("--output"));
    await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`${output}\n`);
    return;
  }
  if (command === "stage") {
    const plan = await readJson(requireArgument("--plan"), MAX_PLAN_BYTES, "update plan");
    const result = await stageReleaseUpdate({
      plan,
      artifactPath: requireArgument("--artifact"),
      sidecarPath: requireArgument("--sidecar"),
      stagingRoot: requireArgument("--staging-root"),
      publicKey: await optionalPublicKey(),
      requireSignature: process.argv.includes("--require-signature"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "apply") {
    const result = await applyStagedRelease({
      stagedPath: requireArgument("--staged"),
      slotsRoot: requireArgument("--slots-root"),
      publicKey: await optionalPublicKey(),
      requireSignature: process.argv.includes("--require-signature"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "rollback") {
    const result = await rollbackRelease({
      slotsRoot: requireArgument("--slots-root"),
      publicKey: await optionalPublicKey(),
      requireSignature: process.argv.includes("--require-signature"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("usage: release-update.mjs plan|stage|apply|rollback …");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
