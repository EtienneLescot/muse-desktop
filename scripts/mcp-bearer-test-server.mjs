#!/usr/bin/env node
/**
 * M3-02 bearer proof: a minimal Streamable HTTP MCP server on 127.0.0.1 that
 * requires `Authorization: Bearer <token>`. One harmless tool, `echo_nonce`,
 * answers the nonce with a proof only this process can compute (an HMAC under
 * a key drawn at start), so a reply that quotes it went through the server.
 *
 *   MCP_TEST_ADMIN_KEY=<random> node scripts/mcp-bearer-test-server.mjs
 *     [--port 0] [--log <file.jsonl>]
 *
 * Prints one JSON line on stdout once listening: {"url", "pid"}.
 *
 * Tokens never reach this server in plain text from the harness: it only holds
 * the sha256 of the one token it accepts. Every request is logged (memory and
 * --log) with the Authorization header reduced to `bearer:<sha256/12>`.
 *
 * MCP (2025-06-18) on /mcp only; any other path is logged and answers 404
 * (the proof's "another URL" under the same connector). initialize opens a session
 * (Mcp-Session-Id), notifications answer 202, tools/list, tools/call, ping;
 * GET answers 405 (no server stream), DELETE ends the session. A request with
 * an unknown session id answers 404, as the spec says for an ended session.
 * CORS answers the app's webview origin, including on 401.
 *
 * Two hostile paths, logged like the rest (M3-02 check, 06/10/2026):
 *   /redirect   307 to /mcp: a client that follows carries its bearer there;
 *   /hold       200 text/event-stream, then nothing, the stream left open.
 *
 * Admin (header x-admin-key, never called by the app):
 *   POST /admin/accept {"sha256": "<hex>"}  the token now accepted
 *   POST /admin/expire                      the accepted token now answers 401 (expired)
 *   POST /admin/drop-sessions               every MCP session ends (next use: 404)
 *   POST /admin/delay {"ms": <n>}           every /mcp answer waits n ms (0: none)
 *   GET  /admin/log                         the request log
 *   POST /admin/stop                        exit
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(flag("--port", "0"));
const LOG_FILE = flag("--log", "");
const ADMIN_KEY = process.env.MCP_TEST_ADMIN_KEY ?? "";
if (ADMIN_KEY.length < 16) {
  console.error("MCP_TEST_ADMIN_KEY (16+ characters) is required");
  process.exit(2);
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROOF_KEY = randomBytes(32);
const BODY_LIMIT = 1 << 20;
const short = (sha256hex) => sha256hex.slice(0, 12);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let accepted = null; // sha256 hex of the one valid token
let delayMs = 0;
const expired = new Set();
const sessions = new Set();
const log = [];
const started = Date.now();

function record(entry) {
  const row = { seq: log.length + 1, atMs: Date.now() - started, ...entry };
  log.push(row);
  if (LOG_FILE) appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
}

const TOOL = {
  name: "echo_nonce",
  description: "Echo a nonce back with this server's proof that it ran (M3-02 test server).",
  inputSchema: {
    type: "object",
    properties: { nonce: { type: "string", description: "Any short text to echo back" } },
    required: ["nonce"],
  },
};

function cors(req) {
  const origin = req.headers.origin;
  return {
    "access-control-allow-origin": typeof origin === "string" ? origin : "*",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function send(res, req, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...cors(req), ...(text ? { "content-type": "application/json" } : {}), ...headers });
  res.end(text);
}

/** `none`, `malformed` or `bearer:<sha256/12>`, and the token's state. */
function authOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return { auth: "none", state: null, hash: null };
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return { auth: "malformed", state: null, hash: null };
  const hash = sha256(match[1]);
  const state = hash === accepted ? "current" : expired.has(hash) ? "expired" : "unknown";
  return { auth: `bearer:${short(hash)}`, state, hash };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) reject(new Error("body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function rpcResult(frame, session) {
  const params = frame.params ?? {};
  switch (frame.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "m3-02-bearer-test", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      if (params.name !== TOOL.name) return { content: [{ type: "text", text: `unknown tool ${String(params.name)}` }], isError: true };
      const nonce = String(params.arguments?.nonce ?? "").slice(0, 200);
      const proof = createHmac("sha256", PROOF_KEY).update(nonce).digest("hex").slice(0, 10);
      session.answer = { nonce, proof };
      return { content: [{ type: "text", text: `echo_nonce: nonce=${nonce} proof=${proof}` }], isError: false };
    }
    default:
      return null;
  }
}

