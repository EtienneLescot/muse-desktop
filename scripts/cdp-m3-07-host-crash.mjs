#!/usr/bin/env node
import { writeFileSync as wf } from "node:fs";

/**
 * M3-07: host crash during a scheduled run — the muse.exe host is killed
 * mid-run; the run must settle honestly (retry or review) instead of staying
 * "running" forever.
 */
import { execFileSync } from "node:child_process";
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined || !pending.has(f.id)) return;
  pending.get(f.id)(f);
  pending.delete(f.id);
});
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
const ev = async (x) => {
  const i = nextId++;
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m3-07-host-crash.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const NAME = `M3-07 hostcrash ${Date.now()}`;
const setValue = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "MISSING";
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})()`);

await ev(`(() => { document.querySelector('button[aria-label="Automations"]')?.click(); })()`);
await sleep(1500);
await setValue('input[aria-label="Automation name"]', NAME);
await setValue('textarea[aria-label="Instructions"]', "Count slowly from 1 to 100, one number per line. Take your time.");
await setValue('select[aria-label="Frequency"]', "once");
const d = new Date(Date.now() + 3 * 60_000);
const p2 = (n) => String(n).padStart(2, "0");
await setValue('input[aria-label="Date and time"]', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`);
await setValue('select[aria-label="Target conversation"]', "session");
const TARGET = "01a0da8f-15d5-7842-a5b4-c05b5c1f9801";
const picked = await ev(`(() => {
  const sel = document.querySelector('select[aria-label="Existing conversation"]');
  if (!sel) return { ok: false, reason: "no select" };
  const option = [...sel.options].find((o) => (o.value || "") === "01a0da8f-15d5-7842-a5b4-c05b5c1f9801");
  if (!option) return { ok: false, reason: "target not listed" };
  const P = HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(sel, option.value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
})()`);
report.steps.targetSelected = picked;
if (!picked.ok) throw new Error("target session not selectable: " + JSON.stringify(picked));
await ev(`(() => { [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create automation")?.click(); })()`);
await sleep(2000);
// wait for the run to be running
const deadline = Date.now() + 8 * 60_000;
let running = false;
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const runs = JSON.parse(localStorage.getItem("muse-desktop.schedule-runs.v1") || "[]");
    const row = runs.reverse().find((r) => r.scheduleName === ${JSON.stringify(NAME)});
    return row ? { status: row.status } : null;
  })()`);
  if (s && s.status === "running") { running = true; break; }
  if (s && (s.status === "completed" || s.status === "failed")) break;
}
report.steps.runRunning = { running };
if (running) {
  // CRASH: kill the muse.exe host mid-run
  execFileSync("taskkill", ["/F", "/IM", "muse.exe"], { stdio: "pipe" });
  report.steps.hostKilled = true;
  // wait for the run to settle honestly (failed/retry/queued — never stuck running)
  const settleDeadline = Date.now() + 180_000;
  let settled = null;
  while (Date.now() < settleDeadline) {
    await sleep(5000);
    const s = await ev(`(() => {
      const runs = JSON.parse(localStorage.getItem("muse-desktop.schedule-runs.v1") || "[]");
      const row = runs.reverse().find((r) => r.scheduleName === ${JSON.stringify(NAME)});
      return row ? { status: row.status, error: (row.error || "").slice(0, 90), attempt: row.attempt ?? 1, nextRetryAt: row.nextRetryAt ?? null, recovery: row.recovery ?? null } : null;
    })()`);
    if (s && s.status !== "running") { settled = s; break; }
    // also capture the still-running row once for the record
    if (s && settled === null) settled = s;
  }
  report.steps.postCrashSettled = settled;
  report.verdict.hostCrashSettlesRun = settled !== null && settled.status !== "running";
}
const { mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-07-host-crash.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", JSON.stringify(report.steps.postCrashSettled ?? report.steps.runRunning));
socket.close();
process.exit(0);
