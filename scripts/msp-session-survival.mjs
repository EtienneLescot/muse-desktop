#!/usr/bin/env node

/**
 * Does a session survive its host, and can a later host still list it?
 *
 * This is the decisive test for the M0-02 hypothesis. The client declares
 * `session/list` in `src/lib/msp.ts` but never calls it, and it reports
 * `sessionNotFound` after a Reconnect. If the host can still enumerate the
 * session after death, then the recovery failure lies in the client, not in the
 * sidecar — and that is fixable here.
 *
 * Read-only: creates one session, kills its host, starts another, lists.
 *
 * Usage:
 *   node scripts/msp-session-survival.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * UUIDv7, because the host rejects anything else:
 * `invalid session/start commandId: expected UUIDv7`.
 * A `uuidv7()` (v4) is refused, so the timestamp prefix is required.
 * The 48-bit big-endian millisecond prefix is written byte-wise: shifting a
 * BigInt then passing it to `writeUIntBE` silently corrupts the value.
 */
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

/** Start a host and complete the handshake (initialize + `initialized`). */
async function startHost(label) {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) return;
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); }
      }, timeoutMs);
    });

  const init = await request("initialize", {
    clientInfo: { name: "muse_session_survival", version: "1.0.0" },
    schema: 1,
    capabilities: {},
  });
  if (init.error) throw new Error(`${label}: initialize failed — ${init.error.message}`);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await sleep(600);
  return { label, child, request, durability: init.result?.sessionDurability ?? null };
}

const listSessions = async (host, limit = 200) => {
  const listed = await host.request("session/list", { limit });
  if (listed.error) return { error: JSON.stringify(listed.error).slice(0, 160), sessions: [] };
  return { sessions: Array.isArray(listed.result?.sessions) ? listed.result.sessions : [] };
};

async function main() {
  const report = { schema: "muse-desktop.msp-session-survival.v1", steps: [] };

  // 1. Host A creates a session.
  const a = await startHost("A");
  report.hostADurability = a.durability;
  const started = await a.request("session/start", { workspaceRoot: WORKSPACE, commandId: uuidv7() });
  const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
  report.sessionId = sessionId;
  report.startResult = started.error ? { error: JSON.stringify(started.error).slice(0, 160) } : { ok: true };
  if (!sessionId) {
    report.verdict = "session/start did not return an id — cannot continue";
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    a.child.kill();
    return;
  }

  const before = await listSessions(a);
  report.steps.push({ step: "A: session listed by its own host", found: before.sessions.some((s) => String(s.sessionId) === sessionId), count: before.sessions.length });

  // 2. Kill host A — the equivalent of the app closing or a host crash.
  a.child.kill();
  await sleep(2_500);

  // 3. Host B: a fresh process, as the client spawns on Reconnect.
  const b = await startHost("B");
  report.hostBDurability = b.durability;
  const after = await listSessions(b);
  const match = after.sessions.find((s) => String(s.sessionId) === sessionId) ?? null;
  report.steps.push({ step: "B: session listed by a NEW host", found: Boolean(match), count: after.sessions.length });
  if (match) {
    report.matched = {
      status: match.status ?? null,
      turnCount: match.turnCount ?? null,
      title: String(match.title ?? "").slice(0, 48),
      workspaceRoot: String(match.workspaceRoot ?? "").replace(/^\\\\\?\\/, ""),
      path: String(match.path ?? ""),
    };
  }

  // 4. Can host B resume it? This is what the client attempts.
  const resume = await b.request("session/resume", { sessionId, commandId: uuidv7() });
  report.steps.push({
    step: "B: session/resume",
    outcome: resume.error ? { kind: resume.error.data?.kind ?? null, message: String(resume.error.message).slice(0, 90) } : { ok: true },
  });

  // 5. And can it read the history? That is what a recovery needs.
  const read = await b.request("session/read", { sessionId, excludeItems: false });
  report.steps.push({
    step: "B: session/read",
    outcome: read.error ? { kind: read.error.data?.kind ?? null, message: String(read.error.message).slice(0, 90) } : { ok: true, items: Array.isArray(read.result?.items) ? read.result.items.length : null },
  });

  report.verdict = match
    ? "the session survives its host and a NEW host lists it — a recovery path exists at the host level"
    : "the session is NOT listed by a new host — the host itself loses it";

  b.child.kill();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
