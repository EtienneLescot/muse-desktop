#!/usr/bin/env node

/**
 * What does `--no-session-log` change on the host?
 *
 * `muse serve --help` says "Use memory-only sessions". Two long-standing
 * harness mysteries may both come from this flag:
 *
 *   1. `native-smoke.mjs` (which passes `--no-session-log`) reports
 *      `sessionDurability: "ephemeral"` while the msp-* probes (which do not)
 *      measure `durable` — the "durability varies" mystery.
 *   2. `native-smoke.mjs --exercise-control --exercise-terminal` never sees a
 *      turn materialize (only `session/started`), while the same sequence on a
 *      logging host emits the full notification chain — the documented
 *      false negative of the control path.
 *
 * This probe measures both in one instrument: two hosts, identical except for
 * the flag. For each host it records `initialize` durability, then runs the
 * exact smoke sequence (turn/start → immediate turn/interrupt) and records
 * every notification for a bounded window.
 *
 * Usage:
 *   node scripts/msp-session-log-effect.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const OBSERVE_MS = Number(process.env.MUSE_OBSERVE_MS ?? 20_000);
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

async function runHost(label, extraArgs) {
  const child = spawn(SIDECAR, ["serve", ...extraArgs], { cwd: WORKSPACE, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  const timeline = [];
  const startedAt = Date.now();
  let nextId = 1;
  const pending = new Map();

  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) {
      if (typeof frame.method === "string") {
        timeline.push({ atMs: Date.now() - startedAt, method: frame.method });
      }
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    entry.resolve(frame);
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const init = await request("initialize", {
    clientInfo: { name: "muse_log_effect", version: "1.0.0" },
    capabilities: { requestedCapabilities: [] },
  });
  // Handshake completion: the notification is named `initialized` (not
  // `notifications/initialized`) — without it every call answers
  // `Not initialized`.
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);

  const start = await request("session/start", { commandId: uuidv7(), workspaceRoot: WORKSPACE });
  const sessionId = start?.result?.session?.sessionId ?? null;

  // Exact smoke sequence: admit a real turn, then interrupt immediately.
  const turn = await request("turn/start", {
    commandId: uuidv7(),
    sessionId,
    input: [{ type: "text", text: "Native control smoke probe. Stop immediately." }],
  });
  const turnId = turn?.result?.turnId ?? null;
  const interrupt = turnId
    ? await request("turn/interrupt", { commandId: uuidv7(), sessionId, turnId, retract: false })
    : null;

  await sleep(OBSERVE_MS);

  child.kill();
  const notifications = timeline.map((entry) => entry.method);
  return {
    label,
    serveArgs: extraArgs,
    sessionDurability: init?.result?.sessionDurability ?? null,
    turnStart: {
      failed: turn?.error !== undefined,
      status: turn?.result?.status ?? null,
      turnId,
      error: turn?.error ?? null,
    },
    interrupt: interrupt?.error
      ? { failed: true, error: interrupt.error }
      : { failed: false, status: interrupt?.result?.status ?? null },
    notifications,
    turnStarted: notifications.includes("turn/started"),
    terminal: notifications.filter((m) => ["turn/completed", "turn/retracted", "turn/stopped"].includes(m)),
  };
}

async function main() {
  const withoutFlag = await runHost("logging (default)", []);
  const withFlag = await runHost("memory-only", ["--no-session-log"]);
  const report = {
    schema: "muse-desktop.msp-session-log-effect.v1",
    hosts: [withoutFlag, withFlag],
    verdict: {
      durabilityExplained:
        withoutFlag.sessionDurability === "durable" && withFlag.sessionDurability === "ephemeral",
      controlPathExplained:
        withoutFlag.turnStarted && !withFlag.turnStarted,
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
