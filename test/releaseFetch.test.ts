import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { fetchReleaseAsset } from "../scripts/release-fetch.mjs";

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseFor(bytes: Buffer, { status = 200, chunks = [bytes] } = {}) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(bytes.length) }),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

describe("release asset fetch", () => {
  it("fetches an HTTPS asset, verifies it, and publishes it atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-fetch-"));
    const output = join(root, "Muse-Desktop.exe");
    const bytes = Buffer.from("verified-release");
    const result = await fetchReleaseAsset({
      url: "https://cdn.example.test/Muse-Desktop.exe",
      expectedBytes: bytes.length,
      expectedSha256: digest(bytes),
      outputPath: output,
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://cdn.example.test/Muse-Desktop.exe");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        return responseFor(bytes, { chunks: [bytes.subarray(0, 4), bytes.subarray(4)] });
      },
    });
    assert.deepEqual(result, { path: output, bytes: bytes.length, sha256: digest(bytes), url: "https://cdn.example.test/Muse-Desktop.exe" });
    assert.deepEqual(await readFile(output), bytes);
  });

  it("rejects insecure URLs, redirects, and digest mismatches without output", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-fetch-"));
    const output = join(root, "asset.bin");
    const bytes = Buffer.from("release");
    await assert.rejects(() => fetchReleaseAsset({
      url: "http://cdn.example.test/asset.bin",
      expectedBytes: bytes.length,
      expectedSha256: digest(bytes),
      outputPath: output,
      fetchImpl: async () => responseFor(bytes),
    }), /HTTPS/);
    await assert.rejects(() => fetchReleaseAsset({
      url: "https://cdn.example.test/asset.bin",
      expectedBytes: bytes.length,
      expectedSha256: digest(bytes),
      outputPath: output,
      fetchImpl: async () => responseFor(bytes, { status: 302 }),
    }), /HTTP 302/);
    await assert.rejects(() => fetchReleaseAsset({
      url: "https://cdn.example.test/asset.bin",
      expectedBytes: bytes.length,
      expectedSha256: "0".repeat(64),
      outputPath: output,
      fetchImpl: async () => responseFor(bytes),
    }), /SHA-256/);
    await assert.rejects(() => readFile(output), /ENOENT/);
  });

  it("bounds a body even when the server omits Content-Length", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-release-fetch-"));
    const output = join(root, "asset.bin");
    const bytes = Buffer.from("too-large");
    const response = responseFor(bytes);
    response.headers = new Headers();
    await assert.rejects(() => fetchReleaseAsset({
      url: "https://cdn.example.test/asset.bin",
      expectedBytes: bytes.length,
      expectedSha256: digest(bytes),
      outputPath: output,
      maxBytes: 4,
      fetchImpl: async () => response,
    }), /size limit/);
    await assert.rejects(() => readFile(output), /ENOENT/);
  });
});