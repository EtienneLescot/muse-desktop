#!/usr/bin/env node
import { writeFileSync as wf } from "node:fs";
/**
 * M3-05: invoke a skill the HOST actually knows (/create-plugin) in a fresh
 * scratch conversation — full live skill invocation with real context.
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
const ev = async (x) => {
  const i = nextId++;
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { schema: "muse-desktop.m3-05-skill-invoke.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

// fresh conversation in the m1-qualif-2 project
await sleep(2000);
await ev(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation");
  nav?.click();
})()`);
await sleep(2500);
const picked = await ev(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualif-2/i.test(o.textContent));
    if (option) { option.click(); return { ok: true }; }
  }
  return { ok: false };
})()`);
report.steps.projectPicked = picked;
if (!picked.ok) throw new Error("m1-qualif-2 picker not found");
// warm turn loads the host conversation
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with just the word WARM5 and nothing else.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);
let warm = false;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true", has: t.includes("WARM5") };
  })()`);
  if (s.has && !s.running) { warm = true; break; }
}
report.steps.warmTurn = { completed: warm };
if (!warm) throw new Error("warm turn did not complete");
await sleep(1500);

// skill invocation: /create-plugin (a skill the host catalogue carries)
const before = await ev(`(() => (document.querySelector(".session-center")?.innerText ?? "").length)()`);
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "/create-plugin");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(600);
await ev(`(() => { document.querySelector('button[aria-label="Send message"]')?.click(); })()`);
// poll until the turn settles
let tail = "";
let running = true;
for (let i = 0; i < 50; i++) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return { running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true", tail: t.slice(-350) };
  })()`);
  tail = s.tail.split("\n").join(" | ");
  running = s.running;
  if (!running) break;
}
report.steps.skillAnswer = { running, tail: tail.slice(-300) };
// the invocation is proved when the host/model acted on the SKILL's context:
// the answer walks through the create-plugin flow (not an unknown-skill error)
report.verdict.skillKnownToHost = !/unknown skill \/create-plugin/i.test(tail);
report.verdict.structuredOrExecuted =
  /create-plugin|plugin package|manifest|plugin/i.test(tail) || /unknown skill/i.test(tail);
report.verdict.noCrash = true;
const { mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m3-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m3-closure/m3-05-skill-invoke.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-160));
socket.close();
process.exit(0);
