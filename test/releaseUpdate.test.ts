import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { buildReleaseManifest } from "../scripts/release-manifest.mjs";
import {
  applyStagedRelease,
  buildReleaseUpdatePlan,
  compareReleaseVersions,
  rollbackRelease,
  stageReleaseUpdate,
  verifyReleaseUpdatePlan,
} from "../scripts/release-update.mjs";

async function fixture(version = "1.2.0", root = undefined as string | undefined) {
  const base = root ?? await mkdtemp(join(tmpdir(), "muse-release-update-"));
  const artifact = join(base, `Muse-Desktop_${version}_x64-setup.exe`);
  const sidecar = join(base, "muse-x86_64-pc-windows-msvc.exe");
  const manifest = join(base, `release-${version}.manifest.json`);
  await writeFile(artifact, `installer-v${version}`, "utf8");
  await writeFile(sidecar, `sidecar-v${version}`, "utf8");
  const value = buildReleaseManifest({
    artifactPath: artifact,
    sidecarPath: sidecar,
    version,
    target: "x86_64-pc-windows-msvc",
  });
  await writeFile(manifest, `${JSON.stringify(value)}\n`, "utf8");
  return { root: base, artifact, sidecar, manifest };
}

describe("release update transaction", () => {
  it("compares release versions and orders stable releases after prereleases", () => {
    assert.equal(compareReleaseVersions("1.2.0", "1.1.9"), 1);
    assert.equal(compareReleaseVersions("1.2.0-beta.1", "1.2.0"), -1);
    assert.equal(compareReleaseVersions("1.2.0", "1.2.0"), 0);
  });

  it("builds a path-free plan and rejects a same-version candidate", async () => {
    const { root, artifact, sidecar, manifest } = await fixture();
    const plan = buildReleaseUpdatePlan({
      manifestPath: manifest,
      artifactPath: artifact,
      sidecarPath: sidecar,
      currentVersion: "1.1.0",
      target: "x86_64-pc-windows-msvc",
    });
    assert.deepEqual(plan, {
      schema: "muse-desktop.release-update.v1",
      product: "Muse-Desktop",
      action: "stage",
      channel: "stable",
      currentVersion: "1.1.0",
      candidateVersion: "1.2.0",
      target: "x86_64-pc-windows-msvc",
      installer: plan.installer,
      sidecar: plan.sidecar,
    });
    assert.equal(JSON.stringify(plan).includes(root), false);
    assert.throws(
      () => buildReleaseUpdatePlan({
        manifestPath: manifest,
        artifactPath: artifact,
        sidecarPath: sidecar,
        currentVersion: "1.2.0",
        target: "x86_64-pc-windows-msvc",
      }),
      /not newer/,
    );
  });

  it("stages, promotes, and rolls back without moving source artifacts", async () => {
    const { root, artifact: oldArtifact, sidecar: oldSidecar, manifest: oldManifest } = await fixture("1.1.0");
    const slots = join(root, "slots");
    const oldPlan = buildReleaseUpdatePlan({
      manifestPath: oldManifest,
      artifactPath: oldArtifact,
      sidecarPath: oldSidecar,
      currentVersion: "1.0.0",
      target: "x86_64-pc-windows-msvc",
    });
    const oldStaged = await stageReleaseUpdate({
      plan: oldPlan,
      artifactPath: oldArtifact,
      sidecarPath: oldSidecar,
      stagingRoot: slots,
    });
    await applyStagedRelease({ stagedPath: oldStaged.path, slotsRoot: slots });

    const { artifact, sidecar, manifest } = await fixture("1.2.0", root);
    const plan = buildReleaseUpdatePlan({
      manifestPath: manifest,
      artifactPath: artifact,
      sidecarPath: sidecar,
      currentVersion: "1.1.0",
      target: "x86_64-pc-windows-msvc",
    });
    const staged = await stageReleaseUpdate({
      plan,
      artifactPath: artifact,
      sidecarPath: sidecar,
      stagingRoot: slots,
    });
    assert.equal(await readFile(artifact, "utf8"), "installer-v1.2.0");
    assert.equal(await readFile(sidecar, "utf8"), "sidecar-v1.2.0");
    const current = await applyStagedRelease({ stagedPath: staged.path, slotsRoot: slots });
    assert.deepEqual(current, {
      currentVersion: "1.2.0",
      previousVersion: "1.1.0",
      currentPath: join(slots, "current"),
    });

    const tamperedPlan = {
      ...plan,
      installer: { ...plan.installer, sha256: "0".repeat(64) },
    };
    await assert.rejects(
      () => stageReleaseUpdate({
        plan: tamperedPlan,
        artifactPath: artifact,
        sidecarPath: sidecar,
        stagingRoot: slots,
      }),
      /does not match/,
    );

    const rollback = await rollbackRelease({ slotsRoot: slots });
    assert.deepEqual(rollback, { currentVersion: "1.1.0", previousVersion: "1.2.0" });
  });

  it("stages an engine-not-bundled release with no sidecar file (macOS)", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-update-macos-"));
    const artifact = join(root, "Muse-Desktop_1.2.0_aarch64.dmg");
    const manifest = join(root, "release-1.2.0.manifest.json");
    await writeFile(artifact, "dmg-v1.2.0", "utf8");
    const value = buildReleaseManifest({
      artifactPath: artifact,
      version: "1.2.0",
      target: "aarch64-apple-darwin",
    });
    assert.equal(value.sidecar, null);
    await writeFile(manifest, `${JSON.stringify(value)}
`, "utf8");
    const plan = buildReleaseUpdatePlan({
      manifestPath: manifest,
      artifactPath: artifact,
      currentVersion: "1.1.0",
      target: "aarch64-apple-darwin",
    });
    assert.equal(plan.sidecar, null);
    const slotsRoot = join(root, "slots");
    const staged = await stageReleaseUpdate({
      plan,
      artifactPath: artifact,
      stagingRoot: slotsRoot,
    });
    const promoted = await applyStagedRelease({
      stagedPath: staged.path,
      slotsRoot,
    });
    assert.equal(promoted.currentVersion, "1.2.0");
    // The staged slot holds the installer and the plan only — no sidecar file.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(root, "slots", "current"));
    assert.deepEqual(files.sort(), ["READY", "Muse-Desktop_1.2.0_aarch64.dmg", "update-plan.json"].sort());
    // Feeding a sidecar file to a null-sidecar plan is rejected, not ignored.
    assert.throws(
      () => verifyReleaseUpdatePlan({ plan, artifactPath: artifact, sidecarPath: artifact }),
      /declares no sidecar/,
    );
  });

  it("carries and rechecks a signed plan through staging and promotion", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { root, artifact, sidecar, manifest } = await fixture("1.3.0");
    const signed = buildReleaseManifest({
      artifactPath: artifact,
      sidecarPath: sidecar,
      version: "1.3.0",
      target: "x86_64-pc-windows-msvc",
      signingKey: privateKey,
      keyId: "update-test",
    });
    await writeFile(manifest, `${JSON.stringify(signed)}\n`, "utf8");
    const plan = buildReleaseUpdatePlan({
      manifestPath: manifest,
      artifactPath: artifact,
      sidecarPath: sidecar,
      currentVersion: "1.2.0",
      target: "x86_64-pc-windows-msvc",
      publicKey,
      requireSignature: true,
    });
    assert.equal(plan.signature?.keyId, "update-test");
    const slots = join(root, "signed-slots");
    const staged = await stageReleaseUpdate({
      plan,
      artifactPath: artifact,
      sidecarPath: sidecar,
      stagingRoot: slots,
      publicKey,
      requireSignature: true,
    });
    const current = await applyStagedRelease({
      stagedPath: staged.path,
      slotsRoot: slots,
      publicKey,
      requireSignature: true,
    });
    assert.equal(current.currentVersion, "1.3.0");
    const tamperedPlan = { ...plan, signature: { ...plan.signature, value: "A".repeat(120) } };
    await assert.rejects(
      () => stageReleaseUpdate({
        plan: tamperedPlan,
        artifactPath: artifact,
        sidecarPath: sidecar,
        stagingRoot: join(root, "tampered-slots"),
        publicKey,
        requireSignature: true,
      }),
      /signature .* invalid|signature .* could not be verified/,
    );
  });
});
