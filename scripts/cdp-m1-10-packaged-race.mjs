#!/usr/bin/env node
/**
 * M1-10 removal race in the PACKAGED webview: first turn running, two turns
 * queued, then the removal race fired from inside the page (single evaluation,
 * 12 attempts @ 90 ms). No removed turn may ever start.
 */
import { writeFileSync } from "node:fs";

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

const report = {
  schema: "muse-desktop.m1-10-packaged-queue-race.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), packaged NSIS 0.1.0 webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const state = () => ev(`(() => ({
  working: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
  queueRows: document.querySelectorAll(".queued-turn").length,
  queueTexts: [...document.querySelectorAll(".queued-turn-text")].map((n) => n.textContent.slice(0, 40)),
}))()`);
const typeAndSend = async (text) => {
  await ev(`(() => {
    const area = document.querySelector('textarea[aria-label="Message Muse"]');
    const P = HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(area, ${JSON.stringify(text)});
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return 1;
  })()`);
  await sleep(300);
  await ev(`(() => { document.querySelector("button.send")?.click(); return 1; })()`);
};

// first turn: LONG enough that the queueing + removal race lands mid-turn
await typeAndSend("Count slowly from one to three hundred, one number per line. Take your time.");
await sleep(4000);
let s = await state();
if (!s.working) { await sleep(3000); s = await state(); }
report.steps.firstTurnRunning = s;
if (!s.working) throw new Error("first turn never started");
// queue two
await typeAndSend("RACE2-QUEUED-A-1131 say ALPHA");
await sleep(1500);
await typeAndSend("RACE2-QUEUED-B-7722 say BETA");
await sleep(2500);
s = await state();
report.steps.twoQueued = s;
if (s.queueRows < 2) throw new Error("queued turns not visible: " + JSON.stringify(s));
// THE RACE: 12 removal clicks from one in-page evaluation
const race = await ev(`(async () => {
  const click = () => {
    const button = [...document.querySelectorAll("button")].find((b) => /remove from queue/i.test(b.innerText || ""));
    if (!button) return false;
    button.click();
    return true;
  };
  const attempts = [];
  for (let i = 0; i < 12; i += 1) { attempts.push(click()); await new Promise((r) => setTimeout(r, 90)); }
  return { clicks: attempts.filter(Boolean).length, attempts: attempts.length };
})()`);
report.steps.race = race;
await sleep(2000);
report.steps.afterRace = await state();
// let the long first turn finish on its own (poll up to 4 min)
const settleDeadline = Date.now() + 240_000;
while (Date.now() < settleDeadline) {
  await sleep(5000);
  report.steps.settled = await state();
  if (!report.steps.settled.working) break;
}
report.steps.settledTranscriptTail = (
  await ev(`(() => (document.querySelector(".session-center")?.innerText ?? "").slice(-400))()`)
).replace(/\n/g, "|");
// verdicts: the queue emptied while the first turn still ran; the removed
// turns' replies (ALPHA/BETA answers) never appear even after settling
report.verdict.queueEmptiedWhileFirstStillRunning =
  report.steps.afterRace.queueRows === 0 && report.steps.afterRace.working === true;
const tail = report.steps.settledTranscriptTail;
report.verdict.removedTurnsNeverAnswered = !/ALPHA(?!-)/.test(tail) && !/BETA(?!-)/.test(tail);
report.verdict.firstTurnCarriedOn = report.steps.settled.working === false && report.steps.settled.queueRows === 0;
report.verdict.all =
  !!report.verdict.queueEmptiedWhileFirstStillRunning &&
  !!report.verdict.removedTurnsNeverAnswered &&
  !!report.verdict.firstTurnCarriedOn;
writeFileSync("docs/evidence/2026-09-26-m1-closure/m1-10-packaged-queue-race.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict));
socket.close();
process.exit(0);
