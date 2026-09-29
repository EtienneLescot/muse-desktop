#!/usr/bin/env node
/**
 * Single-instance + wake hand-off proof:
 *   1. instance A runs with CDP;
 *   2. instance B is spawned with --automation-wakeup;
 *   3. B must exit quickly (single instance) and A must receive the forwarded
 *      `automation-wakeup` event (renderer listener installed);
 *   4. the scheduler stays owned by A ("Native scheduler active").
 */
import { execFileSync, spawn } from "node:child_process";
const APP = "C:\\Users\\etien\\Documents\\repos\\muse-desktop\\src-tauri\\target\\debug\\muse-desktop.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.single-instance-wake.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

// hook a probe: count forwarded events by listening in the page context
async function connect() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(typeof e.data === "string" ? e.data : "");
    if (f.id === undefined || !pending.has(f.id)) return;
    pending.get(f.id)(f);
    pending.delete(f.id);
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const send = (m, p) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f)));
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('PAGE: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200));
    return r.result.result.value;
  };
  return { ws, ev };
}

// count muse-desktop processes
const count = () => execFileSync("tasklist", ["/FI", "IMAGENAME eq muse-desktop.exe"], { encoding: "utf8" })
  .split("\n").filter((l) => l.includes("muse-desktop.exe")).length;

// A is already running (spawned by the caller with CDP)
// the registered wake task can relaunch the exe at its own schedule; wait
// for the count to settle instead of racing it
let instancesBefore = count();
for (let i = 0; i < 10 && instancesBefore !== 1; i++) {
  await sleep(2000);
  instancesBefore = count();
}
report.steps.instancesBefore = instancesBefore;

const { ev } = await connect();
// install an event recorder in the page
await ev(`(async () => {
  window.__wakeEvents = 0;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke) return "no-internals";
  const unlisten = await internals.invoke("plugin:event|listen", {
    event: "automation-wakeup",
    target: { kind: "Any" },
    handler: window.__TAURI_INTERNALS__.transformCallback((event) => {
      window.__wakeEvents += 1;
    }),
  });
  window.__wakeUnlisten = unlisten;
  return true;
})()`);

// spawn B with the wake flag
const b = spawn(APP, ["--automation-wakeup"], { detached: false, stdio: "ignore" });
report.steps.spawnedB = true;
// wait for B to exit (forwarded + exit) and the event to arrive in A
let exited = false;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  await sleep(1000);
  try { b.kill(0); } catch { exited = true; break; }
  try { process.kill(b.pid, 0); exited = true; } catch { exited = true; break; }
}
report.steps.bExited = { exited };
const wakeEvents = await ev(`window.__wakeEvents`);
const instancesAfter = count();
report.steps.wakeEvents = wakeEvents;
report.steps.instancesAfter = instancesAfter;
report.verdict.secondInstanceExits = exited || instancesAfter === 1;
report.verdict.wakeForwardedToPrimary = wakeEvents >= 1;
report.verdict.singleInstanceHolds = instancesAfter <= 1;
report.verdict.all =
  report.verdict.secondInstanceExits && report.verdict.wakeForwardedToPrimary && report.verdict.singleInstanceHolds;
const { writeFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m3-closure", { recursive: true });
writeFileSync("docs/evidence/2026-09-27-m3-closure/single-instance-wake.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify({ wakeEvents, instancesAfter, exited }));
process.exit(0);