async function handleMcp(req, res, path) {
  const auth = authOf(req);
  const base = {
    kind: "mcp",
    http: req.method,
    path,
    auth: auth.auth,
    token: auth.state,
    origin: req.headers.origin ?? null,
    ua: String(req.headers["user-agent"] ?? "").slice(0, 60) || null,
  };
  let frame = null;
  if (req.method === "POST") {
    try {
      frame = JSON.parse(await readBody(req));
    } catch {
      record({ ...base, status: 400, error: "invalid JSON" });
      return send(res, req, 400, { error: "invalid JSON" });
    }
  }
  const rpc = frame && !Array.isArray(frame) ? { rpc: frame.method ?? null, rpcId: frame.id ?? null } : { rpc: Array.isArray(frame) ? "<batch>" : null };
  if (path === "/redirect") {
    record({ ...base, ...rpc, status: 307 });
    return send(res, req, 307, undefined, { location: `http://${req.headers.host}/mcp` });
  }
  if (path === "/hold") {
    record({ ...base, ...rpc, status: 200, held: true });
    res.writeHead(200, { ...cors(req), "content-type": "text/event-stream" });
    res.flushHeaders();
    return undefined;
  }
  if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  if (path !== "/mcp") {
    // Another URL than the one the connector was registered with: whatever
    // reaches it is logged (which bearer?), nothing is served.
    record({ ...base, ...rpc, status: 404 });
    return send(res, req, 404, { error: "no MCP endpoint here" });
  }
  if (auth.state !== "current") {
    const description = auth.state === "expired" ? "the access token expired" : auth.auth === "none" ? null : "unknown access token";
    record({ ...base, ...rpc, status: 401 });
    return send(res, req, 401, { error: "invalid_token", ...(description ? { error_description: description } : {}) }, {
      "www-authenticate": description ? `Bearer realm="m3-02", error="invalid_token", error_description="${description}"` : 'Bearer realm="m3-02"',
    });
  }
  const sessionId = req.headers["mcp-session-id"];
  if (req.method === "GET") {
    record({ ...base, status: 405 });
    return send(res, req, 405, undefined, { allow: "POST, DELETE, OPTIONS" });
  }
  if (req.method === "DELETE") {
    const known = typeof sessionId === "string" && sessions.delete(sessionId);
    record({ ...base, session: known ? "ended" : "unknown", status: known ? 200 : 404 });
    return send(res, req, known ? 200 : 404);
  }
  if (req.method !== "POST" || Array.isArray(frame) || typeof frame !== "object" || frame === null) {
    record({ ...base, ...rpc, status: 400, error: "one JSON-RPC message per POST" });
    return send(res, req, 400, { error: "one JSON-RPC message per POST" });
  }
  if (frame.method === "initialize") {
    const id = randomUUID();
    sessions.add(id);
    record({ ...base, ...rpc, session: "created", status: 200 });
    return send(res, req, 200, { jsonrpc: "2.0", id: frame.id, result: rpcResult(frame, {}) }, { "mcp-session-id": id });
  }
  if (typeof sessionId !== "string") {
    record({ ...base, ...rpc, session: "none", status: 400 });
    return send(res, req, 400, { error: "Mcp-Session-Id required" });
  }
  if (!sessions.has(sessionId)) {
    record({ ...base, ...rpc, session: "unknown", status: 404 });
    return send(res, req, 404, { error: "session not found" });
  }
  if (frame.id === undefined) {
    record({ ...base, ...rpc, session: "known", status: 202 });
    return send(res, req, 202);
  }
  const call = {};
  const result = rpcResult(frame, call);
  const tool = frame.method === "tools/call" ? { tool: frame.params?.name ?? null, ...(call.answer ?? {}) } : {};
  record({ ...base, ...rpc, ...tool, session: "known", status: 200 });
  return send(res, req, 200, result === null
    ? { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `method not found: ${frame.method}` } }
    : { jsonrpc: "2.0", id: frame.id, result });
}

async function handleAdmin(req, res, path) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return send(res, req, 403, { error: "admin key required" });
  if (req.method === "GET" && path === "/admin/log") return send(res, req, 200, log);
  if (req.method !== "POST") return send(res, req, 405);
  if (path === "/admin/accept") {
    let hash = "";
    try { hash = String(JSON.parse(await readBody(req)).sha256 ?? "").toLowerCase(); } catch { /* checked below */ }
    if (!/^[0-9a-f]{64}$/.test(hash)) return send(res, req, 400, { error: "sha256 hex required" });
    accepted = hash;
    expired.delete(hash);
    record({ kind: "admin", action: "accept", token: short(hash) });
    return send(res, req, 200, { accepted: short(hash) });
  }
  if (path === "/admin/expire") {
    if (accepted) expired.add(accepted);
    record({ kind: "admin", action: "expire", token: accepted ? short(accepted) : null });
    accepted = null;
    return send(res, req, 200, { expired: [...expired].map(short) });
  }
  if (path === "/admin/delay") {
    let ms = NaN;
    try { ms = Number(JSON.parse(await readBody(req)).ms); } catch { /* checked below */ }
    if (!Number.isInteger(ms) || ms < 0 || ms > 120_000) return send(res, req, 400, { error: "ms: 0..120000 required" });
    delayMs = ms;
    record({ kind: "admin", action: "delay", ms });
    return send(res, req, 200, { delayMs });
  }
  if (path === "/admin/drop-sessions") {
    const count = sessions.size;
    sessions.clear();
    record({ kind: "admin", action: "drop-sessions", count });
    return send(res, req, 200, { dropped: count });
  }
  if (path === "/admin/stop") {
    record({ kind: "admin", action: "stop" });
    send(res, req, 200, { stopping: true });
    server.close();
    setTimeout(() => process.exit(0), 100).unref();
    return undefined;
  }
  return send(res, req, 404);
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "OPTIONS") {
    record({ kind: "preflight", path, origin: req.headers.origin ?? null, privateNetwork: req.headers["access-control-request-private-network"] === "true" });
    res.writeHead(204, { ...cors(req), "access-control-allow-private-network": "true" });
    return res.end();
  }
  const handler = path.startsWith("/admin/") ? handleAdmin : handleMcp;
  handler(req, res, path).catch((error) => {
    record({ kind: "error", path, error: String(error?.message ?? error).slice(0, 200) });
    if (!res.headersSent) send(res, req, 500, { error: "internal error" });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, pid: process.pid }));
});
