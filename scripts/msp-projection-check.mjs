#!/usr/bin/env node

/**
 * Does a model / reasoning-effort change actually take effect?
 *
 * The gap report claimed the host accepts both calls but reports no effective
 * projection (`not-reported`, `isActive: false`). That reading came from
 * `native-smoke.mjs`, whose output this campaign showed to be unreliable, and a
 * first re-check failed on **my** parameters: the host wants `model: { modelId }`
 * and `reasoningEffort`, not `modelId` and `effort`.
 *
 * This script uses the correct shapes, then reads the session back to see
 * whether the change is visible anywhere — an `invalidParams` on my side proves
 * nothing about the host.
 *
 * Usage:
 *   node scripts/msp-projection-check.mjs
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
      if (typeof frame.method === "string") timeline.push({ atMs: Date.now() - startedAt, method: frame.method, params: frame.params ?? null });
      return;
    }
    const settle = pending.get(frame.id);
    if (!settle) return;
    pending.delete(frame.id);
    settle(frame);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}, timeoutMs = 25_000) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, timeoutMs);
    });

  const report = { schema: "muse-desktop.msp-projection-check.v1" };
  try {
    const init = await request("initialize", {
      clientInfo: { name: "muse_projection_check", version: "1.0.0" },
      capabilities: { requestedCapabilities: ["userShell"] },
    });
    report.durability = init.result?.sessionDurability ?? null;
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await sleep(600);

    const started = await request("session/start", { commandId: uuidv7(), workspaceRoot: WORKSPACE });
    const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
    report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
    if (!sessionId) throw new Error(`session/start: ${JSON.stringify(started.error ?? started.result).slice(0, 140)}`);

    /** Session fields that could carry a projection. */
    const readSession = async () => {
      const read = await request("session/read", { sessionId, excludeItems: true });
      const session = read.error ? null : read.result?.session ?? null;
      return session
        ? {
            modelId: session.modelId ?? null,
            providerId: session.providerId ?? null,
            reasoningEffort: session.reasoningEffort ?? null,
            effort: session.effort ?? null,
            approvalMode: session.approvalMode ?? null,
            fields: Object.keys(session).sort(),
          }
        : { error: read.error?.data?.kind ?? read.error?.message ?? "unreadable" };
    };

    report.before = await readSession();

    // The catalogue, to pick a model that actually exists.
    const models = await request("model/list", {});
    const catalogue = Array.isArray(models.result?.models) ? models.result.models : [];
    report.catalogueIds = catalogue.map((m) => String(m.modelId ?? "")).filter(Boolean);
    const target = catalogue.find((m) => String(m.modelId ?? "") !== report.before.modelId) ?? catalogue[0] ?? null;
    report.targetModelId = target ? String(target.modelId) : null;

    const atReasoning = timeline.length;
    for (const reasoningEffort of ["none", "high", "ultra"]) {
      const changed = await request("session/setReasoningEffort", { commandId: uuidv7(), sessionId, reasoningEffort });
      report[`setReasoningEffort_${reasoningEffort}`] = changed.error
        ? { failed: true, kind: changed.error.data?.kind ?? null, message: String(changed.error.message).slice(0, 90) }
        : { failed: false, result: JSON.stringify(changed.result ?? {}).slice(0, 180) };
    }
    report.afterReasoning = await readSession();

    if (report.targetModelId) {
      const changed = await request("session/setModel", { commandId: uuidv7(), sessionId, model: { modelId: report.targetModelId } });
      report.setModel = changed.error
        ? { failed: true, kind: changed.error.data?.kind ?? null, message: String(changed.error.message).slice(0, 90) }
        : { failed: false, result: JSON.stringify(changed.result ?? {}).slice(0, 220) };
    }
    report.afterModel = await readSession();

    await sleep(1_500);
    report.notifications = timeline.slice(atReasoning).map((entry) => ({
      atMs: entry.atMs,
      method: entry.method,
      excerpt: JSON.stringify(entry.params ?? {}).slice(0, 120),
    }));

    const changedModel = report.afterModel?.modelId !== report.before?.modelId;
    const reasoningVisible = report.afterReasoning?.reasoningEffort ?? report.afterReasoning?.effort;
    report.verdict = changedModel
      ? `the model change IS visible on the session (${report.before.modelId} → ${report.afterModel.modelId}) — no gap`
      : reasoningVisible
        ? `the effort change IS visible (${reasoningVisible}) — no gap on that side`
        : "neither change is visible on the session, and no notification reports it — the gap may be real";
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    child.kill();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
