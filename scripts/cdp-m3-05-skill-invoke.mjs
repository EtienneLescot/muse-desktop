#!/usr/bin/env node
/**
 * M3-05: send "/qualif-skill confirm the resource" through the composer to
 * the live host; the host's answer decides (skill executed or structured
 * refusal), no crash, no partial send.
 */
import { writeFileSync as wf, mkdirSync as mkd } from "node:fs";

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
const report = { schema: "muse-desktop.m3-05-skill-invoke.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

await ev(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("openscreen"));
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === inWs.title);
  row?.click();
  return !!row;
})()`);
await sleep(4000);
// warm-up: after a host restart the conversation is not loaded; a plain turn
// loads it (otherwise the skill part hits "restore the conversation first")
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with just the word WARM3 and nothing else.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(600);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
const warmDeadline = Date.now() + 180_000;
let warmSawRunning = false;
while (Date.now() < warmDeadline) {
  await sleep(4000);
  const s = await ev(`(() => ({
    running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
    text: document.querySelector(".session-center")?.innerText ?? "",
  }))()`);
  if (s.running) warmSawRunning = true;
  if (warmSawRunning && !s.running && s.text.includes("WARM3")) break;
}
report.steps.warmup = { sawRunning: warmSawRunning };
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "/qualif-skill confirm the resource please");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(600);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
const deadline = Date.now() + 180_000;
let tail = "";
let running = true;
while (Date.now() < deadline) {
  await sleep(4000);
  running = await ev(`(() => document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true" || false)()`);
  tail = await ev(`(() => (document.querySelector(".session-center")?.innerText ?? "").slice(-400).split(String.fromCharCode(10)).join(" | "))()`);
  if (!running && tail.length > 0) break;
}
report.steps.turn = { running, tail: tail.slice(-300) };
report.verdict.hostAnswered = !running;
report.verdict.skillPath =
  /QUALIF-SKILL-OK|qualif/i.test(tail) || /unknown skill/i.test(tail) || /skill/i.test(tail);
report.verdict.noCrash = !running;
mkd("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-05-skill-invoke.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ tail: tail.slice(-200) }));
socket.close();
process.exit(0);
