#!/usr/bin/env node
/**
 * Ask the live Muse host which reasoning tiers it actually accepts.
 *
 * The MSP schema declares a closed vocabulary of seven tiers, but a declared
 * type is a spelling contract, not a promise that the engine honours every
 * value. The desktop's picker offers all seven with hand-written descriptions,
 * so "does Muse Spark really have these levels?" has to be answered by the
 * engine, not by the schema.
 *
 * Method: start one host in a throwaway workspace, then set each tier in turn
 * and record the reply. Read-only with respect to the repository.
 *
 * Usage: node scripts/msp-reasoning-tiers.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SIDECAR = process.env.MUSE_SIDECAR ?? "src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe";
const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"];
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

const workspace = mkdtempSync(join(tmpdir(), "muse-effort-"));
const host = spawn(SIDECAR, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
const reader = createInterface({ input: host.stdout });
const notifications = [];
const pending = new Map();
let nextId = 1;

reader.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (typeof message.method === "string") notifications.push(message);
});
const request = (method, params, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, timeoutMs);
  });

const report = { schema: "muse-desktop.msp-reasoning-tiers.v1", tiers: {} };
try {
  const init = await request("initialize", {
    clientInfo: { name: "muse_effort_probe", version: "1.0.0" },
    schema: 1,
    capabilities: {},
  });
  report.hostVersion = init.result?.serverInfo?.version ?? null;
  host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
  await sleep(600);

  const started = await request("session/start", { workspaceRoot: workspace, commandId: uuidv7() });
  const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
  report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
  report.startDefaultEffort = started.result?.session?.reasoningEffort ?? null;
  if (!sessionId) throw new Error(`session/start: ${JSON.stringify(started.error ?? started.result).slice(0, 160)}`);

  for (const tier of TIERS) {
    const before = notifications.length;
    const reply = await request("session/setReasoningEffort", {
      sessionId,
      commandId: uuidv7(),
      reasoningEffort: tier,
    }, 15_000);
    await sleep(500);
    const events = notifications.slice(before)
      .filter((n) => /reasoning/i.test(n.method))
      .map((n) => ({ method: n.method, value: n.params?.reasoningEffort ?? n.params?.effort ?? null }));
    report.tiers[tier] = reply.error
      ? { accepted: false, kind: reply.error.data?.kind ?? null, message: String(reply.error.message).slice(0, 120) }
      : { accepted: true, status: reply.result?.status ?? null, echoed: reply.result?.reasoningEffort ?? null, events };
  }

  // The effective value should be readable back on the session.
  const read = await request("session/read", { sessionId, excludeItems: true }, 15_000);
  report.effectiveAfter = read.result?.session?.reasoningEffort ?? null;
} catch (error) {
  report.fatal = String(error).slice(0, 250);
} finally {
  try { host.kill(); } catch { /* already gone */ }
  await sleep(400);
  if (existsSync(workspace)) { try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.fatal ? 1 : 0);
