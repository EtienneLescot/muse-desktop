#!/usr/bin/env node
/**
 * M1-11 native qualification: the model picker label follows each
 * conversation's effective model (in-app replay of the 97f9eb1 fix), the
 * choice persists across conversation switches, and the host-reported
 * context usage renders (ContextMeter) for the active conversation.
 *
 * Usage: node scripts/cdp-m1-11-model-context.mjs
 *   [--out docs/evidence/.../m1-11-model-context.json]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  frame.error ? entry.reject(new Error(`${entry.method}: ${frame.error.message}`)) : entry.resolve(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};

const report = {
  schema: "muse-desktop.m1-11-model-context.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 220)}`);
};

const openConversation = async (index) => {
  await evaluate(`(() => {
    const rows = document.querySelectorAll("button.session-select");
    rows[${index}]?.click();
  })()`);
  await sleep(2200);
};
const pickerState = async () =>
  evaluate(`(() => {
    const view = document.querySelector(".session-view");
    const control = view?.querySelector("details.model-control");
    if (!control) return { present: false };
    const summary = control.querySelector("summary");
    const options = Array.from(control.querySelectorAll("button.model-option")).map((b) => ({
      label: b.querySelector("strong")?.textContent ?? "",
      id: b.querySelector("small")?.textContent ?? "",
      selected: b.getAttribute("aria-selected") === "true",
    }));
    return {
      present: true,
      label: summary?.textContent.trim() ?? "",
      options,
    };
  })()`);
const contextState = async () =>
  evaluate(`(() => {
    const meter = document.querySelector(".session-view .context-meter");
    if (!meter) return { present: false };
    const summary = meter.querySelector("summary");
    const popoverText = meter.querySelector(".context-meter-popover")?.textContent ?? "";
    return {
      present: true,
      trigger: summary?.getAttribute("aria-label") ?? "",
      title: meter.querySelector(".context-meter-title")?.textContent ?? "",
      pressure: meter.getAttribute("data-pressure"),
      hasCompactButton: !!meter.querySelector("button"),
      popoverMentionsWindow: popoverText.includes("Context window"),
    };
  })()`);

await sleep(1500);
const boot = await evaluate(`(() => ({
  sessionView: !!document.querySelector("nav.work-tabs"),
  rows: document.querySelectorAll("button.session-select").length,
}))()`);
if (!boot.sessionView) {
  if (!boot.rows) throw new Error("no conversation to open");
  await evaluate(`document.querySelector("button.session-select").click()`);
  await sleep(2500);
}

// --- conversation A: baseline label + its selected option
await openConversation(0);
const stateA1 = await pickerState();
step("conversation-A-initial", stateA1);
if (!stateA1.present || stateA1.options.length < 2) throw new Error("model picker unavailable or has < 2 options");
const selectedA = stateA1.options.find((o) => o.selected);

/**
 * B must be LOADED in the host or `session/setModel` is cleanly rejected
 * ("conversation engine is unavailable"). One small turn loads it; the same
 * turn makes the host report context usage for the ContextMeter.
 */
const ensureTurnDone = async () => {
  const idle = await evaluate(`(() => {
    const dot = document.querySelector(".session-view .task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  if (!idle) return;
  await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.focus()`);
  await send("Input.insertText", { text: "Reply with just the word OK and nothing else." });
  await sleep(150);
  await evaluate(`document.querySelector('button[aria-label="Send message"]')?.click()`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const done = await evaluate(`(() => {
      const dot = document.querySelector(".session-view .task-metadata .dot");
      return dot?.getAttribute("data-running") !== "true";
    })()`);
    if (done) return;
  }
  throw new Error("turn did not settle in 120s");
};

// --- conversation B: load it, then switch its model
const bIndex = 1;
await openConversation(bIndex);
await ensureTurnDone();
await sleep(1500);
const stateB1 = await pickerState();
step("conversation-B-initial", stateB1);
if (!stateB1.present) throw new Error("picker missing on conversation B");
// choose a model different from B's current one (prefer one A does not use)
const target =
  stateB1.options.find((o) => !o.selected && o.label !== selectedA?.label) ??
  stateB1.options.find((o) => !o.selected);
if (!target) throw new Error("no alternative model to select");
await evaluate(`(() => {
  const control = document.querySelector(".session-view details.model-control");
  control?.setAttribute("open", "");
  const option = Array.from(control.querySelectorAll("button.model-option"))
    .find((b) => (b.querySelector("strong")?.textContent ?? "") === ${JSON.stringify(target.label)});
  option?.click();
  control?.removeAttribute("open");
})()`);
await sleep(2500);
const stateB2 = await pickerState();
step("conversation-B-after-switch", { expected: target.label, picker: stateB2 });

// --- back to A: its label must still be A's own model (the fix replay)
await openConversation(0);
const stateA2 = await pickerState();
step("conversation-A-revisited", { expected: selectedA?.label, picker: { label: stateA2.label, options: stateA2.options } });
report.verdict.labelFollowsConversation =
  stateA2.label === selectedA?.label && stateB2.label === target.label;

// --- back to B: the switched model persisted across the round trip
await openConversation(bIndex);
const stateB3 = await pickerState();
step("conversation-B-revisited", { expected: target.label, label: stateB3.label });
report.verdict.switchPersistsAcrossSwitches = stateB3.label === target.label;

// --- ContextMeter renders the host-reported occupancy (we are on B, which
// just ran a live turn, so `context_usage` has flowed)
let ctx = await contextState();
const ctxDeadline = Date.now() + 30_000;
while (!ctx.present && Date.now() < ctxDeadline) {
  await sleep(2000);
  ctx = await contextState();
}
step("context-meter", ctx);
report.verdict.contextUsageRendered =
  ctx.present && /Context \d+% used/.test(ctx.trigger ?? "") && ctx.popoverMentionsWindow === true;

socket.close();
report.verdict.all =
  !!report.verdict.labelFollowsConversation &&
  !!report.verdict.switchPersistsAcrossSwitches &&
  !!report.verdict.contextUsageRendered;
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
