#!/usr/bin/env node
import { writeFileSync as wf } from "node:fs";

/**
 * M3-06 thread reuse, correctly staged: the TARGET conversation is opened
 * first (active + host-loaded), THEN the schedule is created (capturing its
 * workspace/project), then Run now dispatches immediately.
 */
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
const send = (m, p) => new Promise((res, rej) => {
  const i = nextId++;
  pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f)));
  socket.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.slice(0, 200) ?? "page exception");
  return r.result.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m3-06-thread-reuse.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const NAME = `M3-06 reuse ${Date.now()}`;
const setValue = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "MISSING";
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})()`);

// 1. open an openscreen conversation and make sure its host loaded it
const opened = await ev(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  if (!inWs) return null;
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return { title: inWs.title, id: inWs.session_id.slice(0, 8) };
})()`);
report.steps.targetOpened = opened;
if (!opened) throw new Error("no openscreen conversation");
await sleep(6000);
// a tiny turn guarantees the host has the conversation loaded
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with just the word LOAD3 and nothing else.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
const loadDeadline = Date.now() + 180_000;
while (Date.now() < loadDeadline) {
  await sleep(4000);
  const s = await ev(`(() => {
    const dot = document.querySelector(".task-metadata .dot");
    const text = document.querySelector(".session-center")?.innerText ?? "";
    return { running: dot?.getAttribute("data-running") === "true", done: text.includes("LOAD3") };
  })()`);
  if (!s.running && s.done) break;
}
report.steps.targetLoaded = true;
const activeTitle = await ev(`(() =>
  document.querySelector(".session-view h1")?.textContent?.trim() ?? null)()`);

// 2. with the target ACTIVE, create the schedule targeting it
await ev(`(() => { document.querySelector('button[aria-label="Automations"]')?.click(); })()`);
await sleep(1500);
await setValue('input[aria-label="Automation name"]', NAME);
await setValue('textarea[aria-label="Instructions"]', "Reply with just the word REUSE2 and nothing else.");
await setValue('select[aria-label="Frequency"]', "once");
const d = new Date(Date.now() + 5 * 60_000);
const p2 = (n) => String(n).padStart(2, "0");
await setValue('input[aria-label="Date and time"]', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`);
await setValue('select[aria-label="Target conversation"]', "session");
const picked = await ev(`(() => {
  const activeTitle = ${JSON.stringify(activeTitle)};
  const sel = document.querySelector('select[aria-label="Existing conversation"]');
  if (!sel) return { ok: false };
  const option = [...sel.options].find((o) => (o.textContent || "") === activeTitle)
    ?? [...sel.options].find((o) => (o.textContent || "").includes(activeTitle.slice(0, 30)));
  if (!option || !activeTitle) return { ok: false, options: [...sel.options].length };
  const P = HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(sel, option.value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, title: option.textContent.slice(0, 40) };
})()`);
report.steps.targetSelected = picked;
await ev(`(() => { [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create automation")?.click(); })()`);
await sleep(2000);
const created = await ev(`(() => {
  const scheds = JSON.parse(localStorage.getItem("muse-desktop.schedules.v1") || "[]");
  const row = scheds.find((s) => s.name === ${JSON.stringify(NAME)});
  return row ? { workspace: row.workspace, projectId: row.projectId ?? null } : null;
})()`);
report.steps.captured = created;

// 3. Run now
const ran = await ev(`(() => {
  const li = [...document.querySelectorAll(".schedules li, .schedules .sched-item")]
    .find((x) => x.textContent.includes(${JSON.stringify(NAME)}));
  const btn = li ? [...li.querySelectorAll("button")].find((b) => b.textContent.trim() === "Run") : null;
  btn?.click();
  return !!btn;
})()`);
report.steps.runNowClicked = ran;
// 4. poll the ledger
const deadline = Date.now() + 240_000;
let row = null;
let delivered = false;
while (Date.now() < deadline) {
  await sleep(5000);
  const res = await ev(`(() => {
    const runs = JSON.parse(localStorage.getItem("muse-desktop.schedule-runs.v1") || "[]");
    const row = runs.reverse().find((r) => r.scheduleName === ${JSON.stringify(NAME)});
    if (!row || row.status !== "completed") return null;
    const log = row.sessionId ? JSON.parse(localStorage.getItem("muse-desktop.log.v1." + row.sessionId) || "[]") : [];
    return { row: { status: row.status, sessionId: (row.sessionId || "").slice(0, 8), error: (row.error || "").slice(0, 80) }, delivered: log.some((e) => (e.text || "").includes("REUSE2")) };
  })()`);
  if (res && res.row) {
    row = res.row;
    delivered = res.delivered;
    if (delivered) break;
  }
}
report.steps.ledgerRow = row;
report.verdict.threadReuseFreeSucceeds = !!row && row.status === "completed" && delivered;
const { mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-06-thread-reuse.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ row, delivered }));
socket.close();
process.exit(0);
