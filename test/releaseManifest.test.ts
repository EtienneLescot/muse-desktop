import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    /artifactPath and sidecarPath are required/,
  );
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
