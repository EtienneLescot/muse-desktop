#!/usr/bin/env node
/**
 * M1-06 native qualification of "Add output to prompt" (the last open
 * Windows criterion of the ticket): real PTY output flows into the composer
 * draft through the panel button, bounded to the 12,000-character fallback.
 *
 * Usage: node scripts/cdp-m1-06-add-output.mjs
 *   [--out docs/evidence/.../m1-06-add-output-prompt.json]
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
  schema: "muse-desktop.m1-06-add-output-prompt.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 200)}`);
};

// open a conversation, the work panel, the terminal tab (fresh PTY)
await sleep(1500);
const state = await evaluate(`(() => ({
  sessionView: !!document.querySelector("nav.work-tabs"),
  rows: document.querySelectorAll("button.session-select").length > 0,
}))()`);
if (!state.sessionView) {
  if (!state.rows) throw new Error("no conversation to open");
  await evaluate(`document.querySelector("button.session-select").click()`);
  await sleep(2500);
}
await evaluate(`(() => {
  if (document.querySelector("nav.work-tabs")) return "open";
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
const tab = await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((x) => x.textContent.trim() === "Terminal");
  b?.click();
  return !!b;
})()`);
if (!tab) throw new Error("Terminal tab not found");
const bannerDeadline = Date.now() + 30_000;
let output = "";
while (Date.now() < bannerDeadline) {
  output = await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
  if (output.trim().length > 0) break;
  await sleep(500);
}
step("terminal-ready", { banner: output.trim().length > 0 });

const runCommand = async (command, settleMs = 1200) => {
  await evaluate(`document.querySelector("form.terminal-input input").focus()`);
  await send("Input.insertText", { text: command });
  await sleep(120);
  await evaluate(`document.querySelector("form.terminal-input button[type=submit]").click()`);
  await sleep(settleMs);
  return await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
};
const composerText = async () =>
  (await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? ""`));

// --- 1. small, marker-bearing output -> composer
const MARKER = `M1-06-OUTPUT-VERSE-LE-PROMPT-${Date.now()}`;
await runCommand(`echo ${MARKER}`, 1200);
await evaluate(`document.querySelector("button.terminal-context").click()`);
let composed = "";
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  composed = await composerText();
  if (composed.includes(MARKER)) break;
  await sleep(400);
}
step("marker-in-composer", {
  marker: MARKER,
  found: composed.includes(MARKER),
  provenance: composed.includes("[Terminal output ·"),
  wrapped: composed.includes("<terminal-output>"),
  composerLength: composed.length,
});
report.verdict.markerFlowsToComposer =
  composed.includes(MARKER) && composed.includes("<terminal-output>") && composed.includes("[Terminal output ·");

// --- 2. oversized output -> the context block stays within the 12k fallback
const beforeBig = await evaluate(`document.querySelector("pre.terminal-output").innerText.length`);
await runCommand("for /l %i in (1,1,2500) do @echo LIGNE-%i-M1-06", 3500);
const bigOutput = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
step("big-output-generated", {
  generated: bigOutput.length > beforeBig,
  ptyOutputChars: bigOutput.length - beforeBig,
  lastLineVisible: bigOutput.includes("LIGNE-2500-M1-06"),
});
await evaluate(`document.querySelector("button.terminal-context").click()`);
await sleep(1000);
const composedBig = await composerText();
const block = composedBig.split("<terminal-output>").pop()?.split("</terminal-output>")[0] ?? "";
step("bounded-context-in-composer", {
  composerLength: composedBig.length,
  contextBlockChars: block.length,
  clippedTailKept: block.includes("LIGNE-2500-M1-06"),
  ellipsisPrefix: block.startsWith("…"),
});
report.verdict.boundedTo12000 =
  block.length <= 12_100 && block.length > 1_000 && block.includes("LIGNE-2500-M1-06");

socket.close();
report.verdict.all =
  !!report.verdict.markerFlowsToComposer && !!report.verdict.boundedTo12000;
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
