#!/usr/bin/env node

/**
 * Probe the `session/userShell` capability handshake, then its result reporting.
 *
 * Round 1 of this probe asked for the capability under `requestedCapabilities`
 * and the host granted nothing (`grantedCapabilities: []`), answering the call
 * with `capabilityRequired`. So the request shape was wrong, not the host
 * missing a feature. This version tries the shapes in order and reports which
 * one is honoured, then observes **every** notification for the command's
 * output.
 *
 * Read-only apart from one witness file it writes in the temp directory.
 *
 * Usage:
 *   node scripts/msp-user-shell-capability.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const WORKSPACE = process.env.MUSE_WORKSPACE ?? "C:\\Users\\etien\\Documents\\repos\\muse-desktop";
const OBSERVE_MS = Number(process.env.MUSE_OBSERVE_MS ?? 30_000);
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

/** One host, one capability shape, one userShell call, full observation. */
async function attempt(label, initExtras) {
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
      if (typeof frame.method === "string") timeline.push({ atMs: Date.now() - startedAt, method: frame.method, params: frame.params ?? null });
      return;
    }
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
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, timeoutMs);
    });

  const outcome = { label, requested: initExtras };
  try {
    const init = await request("initialize", {
      clientInfo: { name: "muse_user_shell_cap", version: "1.0.0" },
      schema: 1,
      ...initExtras,
    });
    if (init.error) { outcome.initError = String(init.error.message).slice(0, 110); return outcome; }
    outcome.initializeFields = Object.keys(init.result ?? {}).sort();
    outcome.grantedCapabilities = init.result?.grantedCapabilities ?? null;
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await sleep(600);

    const started = await request("session/start", { workspaceRoot: WORKSPACE, commandId: uuidv7() });
    const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
    if (!sessionId) { outcome.startError = JSON.stringify(started.error ?? started.result).slice(0, 120); return outcome; }

    const marker = `muse-ushell-${Date.now()}`;
    const witness = `${process.env.TEMP ?? "."}\\${marker}.txt`;
    const commandText = `node -e "setTimeout(()=>{require('fs').writeFileSync(String.raw\`${witness}\`,'ok');console.log('${marker}');},4000)"`;
    const atRequest = timeline.length;
    const shell = await request("session/userShell", { sessionId, commandText, commandId: uuidv7() });
    outcome.userShell = shell.error
      ? { failed: true, kind: shell.error.data?.kind ?? null, message: String(shell.error.message).slice(0, 100) }
      : { failed: false, result: JSON.stringify(shell.result ?? {}).slice(0, 200) };

    await sleep(OBSERVE_MS);
    const after = timeline.slice(atRequest);
    outcome.notificationMethods = [...new Set(after.map((entry) => entry.method))];
    outcome.notificationCount = after.length;
    outcome.kinds = [...new Set(after.map((entry) => entry.params?.item?.kind ?? entry.params?.kind ?? null).filter(Boolean))];
    outcome.outputRefSeen = JSON.stringify(after).includes("outputRef");
    outcome.markerEchoed = JSON.stringify(after).includes(marker);
    outcome.witnessFileWritten = existsSync(witness);
    outcome.observedMs = OBSERVE_MS;
  } catch (error) {
    outcome.failure = String((error && error.message) || error).slice(0, 200);
  } finally {
    child.kill();
  }
  return outcome;
}

const shapes = [
  ["capabilities", { capabilities: { userShell: true } }],
  ["capabilities[]", { capabilities: ["userShell"] }],
  ["requestedCapabilities[]", { capabilities: {}, requestedCapabilities: ["userShell"] }],
];

const results = [];
for (const [label, extras] of shapes) results.push(await attempt(label, extras));
process.stdout.write(`${JSON.stringify({ schema: "muse-desktop.msp-user-shell-capability.v1", results }, null, 2)}\n`);
