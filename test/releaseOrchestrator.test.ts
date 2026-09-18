import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { buildReleaseChannelIndex } from "../scripts/release-channel.mjs";
import { signReleaseManifest } from "../scripts/release-manifest.mjs";
import { fetchReleaseChannel, orchestrateReleaseUpdate } from "../scripts/release-orchestrator.mjs";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseFor(bytes: Buffer) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes.length) }),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= bytes.length) return { done: true, value: undefined };
            const next = bytes.subarray(index, Math.min(index + 4, bytes.length));
            index += next.length;
            return { done: false, value: next };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

describe("release orchestrator", () => {
  it("verifies a signed channel, fetches both assets, and stages a candidate", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const installerBytes = Buffer.from("installer-v2");
    const sidecarBytes = Buffer.from("sidecar-v2");
    const installerUrl = "https://cdn.example.test/Muse-Desktop-2.0.0.exe";
    const sidecarUrl = "https://cdn.example.test/muse-x64.exe";
    const manifest = signReleaseManifest({
      schema: "muse-desktop.release-manifest.v1",
      product: "Muse-Desktop",
      version: "2.0.0",
      target: "x86_64-pc-windows-msvc",
      installer: { file: "Muse-Desktop-2.0.0.exe", bytes: installerBytes.length, sha256: digest(installerBytes) },
      sidecar: { file: "muse-x64.exe", bytes: sidecarBytes.length, sha256: digest(sidecarBytes) },
    }, { privateKey, keyId: "release-test" });
    const index = buildReleaseChannelIndex({
      channel: "stable",
      releases: [{
        version: "2.0.0",
        target: "x86_64-pc-windows-msvc",
        manifest,
        assets: {
          installer: { url: installerUrl, bytes: installerBytes.length, sha256: digest(installerBytes) },
          sidecar: { url: sidecarUrl, bytes: sidecarBytes.length, sha256: digest(sidecarBytes) },
        },
      }],
      signingKey: privateKey,
      keyId: "release-test",
    });
    const root = await mkdtemp(join(tmpdir(), "muse-release-orchestrator-"));
    const seen: string[] = [];
    const result = await orchestrateReleaseUpdate({
      index,
      target: "x86_64-pc-windows-msvc",
      currentVersion: "1.0.0",
      cacheDir: join(root, "cache"),
      stagingRoot: join(root, "slots"),
      publicKey,
      requireSignature: true,
      fetchImpl: async (url, options) => {
        seen.push(url);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        return responseFor(url === installerUrl ? installerBytes : sidecarBytes);
      },
    });
    assert.equal(result.status, "staged");
    assert.equal(result.version, "2.0.0");
    assert.deepEqual(seen, [installerUrl, sidecarUrl]);
    assert.equal(await readFile(join(result.stagedPath, "Muse-Desktop-2.0.0.exe"), "utf8"), "installer-v2");
    assert.equal(await readFile(join(result.stagedPath, "muse-x64.exe"), "utf8"), "sidecar-v2");
    assert.equal(JSON.parse(await readFile(join(result.stagedPath, "update-plan.json"), "utf8")).candidateVersion, "2.0.0");

    const current = await orchestrateReleaseUpdate({
      index,
      target: "x86_64-pc-windows-msvc",
      currentVersion: "2.0.0",
      publicKey,
      requireSignature: true,
    });
    assert.deepEqual(current, {
      status: "up-to-date",
      channel: "stable",
      currentVersion: "2.0.0",
      target: "x86_64-pc-windows-msvc",
    });
  });

  it("loads a channel over HTTPS with a bounded body and rejects redirects", async () => {
    const payload = Buffer.from('{"schema":"muse-desktop.release-channel.v1"}');
    const result = await fetchReleaseChannel({
      url: "https://updates.example.test/stable.json",
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://updates.example.test/stable.json");
        assert.equal(options.redirect, "error");
        return responseFor(payload);
      },
    });
    assert.equal(result.schema, "muse-desktop.release-channel.v1");
    await assert.rejects(() => fetchReleaseChannel({
      url: "http://updates.example.test/stable.json",
      fetchImpl: async () => responseFor(payload),
    }), /HTTPS/);
    await assert.rejects(() => fetchReleaseChannel({
      url: "https://updates.example.test/stable.json",
      fetchImpl: async () => ({ ok: false, status: 302 }),
    }), /HTTP 302/);
  });
});