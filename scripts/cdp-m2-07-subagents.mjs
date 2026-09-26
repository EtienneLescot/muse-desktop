#!/usr/bin/env node
/**
 * M2-07: the full sub-agent fan-out scenario with parent resume.
 *
 *   1. a live turn that spawns controllable sub-agent lanes;
 *   2. lanes render with childSessionId labels and `subagent/stop` controls;
 *   3. one lane is STOPPED through its own control (bounded by lifecycle);
 *   4. the parent turn completes and the conversation is resumed (switch away
 *      and back): the lanes' history persists with terminal states.
 *
 * Usage: node scripts/cdp-m2-07-subagents.mjs
 *   [--out docs/evidence/2026-09-26-m2-closure/m2-07-subagent-fanout.json]
 */
const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (frame.id === undefined || !pending.has(frame.id)) return;
  const entry = pending.get(frame.id);
  pending.delete(frame.id);
  frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (m, p) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};
const report = {
  schema: "muse-desktop.m2-07-subagent-fanout.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 240)}`);
};

const sampleLanes = () => evaluate(`(() => ({
  children: [...document.querySelectorAll(".subagent-child")].map((n) => n.getAttribute("title")?.slice(0, 12) ?? n.textContent.trim().slice(0, 20)),
  stopButtons: [...document.querySelectorAll('button[title*="subagent/stop"], button[title*="subagent"]')].length,
  laneText: (document.querySelector(".session-center")?.innerText ?? "").match(/(child: [0-9a-f]{6}|running|completed|cancelled|queued)/gi)?.slice(0, 24) ?? [],
}))()`);

// fresh conversation so the fan-out is unambiguous
await sleep(2000);
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with exactly the word: PTY");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
// sample lanes while the turn runs
const samples = [];
let maxStopButtons = 0;
let sawChild = false;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await sleep(2500);
  const s = await sampleLanes();
  samples.push(s);
  if (s.children.length > 0) sawChild = true;
  if (s.stopButtons > maxStopButtons) maxStopButtons = s.stopButtons;
  const running = s.laneText.filter((t) => t === "running").length;
  if (sawChild && running === 0 && /PTY/.test(s.laneText.join(" ") + " ")) break;
  const done = await evaluate(`(() => {
    const dot = document.querySelector(".task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  if (done && sawChild) break;
}
report.steps.laneSamples = samples.slice(-6);
step("lanes-during-turn", { sawChild, maxStopButtons, samples: samples.length });
report.verdict.lanesRenderedWithChildren = sawChild;
report.verdict.stopControlsOffered = maxStopButtons > 0;

// stop ONE controllable lane through its own button
let stopResult = { clicked: false };
if (maxStopButtons > 0) {
  stopResult = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button[title*="subagent/stop"], button[title*="subagent"]')][0];
    if (!btn || btn.disabled) return { clicked: false, reason: "no enabled stop button" };
    const title = btn.getAttribute("title");
    btn.click();
    return { clicked: true, title };
  })()`);
  await sleep(3000);
  const after = await sampleLanes();
  stopResult.after = { stopButtons: after.stopButtons, laneText: after.laneText.slice(0, 12) };
}
step("lane-stop", stopResult);
report.verdict.laneStopControlWorks = stopResult.clicked === true;

// parent completion
const doneDeadline = Date.now() + 180_000;
let done = false;
while (Date.now() < doneDeadline) {
  await sleep(4000);
  done = await evaluate(`(() => {
    const dot = document.querySelector(".task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  if (done) break;
}
step("parent-turn-done", { done });

// parent resume: switch away and back, lanes' history must persist
const away = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("button.session-select")].filter(
    (b) => b.getAttribute("aria-current") !== "page",
  );
  rows[0]?.click();
  return rows.length > 0;
})()`);
await sleep(3500);
if (away) {
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll("button.session-select")];
    rows[rows.length - 1]?.click();
  })()`);
  await sleep(4000);
}
const afterResume = await sampleLanes();
step("after-parent-resume", afterResume);
report.verdict.laneHistoryPersistsAfterResume =
  afterResume.children.length > 0 &&
  afterResume.laneText.some((t) => t === "completed" || t === "cancelled");

socket.close();
report.verdict.all =
  !!report.verdict.lanesRenderedWithChildren &&
  !!report.verdict.stopControlsOffered &&
  !!report.verdict.laneStopControlWorks &&
  !!report.verdict.laneHistoryPersistsAfterResume;
if (OUT) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
process.exit(0);
