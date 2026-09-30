import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  SHARE_DURATION_MAX_HOURS,
  SHARE_DURATION_MIN_HOURS,
  buildPublishRequest,
  buildRevokeRequest,
  bundleUrl,
  parsePublishResponse,
  validateShareEndpoint,
} from "../src/lib/sharePublish.ts";
import type { ShareBundle } from "../src/lib/sharing.ts";

const NOW = 1_790_000_000_000;

function bundle(overrides: Partial<ShareBundle> = {}): ShareBundle {
  return {
    bundleId: "share-ab12cd",
    sessionId: "sess-1",
    title: "Thread",
    format: "markdown",
    createdAt: NOW,
    revoked: false,
    body: "# Thread\n\nhello",
    ...overrides,
  };
}

// A running reference server, for the end-to-end half. Spawned once, on an
// ephemeral port, with a known token — the same binary the user would run.
let serverProcess: ReturnType<typeof spawn> | null = null;
let baseUrl = "";
const TOKEN = "test-token-123";

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ["scripts/share-server.mjs", "--port", "0"], {
      env: { ...process.env, SHARE_TOKEN: TOKEN, SHARE_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const port = /listening on :(\d+)/.exec(out)?.[1];
      if (port) {
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      }
    };
    serverProcess.stdout?.on("data", onData);
    serverProcess.stderr?.on("data", onData);
    serverProcess.on("exit", (code) => reject(new Error(`share server exited early (${code}): ${out}`)));
  });
}

describe("share publishing (M4-06, pure half)", () => {
  it("validates endpoints from untrusted input", () => {
    assert.ok(validateShareEndpoint({ baseUrl: "http://192.168.1.20:8787", token: "t" }));
    assert.ok(validateShareEndpoint({ baseUrl: "https://share.example.com/" }));
    assert.equal(validateShareEndpoint({ baseUrl: "ftp://x" }), null);
    assert.equal(validateShareEndpoint({ baseUrl: "http://user:pw@host" }), null);
    assert.equal(validateShareEndpoint({ baseUrl: "http://host/?q=1" }), null);
    assert.equal(validateShareEndpoint({ baseUrl: "not a url" }), null);
    assert.equal(validateShareEndpoint({ baseUrl: "http://h", token: "bad\n" }), null);
    assert.equal(validateShareEndpoint("http://h"), null);
  });

  it("builds publish requests with a bounded duration", () => {
    const endpoint = validateShareEndpoint({ baseUrl: "http://192.168.1.20:8787", token: "t" });
    assert.ok(endpoint);
    const req = buildPublishRequest(endpoint, bundle(), 24, NOW);
    assert.ok(req);
    assert.equal(req.method, "PUT");
    assert.equal(req.url, "http://192.168.1.20:8787/muse-share/share-ab12cd");
    assert.equal(req.headers.authorization, "Bearer t");
    const body = JSON.parse(req.body);
    assert.equal(body.expiresAt, NOW + 24 * 3_600_000);
    assert.equal(body.bundle.bundleId, "share-ab12cd");
    // out-of-bounds durations and oversized bodies are refused, not clamped
    assert.equal(buildPublishRequest(endpoint, bundle(), SHARE_DURATION_MIN_HOURS - 1, NOW), null);
    assert.equal(buildPublishRequest(endpoint, bundle(), SHARE_DURATION_MAX_HOURS + 1, NOW), null);
    assert.equal(buildPublishRequest(endpoint, bundle({ body: "x".repeat(240 * 1024) }), 24, NOW), null);
    assert.equal(buildPublishRequest(endpoint, bundle({ bundleId: "nope" }), 24, NOW), null);
  });

  it("never announces a URL before the server's 201", () => {
    assert.equal(parsePublishResponse(404, "{}"), null);
    assert.equal(parsePublishResponse(201, "not json"), null);
    assert.equal(parsePublishResponse(201, "{}"), null);
    assert.equal(parsePublishResponse(201, JSON.stringify({ url: "not-http" })), null);
    assert.deepEqual(parsePublishResponse(201, JSON.stringify({ url: "http://lan:8787/muse-share/share-ab12cd" })), {
      url: "http://lan:8787/muse-share/share-ab12cd",
    });
    const endpoint = validateShareEndpoint({ baseUrl: "http://h:1" });
    assert.ok(endpoint);
    assert.equal(bundleUrl(endpoint, "share-x"), null, "an id that cannot be a URL is refused");
  });

  it("builds the revoke request deny-only", () => {
    const endpoint = validateShareEndpoint({ baseUrl: "http://h:1", token: "t" });
    assert.ok(endpoint);
    const req = buildRevokeRequest(endpoint, "share-ab12cd");
    assert.ok(req);
    assert.equal(req.method, "DELETE");
    assert.equal(req.body, undefined);
  });
});

