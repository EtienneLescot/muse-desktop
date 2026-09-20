#!/usr/bin/env node

/**
 * Is there really an approval-mode ceiling?
 *
 * The gap report's last standing claim is that approval cannot be configured
 * beyond `promptUnmatched`, which limits M0-01's simultaneous-approval criterion
 * and M0-06. Five earlier claims from the same tooling turned out to be
 * measurement artefacts, so this one is re-measured outside that tooling before
 * it is asserted to anyone.
 *
 * Method: read the session's `approvalMode` (which `session/read` exposes), then
 * try each plausible mode through the obvious method names and report what the
 * host actually answers — including the exact rejection when it refuses.
 *
 * Usage:
 *   node scripts/msp-approval-mode-check.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
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

/** Candidate mode values, from permissive to restrictive, plus aliases. */
const MODES = ["onRequest", "allowAll", "auto", "yolo", "never", "promptUnmatched", "ask", "deny"];

/** Candidate method names the client could plausibly use. */
const METHODS = ["session/setApprovalMode", "session/setApproval", "session/approvalMode", "approval/setMode"];

async function main() {
  const child = spawn(SIDECAR, ["serve", "--sandbox-network", "restricted"], { stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  reader.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) { if (typeof frame.method === "string") notifications.push(frame.method); return; }
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, timeoutMs);
    });

  const report = { schema: "muse-desktop.msp-approval-mode-check.v1", attempts: [] };
  try {
    const init = await request("initialize", {
      clientInfo: { name: "muse_approval_check", version: "1.0.0" },
      capabilities: { requestedCapabilities: ["userShell"] },
    });
    report.durability = init.result?.sessionDurability ?? null;
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await sleep(600);

    const started = await request("session/start", { commandId: uuidv7(), workspaceRoot: WORKSPACE });
    const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
    report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
    if (!sessionId) throw new Error(`session/start: ${JSON.stringify(started.error ?? started.result).slice(0, 140)}`);

    const readMode = async () => {
      const read = await request("session/read", { sessionId, excludeItems: true });
      return read.error ? { error: read.error.data?.kind ?? String(read.error.message).slice(0, 60) } : (read.result?.session?.approvalMode ?? null);
    };
    report.before = await readMode();

    // Which method name is real? Probe each with one value.
    for (const method of METHODS) {
      const response = await request(method, { commandId: uuidv7(), sessionId, mode: "allowAll" });
      report.attempts.push({
        method,
        params: "mode: allowAll",
        outcome: response.error
          ? { rejected: true, kind: response.error.data?.kind ?? null, message: String(response.error.message).slice(0, 80) }
          : { accepted: true, result: JSON.stringify(response.result ?? {}).slice(0, 140) },
        modeAfter: await readMode(),
      });
    }

    // For the method that exists, try every mode value.
    const working = report.attempts.find((a) => a.outcome?.accepted)?.method ?? null;
    report.workingMethod = working;
    if (working) {
      report.modeAttempts = [];
      for (const mode of MODES) {
        const response = await request(working, { commandId: uuidv7(), sessionId, mode });
        report.modeAttempts.push({
          mode,
          outcome: response.error
            ? { rejected: true, kind: response.error.data?.kind ?? null, message: String(response.error.message).slice(0, 90) }
            : { accepted: true },
          modeAfter: await readMode(),
        });
      }
    }
    report.notifications = [...new Set(notifications)];
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    child.kill();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
