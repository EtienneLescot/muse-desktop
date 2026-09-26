#!/usr/bin/env node
/**
 * One bounded experiment for M1-11's context tracking: a token-heavy INPUT
 * (a large filler prompt) on the active conversation, then watch for the
 * host's `session/contextUsage` push (the ContextMeter renders on arrival).
 * The host only emits on change; if nothing lands after the big turn, the
 * campaign records that host 1.3.0 emitted no context_usage here.
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

const report = { schema: "muse-desktop.m1-11-context-trigger.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const FILLER = "The lighthouse keeper wrote careful notes about the weather every single hour of every single day. ".repeat(290);

await sleep(1200);
const prompt = `${FILLER}\n\nReply with just the word OK and nothing else.`;
await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.focus()`);
await send("Input.insertText", { text: prompt });
await sleep(400);
const typed = await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.value?.length ?? 0`);
report.steps.typedChars = typed;
await evaluate(`document.querySelector('button[aria-label="Send message"]')?.click()`);
console.log("sent", typed, "chars; waiting for turn...");

const deadline = Date.now() + 240_000;
let done = false;
let ctx = null;
while (Date.now() < deadline) {
  await sleep(5000);
  done = await evaluate(`(() => {
    const dot = document.querySelector(".session-view .task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  ctx = await evaluate(`(() => {
    const meter = document.querySelector(".session-view .context-meter");
    return meter ? { present: true, trigger: meter.querySelector("summary")?.getAttribute("aria-label") ?? "" } : { present: false };
  })()`);
  if (done && ctx.present) break;
}
report.steps.turnSettled = done;
report.steps.contextMeter = ctx;
report.verdict.contextUsageEmitted = !!ctx?.present;
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report));
socket.close();
process.exit(0);
