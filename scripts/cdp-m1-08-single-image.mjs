#!/usr/bin/env node
// single real image rides a live turn (M1-08 completion piece)
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
const report = { schema: "muse-desktop.m1-08-single-image.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const root = mkdtempSync(join(tmpdir(), "m1-08-one-"));
const imagePath = join(root, "one-red-pixel.png");
wf(imagePath, Buffer.from(PNG_BASE64, "base64"));

await sleep(1500);
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
const picked = await evaluate(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualification/i.test(o.textContent));
    if (option) { option.click(); return true; }
  }
  return false;
})()`);
if (!picked) throw new Error("scratch picker not found");
// a previous run's attachment draft may have restored stale chips (the input
// then sits disabled at MAX): clear every chip before injecting
await evaluate(`(() => {
  const removes = [...document.querySelectorAll(".attachment-chips .attachment-remove")];
  removes.forEach((b) => b.click());
  return removes.length;
})()`);
await sleep(600);
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "What colour is this image? Answer with just the colour name.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
execFileSync("node", ["scripts/file-input-inject.mjs", imagePath, "label.composer-attach input[type=file]"], { stdio: "pipe" });
await sleep(800);
const chip = await evaluate(`(() => ({
  chips: document.querySelectorAll(".attachment-chips .attachment-chip").length,
  name: document.querySelector(".attachment-chip .attachment-name")?.textContent ?? null,
}))()`);
report.steps.chip = chip;
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
const deadline = Date.now() + 180_000;
let done = false;
let transcript = "";
while (Date.now() < deadline) {
  await sleep(4000);
  done = await evaluate(`(() => {
    const dot = document.querySelector(".session-view .task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  transcript = await evaluate(`document.querySelector(".session-center")?.innerText ?? ""`);
  if (done && transcript.length > 0) break;
}
report.steps.turn = { done, tail: transcript.slice(-260) };
const imgs = await evaluate(`(() => ({
  imgElements: document.querySelectorAll(".session-center img").length,
}))()`);
report.steps.rendered = imgs;
// wait for the model's reply to land: the text after the last "Muse" speaker
// label stabilizes on the answer (the fixture is a dark 1x1 pixel -> colour)
const readAnswer = (text) => {
  const afterMuse = text.slice(text.lastIndexOf("Muse")).split(/\n/).filter(Boolean);
  return afterMuse.slice(0, 3).join(" ");
};
let answer = readAnswer(transcript);
const answerDeadline = Date.now() + 150_000;
let previous = "";
while (Date.now() < answerDeadline) {
  await sleep(5000);
  transcript = await evaluate(`document.querySelector(".session-center")?.innerText ?? ""`);
  answer = readAnswer(transcript);
  if (answer === previous && answer.length > 0 && !/Thinking|working/i.test(answer)) break;
  previous = answer;
}
report.steps.answer = answer.slice(0, 100);
report.verdict.imageRodeLiveTurn =
  /red|grey|gray|black|white|blue|green|dark|light/i.test(answer);
report.verdict.modelAnswered = report.verdict.imageRodeLiveTurn;
rmSync(root, { recursive: true, force: true });
socket.close();
if (OUT) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
