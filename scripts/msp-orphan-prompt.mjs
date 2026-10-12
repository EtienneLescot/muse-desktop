#!/usr/bin/env node

/**
 * M0-05, MSP level, no model turn: what a fresh engine reports for a
 * conversation whose engine was killed while a question (request_user_input)
 * was pending. The app is closed; this script is the engine's only client.
 *
 * Steps: initialize; session/read and approval/listPending before resume;
 * session/resume, then every frame for 4 s (a pending prompt is re-issued as a
 * userInput/request server request right after the resume response, tdd
 * SS5.6; each one is acknowledged with an empty result, as the app's bridge
 * does); approval/listPending again; shutdown by closing stdin. Nothing is
 * answered or cancelled, so the conversation's record is left as found.
 *
 * Usage:
 *   node scripts/msp-orphan-prompt.mjs --session <id> --workspace <folder>
 *     [--sandbox-network enabled|restricted] [--key msp-orphan]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-05-questions.json]
 * The record merges under phases[--key], path-free. MUSE_NO_AUTO_UPDATE=1 is
 * set for the engine.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { argValue, gitHead, redactor, sleep } from "./cdp-harness.mjs";

const SESSION = argValue("--session", null);
const WORKSPACE = argValue("--workspace", null);
const NETWORK = argValue("--sandbox-network", "enabled");
const KEY = argValue("--key", "msp-orphan");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-05-questions.json");
const SIDECAR = resolve("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
if (!SESSION || !WORKSPACE) {
  process.stderr.write("usage: msp-orphan-prompt.mjs --session <id> --workspace <folder> [--sandbox-network enabled|restricted]\n");
  process.exit(1);
}

/** UUIDv7: the host refuses a v4 command id. */
function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const child = spawn(SIDECAR, ["serve", "--sandbox-network", NETWORK], {
  cwd: WORKSPACE, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
});
const t0 = Date.now();
const frames = [];
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method !== undefined && frame.id !== undefined) {
    // A server request: acknowledged with an empty result, as the bridge does.
    frames.push({ ms: Date.now() - t0, request: frame.method, params: frame.params ?? null });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
  } else if (frame.method !== undefined) {
    frames.push({ ms: Date.now() - t0, notification: frame.method, userInputId: frame.params?.userInputId ?? undefined });
  } else if (pending.has(frame.id)) {
    pending.get(frame.id)(frame);
    pending.delete(frame.id);
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });

const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: "timed out" } }); }, 60_000);
  pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const outcome = (frame) => (frame.error ? { error: `${frame.error.code ?? ""} ${frame.error.message ?? ""} ${JSON.stringify(frame.error.data ?? {})}`.trim().slice(0, 400) } : { ok: true });
const sessionView = (s) => s && { status: s.status ?? null, activeTurnId: s.activeTurnId ?? null, turnCount: s.turnCount ?? null };
const prompts = (frame) => (frame.result?.userInputs ?? []).map((u) => ({ userInputId: u.userInputId, turnId: u.turnId, toolName: u.toolName,
  questions: (u.questions ?? []).map((q) => q.id) }));

const result = { liveTurns: 0, engineArgs: ["serve", "--sandbox-network", NETWORK] };
try {
  const init = await request("initialize", { clientInfo: { name: "muse_desktop_m05_probe", version: "0.1.0" }, capabilities: { requestedCapabilities: ["userShell", "sessionMcp"] } });
  result.initialize = outcome(init);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  const read = await request("session/read", { sessionId: SESSION, excludeItems: true });
  result.readBeforeResume = { ...outcome(read), session: sessionView(read.result?.session) };
  const before = await request("approval/listPending", { sessionId: SESSION });
  result.listPendingBeforeResume = { ...outcome(before), userInputs: prompts(before), approvals: (before.result?.approvals ?? []).length };
  const resumeAt = Date.now() - t0;
  const resumed = await request("session/resume", { sessionId: SESSION, commandId: uuidv7(), excludeItems: true });
  result.resume = { ...outcome(resumed), session: sessionView(resumed.result?.session), pendingRequests: resumed.result?.pendingRequests ?? resumed.result?.session?.pendingRequests ?? null };
  await sleep(4_000);
  result.framesAfterResume = frames.filter((f) => f.ms >= resumeAt).map((f) => ({ ...f, params: f.params ? { userInputId: f.params.userInputId, turnId: f.params.turnId, toolName: f.params.toolName } : undefined }));
  const after = await request("approval/listPending", { sessionId: SESSION });
  result.listPendingAfterResume = { ...outcome(after), userInputs: prompts(after), approvals: (after.result?.approvals ?? []).length };
  result.verdict = {
    sessionRunsNoTurn: result.resume.session?.status !== "running" && result.resume.session?.activeTurnId === null,
    foldStillListsTheQuestion: result.listPendingAfterResume.userInputs.length > 0,
    questionReissuedAfterResume: result.framesAfterResume.some((f) => f.request === "userInput/request"),
  };
} finally {
  child.stdin.end();
  await sleep(1_500);
  if (child.exitCode === null) child.kill();
}

const redact = redactor([[WORKSPACE, "<test folder>"]]);
let record;
try { record = JSON.parse(readFileSync(OUT, "utf8")); } catch { record = { schema: "muse-desktop.m0-05-questions.v1", ticket: "M0-05", phases: {} }; }
record.phases[KEY] = redact({ commit: gitHead(), engine: execFileSync(SIDECAR, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(), ...result,
  stderrTail: stderr.split("\n").slice(-5).join("\n").slice(0, 600) });
record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record.phases[KEY], null, 2)}\n`);
