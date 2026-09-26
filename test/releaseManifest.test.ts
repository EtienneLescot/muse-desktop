import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReleaseManifest,
  RELEASE_MANIFEST_SCHEMA,
} from "../scripts/release-manifest.mjs";
import { verifyReleaseManifest } from "../scripts/verify-release-manifest.mjs";

test("release manifest records deterministic hashes without machine paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-release-"));
  const installer = join(root, "Muse-Desktop_0.1.0_x64-setup.exe");
  const sidecar = join(root, "muse-x86_64-pc-windows-msvc.exe");
  await writeFile(installer, Buffer.from("installer-bytes"));
  await writeFile(sidecar, Buffer.from("sidecar-bytes"));
  const manifest = buildReleaseManifest({
    artifactPath: installer,
    sidecarPath: sidecar,
    version: "0.1.0",
    target: "x86_64-pc-windows-msvc",
  });
  assert.equal(manifest.schema, RELEASE_MANIFEST_SCHEMA);
  assert.equal(manifest.installer.file, "Muse-Desktop_0.1.0_x64-setup.exe");
  assert.equal(manifest.installer.bytes, 15);
  assert.match(manifest.installer.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sidecar.bytes, 13);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const output = join(root, "manifest.json");
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), manifest);
});

test("release manifest rejects missing metadata", () => {
  assert.throws(
    () => buildReleaseManifest({ artifactPath: "", sidecarPath: "x", version: "1", target: "t" }),
    /artifactPath is required/,
  );
});

test("a Windows release manifest requires the engine sidecar digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-release-win-"));
  const installer = join(root, "Muse-Desktop_0.1.0_x64-setup.exe");
  await writeFile(installer, Buffer.from("installer-bytes"));
  // A Windows target without sidecarPath would stage an engine-less install.
  assert.throws(
    () => buildReleaseManifest({
      artifactPath: installer,
      version: "0.1.0",
      target: "x86_64-pc-windows-msvc",
    }),
    /sidecarPath is required for Windows target/,
  );
  assert.throws(
    () => buildReleaseManifest({
      artifactPath: installer,
      version: "0.1.0",
      target: "aarch64-pc-windows-msvc",
    }),
    /sidecarPath is required for Windows target/,
  );
  // Non-Windows targets keep the engine-not-bundled behaviour.
  const macOS = buildReleaseManifest({
    artifactPath: installer,
    version: "0.1.0",
    target: "aarch64-apple-darwin",
  });
  assert.equal(macOS.sidecar, null);
});

test("release manifest without a bundled engine carries a null sidecar (macOS)", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-release-macos-"));
  const installer = join(root, "Muse-Desktop_0.1.0_aarch64.dmg");
  await writeFile(installer, Buffer.from("dmg-bytes"));
  const manifest = buildReleaseManifest({
    artifactPath: installer,
    version: "0.1.0",
    target: "aarch64-apple-darwin",
  });
  assert.equal(manifest.sidecar, null);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const manifestPath = join(root, "release.manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const valid = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    version: "0.1.0",
    target: "aarch64-apple-darwin",
  });
  assert.equal(valid.valid, true);
  // Supplying a sidecar file against a `sidecar: null` manifest is an error,
  // not a silent pass.
  const withSidecar = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    sidecarPath: installer,
  });
  assert.equal(withSidecar.valid, false);
  assert.match(withSidecar.errors.join(" "), /declares no sidecar/);

  // The signature covers the null sidecar deterministically.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = buildReleaseManifest({
    artifactPath: installer,
    version: "0.1.0",
    target: "aarch64-apple-darwin",
    signingKey: privateKey,
    keyId: "release-test",
  });
  await writeFile(manifestPath, `${JSON.stringify(signed)}\n`, "utf8");
  const verified = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    publicKey,
    requireSignature: true,
  });
  assert.equal(verified.valid, true);
});

test("release manifest verification detects tampering and validates explicit files", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-release-verify-"));
  const installer = join(root, "Muse-Desktop_0.1.0_x64-setup.exe");
  const sidecar = join(root, "muse-x86_64-pc-windows-msvc.exe");
  const manifestPath = join(root, "release.manifest.json");
  await writeFile(installer, Buffer.from("installer-bytes"));
  await writeFile(sidecar, Buffer.from("sidecar-bytes"));
  const manifest = buildReleaseManifest({
    artifactPath: installer,
    sidecarPath: sidecar,
    version: "0.1.0",
    target: "x86_64-pc-windows-msvc",
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const valid = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    sidecarPath: sidecar,
    version: "0.1.0",
    target: "x86_64-pc-windows-msvc",
  });
  assert.equal(valid.valid, true);
  await writeFile(installer, Buffer.from("tampered"));
  const invalid = verifyReleaseManifest({ manifestPath, artifactPath: installer, sidecarPath: sidecar });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /installer\.(bytes|sha256) mismatch/);
});

test("release manifest can be verified with an explicit Ed25519 trust key", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-release-signature-"));
  const installer = join(root, "Muse-Desktop_0.1.0_x64-setup.exe");
  const sidecar = join(root, "muse-x86_64-pc-windows-msvc.exe");
  const manifestPath = join(root, "release.manifest.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(installer, Buffer.from("installer-bytes"));
  await writeFile(sidecar, Buffer.from("sidecar-bytes"));
  const manifest = buildReleaseManifest({
    artifactPath: installer,
    sidecarPath: sidecar,
    version: "0.1.0",
    target: "x86_64-pc-windows-msvc",
    signingKey: privateKey,
    keyId: "release-test",
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const valid = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    sidecarPath: sidecar,
    publicKey,
    requireSignature: true,
  });
  assert.equal(valid.valid, true);
  const tampered = { ...manifest, version: "0.1.1" };
  await writeFile(manifestPath, `${JSON.stringify(tampered)}\n`, "utf8");
  const invalid = verifyReleaseManifest({
    manifestPath,
    artifactPath: installer,
    sidecarPath: sidecar,
    publicKey,
    requireSignature: true,
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /signature .* invalid/);
});
