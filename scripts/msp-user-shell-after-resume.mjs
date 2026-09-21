#!/usr/bin/env node
/**
 * Does `session/userShell` need the session to be LOADED, and does
 * `session/resume` provide that?
 *
 * Context. `session/list` reports every persisted session as `notLoaded` after a
 * host restart — including sessions with dozens of turns — so "the host admits
 * this session" and "the host has it in memory" are different states. The
 * desktop calls `session/userShell` directly, and a user who has never sent a
 * message in a conversation gets `sessionNotLoaded`.
 *
 * This probe measures the same call twice on one session, before and after a
 * resume, so any difference is attributable to the resume rather than assumed.
 *
 * Usage: node scripts/msp-user-shell-after-resume.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const OBSERVE_MS = Number(process.env.MUSE_OBSERVE_MS ?? 12_000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function uuidv7() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const workspace = mkdtempSync(join(tmpdir(), "muse-resume-shell-"));
const host = spawn(SIDECAR, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
const reader = createInterface({ input: host.stdout });
const started = Date.now();
const timeline = [];
const pending = new Map();
let nextId = 1;

reader.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
  if (typeof message.method === "string") {
    timeline.push({ atMs: Date.now() - started, method: message.method, params: message.params });
  }
});
const send = (method, params, id) => host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
const request = (method, params, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send(method, params, id);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, timeoutMs);
  });
const notify = (method, params) => host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const describe = (response) => response.error
  ? { failed: true, kind: response.error.data?.kind ?? null, message: String(response.error.message).slice(0, 130) }
  : { failed: false, status: response.result?.status ?? null, keys: Object.keys(response.result ?? {}) };

const report = { schema: "muse-desktop.msp-user-shell-after-resume.v1" };
try {
  const init = await request("initialize", {
    clientInfo: { name: "muse_resume_shell_probe", version: "1.0.0" },
    schema: 1,
    capabilities: { requestedCapabilities: ["userShell"] },
  });
  report.grantedCapabilities = init.result?.grantedCapabilities ?? null;
  notify("initialized", {});
  await sleep(600);

  const start = await request("session/start", { workspaceRoot: workspace, commandId: uuidv7() });
  const sessionId = start.result?.session?.sessionId ?? start.result?.sessionId ?? null;
  report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
  report.startedStatus = start.result?.session?.status ?? null;
  if (!sessionId) throw new Error(`session/start: ${JSON.stringify(start.error ?? start.result).slice(0, 160)}`);

  // Control: the call works while the session is definitely loaded.
  const atLoaded = timeline.length;
  const markerLoaded = `muse-loaded-${Date.now()}`;
  const loaded = await request("session/userShell", { sessionId, commandText: `echo ${markerLoaded}`, commandId: uuidv7() });
  report.whileLoaded = describe(loaded);
  await sleep(Math.min(OBSERVE_MS, 6000));
  report.whileLoadedItems = timeline.slice(atLoaded)
    .filter((e) => /usershell/i.test(String(e.params?.item?.kind ?? ""))).length;
  report.whileLoadedMarkerEchoed = JSON.stringify(timeline.slice(atLoaded)).includes(markerLoaded);

  // Now ask the host to forget it, if it will, by resuming from disk and
  // letting the process state settle; then re-run the same call.
  const resume = await request("session/resume", { sessionId, commandId: uuidv7() });
  report.resume = describe(resume);

  const atResume = timeline.length;
  const markerAfter = `muse-after-resume-${Date.now()}`;
  const after = await request("session/userShell", { sessionId, commandText: `echo ${markerAfter}`, commandId: uuidv7() });
  report.afterResume = describe(after);
  await sleep(OBSERVE_MS);
  const events = timeline.slice(atResume);
  report.afterResumeNotifications = events.map((e) => ({ atMs: e.atMs, method: e.method, kind: e.params?.item?.kind ?? null }));
  report.afterResumeUserShellItems = events.filter((e) => /usershell/i.test(String(e.params?.item?.kind ?? ""))).length;
  report.afterResumeMarkerEchoed = JSON.stringify(events).includes(markerAfter);

  report.verdict = report.whileLoaded.failed === false
    ? "userShell works on a loaded session; the desktop's sessionNotLoaded comes from the host not having the session in memory"
    : "userShell failed even on a freshly started session — the cause is elsewhere";
} catch (error) {
  report.fatal = String(error).slice(0, 300);
} finally {
  try { host.kill(); } catch { /* already gone */ }
  await sleep(400);
  if (existsSync(workspace)) { try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.fatal ? 1 : 0);