describe("share publishing (M4-06, the reference server over real HTTP)", () => {
  before(async () => {
    await startServer();
  });
  after(() => {
    serverProcess?.kill();
  });

  const request = async (method: string, path: string, body?: string, token?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    return { status: res.status, text };
  };

  it("publishes with the token, reads without any token", async () => {
    const endpoint = validateShareEndpoint({ baseUrl, token: TOKEN });
    assert.ok(endpoint);
    const req = buildPublishRequest(endpoint, bundle(), 24, Date.now());
    assert.ok(req);
    const wrongToken = await request("PUT", "/muse-share/share-ab12cd", req.body, "wrong");
    assert.equal(wrongToken.status, 403, "a wrong token cannot publish");
    const published = await request("PUT", "/muse-share/share-ab12cd", req.body, TOKEN);
    assert.equal(published.status, 201);
    assert.deepEqual(parsePublishResponse(201, published.text), { url: `${baseUrl}/muse-share/share-ab12cd` });

    // a second client needs nothing but the URL
    const reader = await request("GET", "/muse-share/share-ab12cd");
    assert.equal(reader.status, 200);
    assert.equal(JSON.parse(reader.text).bundle.title, "Thread");
  });

  it("refuses an incomplete export and an oversized body", async () => {
    const bad = await request("PUT", "/muse-share/share-ee11ee", JSON.stringify({ bundle: { bundleId: "share-ee11ee" } }), TOKEN);
    assert.equal(bad.status, 400, "an incomplete export is refused");
    const big = await request("PUT", "/muse-share/share-ee11ee", JSON.stringify({ bundle: bundle({ bundleId: "share-ee11ee", body: "x".repeat(240 * 1024 + 1) }), expiresAt: Date.now() + 3_600_000 }), TOKEN);
    assert.equal(big.status, 413, "an oversized body is refused");
    assert.equal((await request("GET", "/muse-share/share-ee11ee")).status, 404, "nothing was published");
  });

  it("makes revocation observable from any client", async () => {
    const endpoint = validateShareEndpoint({ baseUrl, token: TOKEN });
    assert.ok(endpoint);
    const publish = buildPublishRequest(endpoint, bundle({ bundleId: "share-ff22ff" }), 24, Date.now());
    assert.ok(publish);
    assert.equal((await request("PUT", "/muse-share/share-ff22ff", publish.body, TOKEN)).status, 201);
    assert.equal((await request("GET", "/muse-share/share-ff22ff")).status, 200);

    const revoke = buildRevokeRequest(endpoint, "share-ff22ff");
    assert.ok(revoke);
    assert.equal((await request("DELETE", "/muse-share/share-ff22ff", undefined, TOKEN)).status, 204);
    // the same 404 a reader sees, with or without the token
    assert.equal((await request("GET", "/muse-share/share-ff22ff")).status, 404);
    assert.equal((await request("GET", "/muse-share/share-ff22ff", undefined, TOKEN)).status, 404);
    assert.equal((await request("GET", "/muse-share/share-never")).status, 404);
  });

  it("expires a bundle by its declared duration", async () => {
    const endpoint = validateShareEndpoint({ baseUrl, token: TOKEN });
    assert.ok(endpoint);
    const publish = buildPublishRequest(endpoint, bundle({ bundleId: "share-aa33aa" }), 24, Date.now());
    assert.ok(publish);
    // publish with an already-past expiry: the server must 404 it on read
    const expired = JSON.parse(publish.body);
    expired.expiresAt = Date.now() - 1_000;
    assert.equal((await request("PUT", "/muse-share/share-aa33aa", JSON.stringify(expired), TOKEN)).status, 201);
    assert.equal((await request("GET", "/muse-share/share-aa33aa")).status, 404, "an expired bundle reads as gone");
  });
});
