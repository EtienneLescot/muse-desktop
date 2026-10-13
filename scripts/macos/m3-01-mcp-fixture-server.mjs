#!/usr/bin/env node
/**
 * Local stdio MCP server for the macOS M3-01 / M3-03 proofs. Newline JSON-RPC
 * (MCP stdio), or Content-Length frames when the client opens with them; it
 * answers in the framing it received.
 *
 *   node m3-01-mcp-fixture-server.mjs --state <dir> [--name g6-fixture] [--version 1.0.0]
 *
 * Tools:
 *   g6_echo {nonce}   answers `nonce=<n> proof=<p> pid=<pid>`, where proof is an
 *                     HMAC of the nonce under a key drawn by this process (kept in
 *                     <state>/keys/<pid>): a reply that quotes it went through here.
 *   g6_slow {ms}      waits ms (bounded to 60 s), then answers.
 *   g6_crash {}       exits the process without answering (a server failure).
 *   g6_added {}       listed only once <state>/tools-v2 exists.
 *
 * The server checks <state>/tools-v2 every 300 ms; when it appears, it sends
 * notifications/tools/list_changed once. Every request is appended to
 * <state>/log.jsonl with this pid and the parent's command name, so the proof
 * tells the app's probe, the app's persistent process and the engine apart.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STATE = flag("--state", null);
const NAME = flag("--name", "g6-fixture");
const VERSION = flag("--version", "1.0.0");
if (!STATE) {
  process.stderr.write("--state <dir> is required\n");
  process.exit(2);
}
mkdirSync(join(STATE, "keys"), { recursive: true });
const KEY = randomBytes(16);
writeFileSync(join(STATE, "keys", String(process.pid)), KEY.toString("hex"));
let parent = null;
try { parent = execFileSync("ps", ["-o", "comm=", "-p", String(process.ppid)], { encoding: "utf8" }).trim().split("/").pop(); } catch { parent = null; }
const log = (entry) => appendFileSync(join(STATE, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, parent, server: `${NAME}@${VERSION}`, ...entry })}\n`);
log({ event: "start", cwd: process.cwd() });

const TOOLS = [
  { name: "g6_echo", description: "Echo a nonce back with this server's proof (M3-01 fixture).", inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] } },
  { name: "g6_slow", description: "Wait the given milliseconds, then answer (M3-01 fixture).", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "g6_crash", description: "Exit without answering (M3-01 fixture failure).", inputSchema: { type: "object", properties: {} } },
];
const ADDED = { name: "g6_added", description: "Listed after the catalogue changed (M3-01 fixture).", inputSchema: { type: "object", properties: {} } };
const v2 = () => existsSync(join(STATE, "tools-v2"));
const tools = () => (v2() ? [...TOOLS, ADDED] : TOOLS);

let framing = null; // "lines" | "frames"
let buffer = Buffer.alloc(0);
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (framing === "frames") process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  else process.stdout.write(`${body.toString("utf8")}\n`);
};

async function handle(message) {
  if (message.id === undefined) {
    log({ event: "notification", method: message.method ?? null });
    return;
  }
  log({ event: "request", method: message.method ?? null, tool: message.params?.name ?? null, framing });
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: NAME, version: VERSION } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools() });
    case "tools/call": {
      const name = message.params?.name;
      const input = message.params?.arguments ?? {};
      if (name === "g6_echo") {
        const nonce = String(input.nonce ?? "").slice(0, 200);
        const proof = createHmac("sha256", KEY).update(nonce).digest("hex").slice(0, 10);
        log({ event: "call", tool: name, nonce, proof });
        return reply({ content: [{ type: "text", text: `g6_echo: nonce=${nonce} proof=${proof} pid=${process.pid}` }], isError: false });
      }
      if (name === "g6_slow") {
        const ms = Math.max(0, Math.min(60_000, Number(input.ms) || 0));
        log({ event: "call", tool: name, ms });
        await new Promise((done) => setTimeout(done, ms));
        log({ event: "call-done", tool: name, ms });
        return reply({ content: [{ type: "text", text: `g6_slow: waited ${ms} ms` }], isError: false });
      }
      if (name === "g6_crash") {
        log({ event: "call", tool: name });
        process.exit(3);
      }
      if (name === "g6_added" && v2()) {
        log({ event: "call", tool: name });
        return reply({ content: [{ type: "text", text: "g6_added: ok" }], isError: false });
      }
      return reply({ content: [{ type: "text", text: `unknown tool ${String(name)}` }], isError: true });
    }
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (framing === null) {
      const head = buffer.toString("utf8", 0, Math.min(buffer.length, 16));
      if (head.length === 0) return;
      framing = /^content-length/i.test(head) ? "frames" : "lines";
    }
    if (framing === "frames") {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number((buffer.slice(0, end).toString("utf8").match(/Content-Length:\s*(\d+)/i) ?? [])[1] ?? 0);
      if (buffer.length < end + 4 + length) return;
      const body = buffer.slice(end + 4, end + 4 + length).toString("utf8");
      buffer = buffer.slice(end + 4 + length);
      try { void handle(JSON.parse(body)); } catch { /* ignored */ }
    } else {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl).toString("utf8").trim();
      buffer = buffer.slice(nl + 1);
      if (line) { try { void handle(JSON.parse(line)); } catch { /* ignored */ } }
    }
  }
});
process.stdin.on("end", () => { log({ event: "stdin-end" }); process.exit(0); });

let announced = v2();
setInterval(() => {
  if (!announced && v2()) {
    announced = true;
    log({ event: "list_changed-sent" });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}, 300).unref();
