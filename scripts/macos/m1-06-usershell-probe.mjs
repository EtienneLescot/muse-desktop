#!/usr/bin/env node
/**
 * M1-06 side probe (macOS): which session/start shape makes the pinned
 * engine's `session/userShell` answer "managed shell sandbox is unavailable"?
 *
 * In the app, Run in Muse fails with that message (m1-06-terminal-context-macos
 * .json, check run-in-muse) while scripts/msp-user-shell-items.mjs, a bare host
 * started from a shell, runs the command. This probe starts the pinned engine
 * with the app's exact flags (serve --sandbox-network restricted
 * --trust-workspace), the app's initialize (clientInfo muse_desktop,
 * requestedCapabilities userShell + sessionMcp), then one fresh session per
 * variant of the app's session/start params, and runs `echo <marker>` through
 * session/userShell in each. No model turn.
 *
 *   node scripts/macos/m1-06-usershell-probe.mjs [--out docs/evidence/2026-10-13-macos-closure/m1-06-usershell-probe-macos.json]
 */
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { argValue, sleep } from "../cdp-harness.mjs";
import { DEFAULT_ENGINE, engineVersion } from "./test-instance.mjs";
import { platform, redactPaths } from "./m1-05-terminal-lib.mjs";

const WS = join(tmpdir(), "muse-proofs-g4", `usershell-${Date.now().toString(36)}`);
mkdirSync(WS, { recursive: true });
const WS_REAL = realpathSync(WS);
const uuidv7 = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const VARIANTS = [
  ["bare, temp path as given", { workspaceRoot: WS }],
  ["bare, canonical path (the app's form)", { workspaceRoot: WS_REAL }],
  ["approvalMode promptUnmatched (Ask for approval)", { workspaceRoot: WS_REAL, approvalMode: "promptUnmatched" }],
  ["approvalMode onRequest", { workspaceRoot: WS_REAL, approvalMode: "onRequest" }],
  ["approvalMode allowAll", { workspaceRoot: WS_REAL, approvalMode: "allowAll" }],
];

const HOSTS = [
  ["app's Workspace posture: serve --sandbox-network restricted --trust-workspace", ["serve", "--sandbox-network", "restricted", "--trust-workspace"], VARIANTS],
  ["app's Network posture: serve --sandbox-network enabled --trust-workspace", ["serve", "--sandbox-network", "enabled", "--trust-workspace"], VARIANTS.slice(2, 3)],
  ["app's Elevated posture: serve --disable-sandbox --sandbox-network enabled --trust-workspace", ["serve", "--disable-sandbox", "--sandbox-network", "enabled", "--trust-workspace"], VARIANTS.slice(2, 3)],
];

/** One host with `args`; each variant gets a fresh session and one userShell call. */
async function runHost(args, variants) {
  const child = spawn(DEFAULT_ENGINE, args, { cwd: WS, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } });
  const timeline = [];
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let f;
    try { f = JSON.parse(line); } catch { return; }
    if (f.id === undefined) { if (f.method) timeline.push(f); return; }
    const settle = pending.get(f.id);
    if (settle) { pending.delete(f.id); settle(f); }
  });
  const request = (method, params = {}, ms = 30_000) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method}: timeout` } }); } }, ms);
  });
  const results = {};
  try {
    const init = await request("initialize", { clientInfo: { name: "muse_desktop", version: "0.1.0" }, capabilities: { requestedCapabilities: ["userShell", "sessionMcp"] } });
    results.granted = init.result?.grantedCapabilities ?? null;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    await sleep(600);
    for (const [name, params] of variants) {
      const started = await request("session/start", { commandId: uuidv7(), ...params });
      const sessionId = started.result?.session?.sessionId ?? null;
      if (!sessionId) { results[name] = { start: String(started.error?.message ?? "no session").slice(0, 200) }; continue; }
      const marker = `USERSHELL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const from = timeline.length;
      const shell = await request("session/userShell", { sessionId, commandText: `echo ${marker}`, commandId: uuidv7() });
      await sleep(6_000);
      const after = JSON.stringify(timeline.slice(from));
      const completed = timeline.slice(from).filter((f) => f.method === "item/completed").map((f) => f.params?.item ?? f.params);
      const shellItem = completed.find((i) => /usershell/i.test(String(i?.kind ?? ""))) ?? null;
      results[name] = {
        approvalMode: started.result?.session?.approvalMode?.mode ?? null,
        userShell: shell.error ? `error: ${String(shell.error.message).slice(0, 160)}` : shell.result?.status ?? null,
        // The marker on a line of its own in the completed item: the command's
        // output, not the command text "echo <marker>".
        markerEchoed: String(shellItem?.visibleOutput ?? "").split("\n").some((l) => l.trim() === marker),
        sandboxUnavailable: after.includes("managed shell sandbox is unavailable"),
        status: shellItem?.status ?? null,
        visibleOutput: typeof shellItem?.visibleOutput === "string" ? shellItem.visibleOutput.slice(0, 160) : null,
      };
      console.error(`- ${args.join(" ")} | ${name}: ${JSON.stringify(results[name])}`);
    }
  } finally {
    child.kill();
  }
  return results;
}

const record = {
  schema: "muse-desktop.m1-06-usershell-probe-macos.v1",
  ticket: "M1-06",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: platform().replace(/; debug build.*$/, "; no app: the engine driven over MSP from node"),
  engine: engineVersion(),
  liveTurns: 0,
  harness: "scripts/macos/m1-06-usershell-probe.mjs",
  isolation: "Engine started from node with MUSE_NO_AUTO_UPDATE=1, cwd and workspace in a fresh temp folder. The engine's own session store is shared with the user (ADR 0003 limit): each variant adds one short session there.",
  method: "The app's three host postures (main.rs HostSandboxMode::cli_args, plus --trust-workspace) and its initialize; one fresh session per variant of session/start; `echo <marker>` through session/userShell; every notification for 6 s after the call is kept and searched for the marker and for the sandbox error.",
  checks: {},
  verdicts: {},
};
for (const [label, args, variants] of HOSTS) record.checks[label] = await runHost(args, variants);
const runsOf = (label) => Object.entries(record.checks[label]).filter(([k]) => k !== "granted").map(([, v]) => v);
record.verdicts.workspacePostureUserShellRuns = runsOf(HOSTS[0][0]).every((r) => r.markerEchoed);
record.verdicts.workspacePostureFailsLikeTheApp = runsOf(HOSTS[0][0]).every((r) => r.sandboxUnavailable);
record.verdicts.networkPostureUserShellRuns = runsOf(HOSTS[1][0]).every((r) => r.markerEchoed);
record.verdicts.elevatedPostureUserShellRuns = runsOf(HOSTS[2][0]).every((r) => r.markerEchoed);
const out = redactPaths([[WS, "<workspace>"]])(record);
const OUT = argValue("--out", null);
if (OUT) writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out.verdicts));
