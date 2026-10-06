#!/usr/bin/env node
/**
 * What does stopping a `muse serve` host cost its conversation?
 *
 * The app stopped hosts by killing them (a reload or Restart host replaces
 * the folder's host, closing the app stops them all). In the M0-13 audit of
 * 06/10/2026 a conversation stopped receiving live events after such a
 * replacement: the live turn's reply never reached the screen although the
 * engine finished it. This probe measures, on the engine itself, one Run in
 * Muse (`session/userShell`) and then the host stopped:
 *
 *   kill   TerminateProcess, as the app did;
 *   close  stdin closed, the host left to exit on its own (killed only after
 *          10 s).
 *
 * For each stop it reads the engine's own store: is the run's result in the
 * session journal (`user_shell_result`), what is the status of the
 * conversation's MSP view (`.msp-view-v1/<id>/HEAD.json`), and does a new host
 * still send this conversation's item events after a resume.
 * No turn, no model call.
 *
 * Usage: node scripts/msp-host-stop.mjs [--sidecar <engine exe>] [--base <folder>] [--runs 3] [--wait-ms 1500]
 * MUSE_NO_AUTO_UPDATE=1 is set for the engine.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const SIDECAR = resolve(arg("--sidecar", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const BASE = resolve(arg("--base", "."));
const RUNS = Number(arg("--runs", "3"));
const WAIT_MS = Number(arg("--wait-ms", "1500"));
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
  const exited = new Promise((done) => child.on("exit", () => done(true)));
  const pending = new Map();
  const events = [];
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method?.startsWith("item/")) events.push(`${message.method}:${message.params?.item?.kind ?? "?"}`);
  });
  const request = (method, params) => new Promise((done) => {
    const id = nextId++;
    pending.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); done({ error: { message: `${method}: timeout` } }); } }, 30_000);
  });
  return {
    request,
    events,
    async open() {
      await request("initialize", { clientInfo: { name: "muse_host_stop_probe", version: "1.0.0" }, capabilities: { requestedCapabilities: ["userShell", "sessionMcp"] } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      await sleep(500);
    },
    kill() { child.kill(); return Promise.race([exited, sleep(5_000)]); },
    async close() {
      const started = Date.now();
      try { child.stdin.end(); } catch { /* closed */ }
      const own = await Promise.race([exited, sleep(10_000).then(() => false)]);
      if (!own) child.kill();
      return { exitedOnItsOwn: own, ms: Date.now() - started };
    },
  };
}

/** The engine's store for one conversation, from the journal path it reports. */
function store(journal, sessionId) {
  const records = existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  // <sessions>/<yyyy>/<mm>/<dd>/<id>/session.jsonl; views live in <sessions>/.msp-view-v1/<id>.
  const sessions = dirname(dirname(dirname(dirname(dirname(journal)))));
  let head = null;
  try { head = JSON.parse(readFileSync(join(sessions, ".msp-view-v1", sessionId, "HEAD.json"), "utf8")); } catch { /* no view */ }
  return {
    resultInJournal: records.some((r) => r.payload?.kind === "user_shell_result"),
    lastRecord: records.at(-1)?.payload?.kind ?? null,
    viewStatus: head?.status ?? null,
    viewRecordInJournal: head ? records.some((r) => r.id === head.source_through?.id) : null,
  };
}

async function once(mode) {
  const workspace = join(BASE, `host-stop-${mode}-${Date.now().toString(36)}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "probe\n");
  let h = host(workspace);
  await h.open();
  const started = await h.request("session/start", { workspaceRoot: workspace, commandId: uuidv7() });
  const sessionId = started.result?.session?.sessionId;
  const journal = String(started.result?.session?.path ?? "").replace(/^\\\\\?\\/, "");
  await h.close();
  // The host the conversation lives in: one Run in Muse, then the stop.
  h = host(workspace);
  await h.open();
  await h.request("session/resume", { sessionId, commandId: uuidv7(), excludeItems: true });
  await sleep(1_500);
  await h.request("session/userShell", { sessionId, commandText: "echo host-stop-probe", commandId: uuidv7() });
  for (let t = 0; t < 100 && !h.events.includes("item/completed:userShell"); t += 1) await sleep(100);
  const reported = h.events.includes("item/completed:userShell");
  await sleep(WAIT_MS);
  const beforeStop = store(journal, sessionId);
  const stop = mode === "kill" ? { killed: await h.kill() } : await h.close();
  const afterStop = store(journal, sessionId);
  // The next host: does this conversation still stream?
  h = host(workspace);
  await h.open();
  await h.request("session/resume", { sessionId, commandId: uuidv7(), excludeItems: true });
  await sleep(1_500);
  const from = h.events.length;
  await h.request("session/userShell", { sessionId, commandText: "echo host-stop-next", commandId: uuidv7() });
  await sleep(5_000);
  const nextHostEvents = h.events.slice(from);
  await h.close();
  return { mode, runReportedToTheClient: reported, beforeStop, stop, afterStop, viewAfterNextResume: store(journal, sessionId).viewStatus, nextHostEvents };
}

const report = { schema: "muse-desktop.msp-host-stop.v1", engine: null, waitAfterTheRunMs: WAIT_MS };
try { report.engine = execFileSync(SIDECAR, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(); } catch { /* recorded as null */ }
report.runs = [];
for (let i = 0; i < RUNS; i += 1) for (const mode of ["kill", "close"]) report.runs.push(await once(mode));
const tally = (mode) => {
  const runs = report.runs.filter((r) => r.mode === mode);
  return {
    runs: runs.length,
    resultKept: runs.filter((r) => r.afterStop.resultInJournal).length,
    viewUnavailableAfterNextResume: runs.filter((r) => r.viewAfterNextResume === "unavailable").length,
    nextHostStillStreams: runs.filter((r) => r.nextHostEvents.length > 0).length,
  };
};
report.tally = { kill: tally("kill"), close: tally("close") };
console.log(JSON.stringify(report, null, 2));
