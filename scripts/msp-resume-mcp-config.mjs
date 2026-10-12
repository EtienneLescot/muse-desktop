#!/usr/bin/env node
/**
 * Does `session/resume` apply a new MCP configuration to a conversation?
 *
 * "Reconnect with current connectors" resumed a conversation its host had
 * already loaded and changed nothing (M0-13, 06/10/2026). This probe measures,
 * on the engine itself, what a resume does with `config.mcpServers`:
 *
 *   loaded      a session started without MCP, resumed with a stdio server;
 *   fresh host  the same session after its host restarted (not loaded),
 *               resumed with that server, then with another one;
 *   none        a session started with the server, its host restarted,
 *               resumed with no config (or an empty one), then with the server.
 *
 * The stdio server is scripts/msp-fixture.mjs; "spawned" is a node.exe whose
 * parent is the engine. No turn, no model call. Windows (process table).
 *
 * Usage: node scripts/msp-resume-mcp-config.mjs [--sidecar <engine exe>] [--base <folder>]
 * MUSE_NO_AUTO_UPDATE=1 is set for the engine.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const SIDECAR = resolve(arg("--sidecar", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const BASE = resolve(arg("--base", "."));
const FIXTURE = resolve("scripts", "msp-fixture.mjs");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function uuidv7() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function host(workspace) {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted", "--trust-workspace"], {
    cwd: workspace, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const request = (method, params) => new Promise((done) => {
    const id = nextId++;
    pending.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); done({ error: { message: `${method}: timeout` } }); } }, 30_000);
  });
  return {
    request,
    async open() {
      await request("initialize", { clientInfo: { name: "muse_resume_mcp_probe", version: "1.0.0" }, capabilities: { requestedCapabilities: ["sessionMcp"] } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      await sleep(500);
    },
    /** The engine's children that run the fixture. */
    fixtures() {
      return execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.CommandLine -like '*msp-fixture.mjs*' } | ForEach-Object { $_.ProcessId }; exit 0`],
      { encoding: "utf8" }).split(/\s+/).filter(Boolean).length;
    },
    async close() { try { child.stdin.end(); } catch { /* closed */ } await sleep(1_500); try { child.kill(); } catch { /* gone */ } },
  };
}

const server = (scenario) => ({ mcpServers: { fixture: { transport: "stdio", command: "node", args: [FIXTURE, scenario], mode: "optional" } } });
const outcome = (response) => (response.error ? `refused: ${response.error.data?.reason ?? response.error.data?.kind ?? response.error.message}` : "accepted");
const resume = (h, sessionId, config) => h.request("session/resume", { sessionId, commandId: uuidv7(), excludeItems: true, ...(config ? { config } : {}) });

const report = { schema: "muse-desktop.msp-resume-mcp-config.v1", engine: null };
try { report.engine = execFileSync(SIDECAR, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(); } catch { /* recorded as null */ }
const workspace = (label) => {
  const dir = join(BASE, `resume-mcp-${label}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "probe\n");
  return dir;
};

{
  const dir = workspace("plain");
  let h = host(dir);
  await h.open();
  const sessionId = (await h.request("session/start", { workspaceRoot: dir, commandId: uuidv7() })).result?.session?.sessionId;
  await sleep(2_000);
  const loaded = { startedWithout: { fixtures: h.fixtures() }, resumeWithServer: outcome(await resume(h, sessionId, server("success"))) };
  await sleep(3_000);
  loaded.fixturesAfter = h.fixtures();
  report.loaded = loaded;
  await h.close();
  h = host(dir);
  await h.open();
  const fresh = { resumeWithServer: outcome(await resume(h, sessionId, server("success"))) };
  await sleep(3_000);
  fresh.fixturesAfter = h.fixtures();
  fresh.thenResumeWithAnother = outcome(await resume(h, sessionId, server("interleaved")));
  report.freshHost = fresh;
  await h.close();
}

for (const [label, config] of [["noConfig", null], ["emptyConfig", { mcpServers: {} }]]) {
  const dir = workspace(label);
  let h = host(dir);
  await h.open();
  const sessionId = (await h.request("session/start", { workspaceRoot: dir, commandId: uuidv7(), config: server("success") })).result?.session?.sessionId;
  await sleep(2_000);
  const row = { startedWithServer: { fixtures: h.fixtures() } };
  await h.close();
  h = host(dir);
  await h.open();
  row.resume = outcome(await resume(h, sessionId, config));
  await sleep(3_000);
  row.fixturesAfter = h.fixtures();
  row.thenResumeWithServer = outcome(await resume(h, sessionId, server("success")));
  report[label] = row;
  await h.close();
}

report.reading = [
  "loaded: a conversation its host has loaded keeps its MCP configuration; another one is refused (session_configuration_conflict).",
  "freshHost: in a new host the conversation is not loaded, and the resume binds the configuration it carries (the server starts as the engine's child; another config afterwards is refused).",
  "noConfig / emptyConfig: a resume without servers binds none: the servers of the start do not come back.",
];
console.log(JSON.stringify(report, null, 2));
