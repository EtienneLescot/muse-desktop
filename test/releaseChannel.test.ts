import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildReleaseChannelIndex,
  releaseChannelPayload,
  selectRelease,
  verifyReleaseChannelIndex,
} from "../scripts/release-channel.mjs";

function manifest(version: string, target = "x86_64-pc-windows-msvc") {
  return {
    schema: "muse-desktop.release-manifest.v1",
    product: "Muse-Desktop",
    version,
    target,
    installer: { file: `Muse-${version}.exe`, bytes: 100, sha256: "a".repeat(64) },
    sidecar: { file: "muse.exe", bytes: 200, sha256: "b".repeat(64) },
  };
}

describe("release channel index", () => {
  it("sorts releases deterministically and selects the newest compatible target", () => {
    const index = buildReleaseChannelIndex({
      channel: "stable",
      releases: [
        { version: "1.1.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.1.0") },
        { version: "1.3.0-beta.1", target: "x86_64-pc-windows-msvc", manifest: manifest("1.3.0-beta.1"), assets: { installer: { url: "https://cdn.example.test/muse-1.3.exe" } } },
        { version: "1.2.0", target: "aarch64-apple-darwin", manifest: manifest("1.2.0", "aarch64-apple-darwin") },
        { version: "1.2.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.2.0") },
      ],
    });
    assert.deepEqual(index.releases.map((release) => release.version), ["1.3.0-beta.1", "1.2.0", "1.2.0", "1.1.0"]);
    assert.equal(selectRelease(index, { target: "x86_64-pc-windows-msvc", currentVersion: "1.1.0" })?.version, "1.2.0");
    assert.equal(selectRelease(index, { target: "x86_64-pc-windows-msvc", currentVersion: "1.2.0", allowPrerelease: true })?.version, "1.3.0-beta.1");
    assert.equal(selectRelease(index, { target: "x86_64-pc-windows-msvc", currentVersion: "1.3.0" }), null);
  });

  it("signs and verifies a path-free channel index", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const index = buildReleaseChannelIndex({
      channel: "stable",
      releases: [{ version: "1.2.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.2.0") }],
      signingKey: privateKey,
      keyId: "release-test",
    });
    assert.equal(releaseChannelPayload(index).includes("C:"), false);
    const verified = verifyReleaseChannelIndex(index, { publicKey, requireSignature: true });
    assert.equal(verified.signature?.keyId, "release-test");
    const tampered = { ...index, channel: "beta" };
    assert.throws(() => verifyReleaseChannelIndex(tampered, { publicKey, requireSignature: true }), /could not be verified/);
  });

  it("rejects unsafe assets and duplicate version-target pairs", () => {
    assert.throws(() => buildReleaseChannelIndex({
      releases: [
        { version: "1.0.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.0.0"), assets: { installer: { url: "http://cdn.example.test/muse.exe" } } },
      ],
    }), /HTTPS URL/);
    assert.throws(() => buildReleaseChannelIndex({
      releases: [
        { version: "1.0.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.0.0") },
        { version: "1.0.0", target: "x86_64-pc-windows-msvc", manifest: manifest("1.0.0") },
      ],
    }), /duplicate/);
  });
});