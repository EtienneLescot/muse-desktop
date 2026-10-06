/**
 * scripts/mcp-bearer-test-server.mjs, the M3-02 native proof's server: it
 * accepts one token by hash, answers 401 once that token is expired, 404 for
 * an ended MCP session, and never logs a token. The app's own transport
 * (remoteMcp.ts, through the test-mode loopback allowance) is the client.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { allowTestRemoteMcpOrigin } from "../src/lib/connectors.ts";
import { callRemoteMcp, probeRemoteMcp } from "../src/lib/remoteMcp.ts";

const ADMIN = randomBytes(16).toString("hex");
const TOKEN = `dummy-${randomBytes(18).toString("base64url")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let server: ChildProcess | null = null;
let url = "";

async function admin(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, url), {
    method: body === undefined && path === "/admin/log" ? "GET" : "POST",
    headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

describe("M3-02 bearer test server", () => {
  before(async () => {
    server = spawn(process.execPath, ["scripts/mcp-bearer-test-server.mjs", "--port", "0"], {
      env: { ...process.env, MCP_TEST_ADMIN_KEY: ADMIN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server!.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").find((l) => l.startsWith("{"));
        if (line) resolve(JSON.parse(line).url);
      });
      server!.on("exit", (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    });
    allowTestRemoteMcpOrigin(new URL(url).origin);
  });

  after(() => {
    allowTestRemoteMcpOrigin(null);
    server?.kill();
  });

  it("refuses a missing or unknown bearer, then serves the accepted one", async () => {
    await assert.rejects(() => probeRemoteMcp(url, ""), /authentication was rejected or expired/);
    await assert.rejects(() => probeRemoteMcp(url, TOKEN), /authentication was rejected or expired/);
    await admin("/admin/accept", { sha256: sha(TOKEN) });
    const probe = await probeRemoteMcp(url, TOKEN);
    assert.equal(probe.serverName, "m3-02-bearer-test");
    assert.deepEqual(probe.tools.map((tool) => tool.name), ["echo_nonce"]);
    const session = { url, token: TOKEN, sessionId: probe.sessionId, protocolVersion: probe.protocolVersion, nextRequestId: 3 };
    const call = await callRemoteMcp(session, "echo_nonce", { nonce: "n-1" });
    const text = (call.result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /^echo_nonce: nonce=n-1 proof=[0-9a-f]{10}$/);

    await admin("/admin/drop-sessions", {});
    await assert.rejects(() => callRemoteMcp(session, "echo_nonce", { nonce: "n-2" }), /session expired/);
    await admin("/admin/expire", {});
    await assert.rejects(() => probeRemoteMcp(url, TOKEN), /authentication was rejected or expired/);
  });

  it("logs the bearer as a short hash, never the token", async () => {
    const log = await admin("/admin/log") as Array<Record<string, unknown>>;
    const text = JSON.stringify(log);
    assert.equal(text.includes(TOKEN), false);
    const bearer = `bearer:${sha(TOKEN).slice(0, 12)}`;
    const states = log.filter((row) => row.auth === bearer).map((row) => `${row.rpc}:${row.token}:${row.status}`);
    assert.deepEqual(states, [
      "initialize:unknown:401",
      "initialize:current:200",
      "notifications/initialized:current:202",
      "tools/list:current:200",
      "tools/call:current:200",
      "tools/call:current:404",
      "initialize:expired:401",
    ]);
    assert.equal(log.find((row) => row.rpc === "tools/call" && row.status === 200)?.nonce, "n-1");
    assert.equal(log.find((row) => row.auth === "none")?.status, 401);
  });
});
