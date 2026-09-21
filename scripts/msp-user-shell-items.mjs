#!/usr/bin/env node

/**
 * Does `session/userShell` ever report its result?
 *
 * The gap report claims the host accepts `session/userShell` but never publishes
 * an item for it, so a client cannot show the command's output. That claim came
 * from `native-smoke.mjs`, which this campaign proved produces false negatives
 * (`docs/evidence/2026-09-20-windows-sessions/harness-faux-negatif.md`). It has
 * to be re-measured outside that harness before it is asserted to anyone.
 *
 * Method: record **every** notification from the moment the host starts, never
 * wait for a specific one. That is the shape that produced no false finding.
 *
 * Usage:
 *   node scripts/msp-user-shell-items.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
        timeline.push({ atMs: Date.now() - startedAt, method: frame.method, params: frame.params ?? null });
      }
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
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); }
      }, timeoutMs);
    });

  const report = { schema: "muse-desktop.msp-user-shell-items.v1" };
  try {
    const init = await request("initialize", {
      clientInfo: { name: "muse_user_shell_probe", version: "1.0.0" },
      schema: 1,
      // The capability key must be NESTED. This probe formerly sent
      // `capabilities: {}` plus a top-level `requestedCapabilities`, which the
      // host read as "no capabilities requested": it granted nothing, answered
      // the userShell call with `capabilityRequired`, and the run concluded
      // "no userShell item and no output anywhere". That verdict was published
      // as a blocking finding for M1-06 and sent people looking for a sidecar
      // gap. The application has always used the nested shape
      // (src-tauri/src/main.rs: `capabilities.requestedCapabilities`), which is
      // why the desktop grants userShell and this probe did not.
      capabilities: { requestedCapabilities: ["userShell"] },
    });
    report.durability = init.result?.sessionDurability ?? null;
    report.grantedCapabilities = init.result?.grantedCapabilities ?? null;
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await sleep(600);

    const started = await request("session/start", { workspaceRoot: WORKSPACE, commandId: uuidv7() });
    const sessionId = started.result?.session?.sessionId ?? started.result?.sessionId ?? null;
    report.sessionId = sessionId ? sessionId.slice(0, 8) : null;
    if (!sessionId) throw new Error(`session/start: ${JSON.stringify(started.error ?? started.result).slice(0, 160)}`);

    // A command that finishes, writes a witness file, and takes a few seconds so
    // a late item would still land inside the observation window.
    const marker = `muse-user-shell-${Date.now()}`;
    const witness = `${process.env.TEMP ?? "."}\\${marker}.txt`;
    const commandText = `node -e "setTimeout(()=>{require('fs').writeFileSync(String.raw\`${witness}\`,'ok');console.log('${marker}');},4000)"`;

    const atRequest = timeline.length;
    const shell = await request("session/userShell", { sessionId, commandText, commandId: uuidv7() }, 30_000);
    report.userShellRequest = shell.error
      ? { failed: true, kind: shell.error.data?.kind ?? null, message: String(shell.error.message).slice(0, 110) }
      : { failed: false, keys: Object.keys(shell.result ?? {}), result: JSON.stringify(shell.result ?? {}).slice(0, 220) };

    await sleep(OBSERVE_MS);

    const after = timeline.slice(atRequest);
    report.notificationsAfterRequest = after.map((entry) => ({
      atMs: entry.atMs,
      method: entry.method,
      kind: entry.params?.item?.kind ?? entry.params?.kind ?? null,
    }));
    report.distinctMethodsAfter = [...new Set(after.map((entry) => entry.method))];
    report.userShellItems = after.filter((entry) => {
      const kind = entry.params?.item?.kind ?? entry.params?.kind ?? null;
      return typeof kind === "string" && /usershell/i.test(kind);
    }).length;
    report.outputRefSeen = JSON.stringify(after).includes("outputRef");
    report.markerEchoed = JSON.stringify(after).includes(marker);

    const { existsSync } = await import("node:fs");
    report.witnessFileWritten = existsSync(witness);
    report.witnessPath = witness;
    report.observedMs = OBSERVE_MS;

    report.verdict = report.userShellItems > 0
      ? `the host DOES publish ${report.userShellItems} userShell item(s) — the gap report is wrong here`
      : report.markerEchoed
        ? "no userShell item, but the output appears somewhere in the notifications"
        : "no userShell item and no output anywhere — the gap is confirmed outside the suspect harness";
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    child.kill();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); process.exit(1); });
