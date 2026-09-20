#!/usr/bin/env node

/**
 * What does the host emit after `turn/interrupt`?
 *
 * M0-04 needs a terminal signal when a turn is stopped: without it the client
 * shows `Stopping…` and then goes stale, never knowing whether the stop landed.
 * `native-smoke.mjs --exercise-control --exercise-terminal` fails with
 * "did not emit a terminal notification", but it waits a bounded time and only
 * looks for `turn/completed` / `turn/retracted` / `turn/stopped`.
 *
 * This script interrupts a deliberately long turn and records **every**
 * notification for a generous window, so the answer is "the host is silent"
 * rather than "my timeout was too short".
 *
 * Usage:
 *   node scripts/msp-interrupt-notifications.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const OBSERVE_MS = Number(process.env.MUSE_OBSERVE_MS ?? 45_000);
const INTERRUPT_AFTER_MS = Number(process.env.MUSE_INTERRUPT_AFTER_MS ?? 6_000);
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

async function main() {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  const timeline = [];
  const startedAt = Date.now();

  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) {
      if (typeof frame.method === "string") {
        timeline.push({ atMs: Date.now() - startedAt, method: frame.method, keys: Object.keys(frame.params ?? {}).slice(0, 6), params: frame.params ?? null });
      }
      return;
    }
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 40_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); }
      }, timeoutMs);
    });

  const report = { schema: "muse-desktop.msp-interrupt-notifications.v1" };
  try {
    const init = await request("initialize", {
      clientInfo: { name: "muse_interrupt_probe", version: "1.0.0" }, schema: 1, capabilities: {},
    });
    report.durability = init.result?.sessionDurability ?? null;
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await sleep(600);

    const started = await request("session/start", { workspaceRoot: WORKSPACE, commandId: uuidv7() });
    const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
    report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
    if (!sessionId) throw new Error(`session/start failed: ${JSON.stringify(started.error ?? started.result).slice(0, 160)}`);

    // A deliberately long turn so there is something to interrupt.
    const turnId = uuidv7();
    const turn = await request("turn/start", {
      sessionId,
      commandId: turnId,
      input: [{ type: "text", text: "Count slowly from one to four hundred, one number per line." }],
    }, 20_000);
    report.turnStart = turn.error ? { failed: true, message: String(turn.error.message).slice(0, 90) } : { failed: false, result: turn.result ?? null };

    await sleep(INTERRUPT_AFTER_MS);
    const beforeInterrupt = timeline.length;
    report.notificationsBeforeInterrupt = beforeInterrupt;

    const interrupt = await request("turn/interrupt", { sessionId, turnId, commandId: uuidv7() }, 20_000);
    report.interrupt = interrupt.error
      ? { failed: true, kind: interrupt.error.data?.kind ?? null, message: String(interrupt.error.message).slice(0, 90) }
      : { failed: false };
    const interruptedAtMs = Date.now() - startedAt;

    // Observe everything for a generous window: silence must be measured, not assumed.
    await sleep(OBSERVE_MS);

    const after = timeline.filter((entry) => entry.atMs >= interruptedAtMs);
    report.observedAfterInterruptMs = OBSERVE_MS;
    report.notificationsAfterInterrupt = after.map((entry) => ({ atMs: entry.atMs - interruptedAtMs, method: entry.method }));
    const terminalEntries = after.filter((e) => /^turn\/(completed|retracted|stopped)$/.test(e.method));
    report.terminalTurnIds = terminalEntries.map((e) => ({ method: e.method, turnId: e.params?.turnId ?? null, keys: Object.keys(e.params ?? {}) }));
    report.turnIdSent = turnId;
    const terminal = after.filter((entry) => /^turn\/(completed|retracted|stopped)$/.test(entry.method));
    report.terminalAfterInterrupt = { count: terminal.length, methods: terminal.map((entry) => entry.method) };

    // Did the turn keep streaming after the interrupt was acknowledged?
    const deltas = after.filter((entry) => entry.method === "item/delta").length;
    report.itemDeltasAfterInterrupt = deltas;

    report.verdict = terminal.length
      ? `terminal emitted ${terminal.map((e) => e.method).join(", ")} after ${terminal[0].atMs} ms`
      : deltas > 0
        ? "NO terminal, and the turn kept streaming after the interrupt was acknowledged"
        : "NO terminal, but the turn stopped emitting — silence with no confirmation";
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    child.kill();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
