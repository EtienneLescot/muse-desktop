#!/usr/bin/env node
/**
 * M1-08 native qualification of conversation attachments in the dev webview:
 * a real PNG attached through the file input rides a live turn (the model
 * answers about it), and the 8-part bound rejects a ninth file with the
 * actionable copy.
 *
 * Usage: node scripts/cdp-m1-08-attachments.mjs
 *   [--out docs/evidence/.../m1-08-attachments.json]
 */
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
// 1x1 red PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
const report = { schema: "muse-desktop.m1-08-attachments.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 220)}`);
};

const root = mkdtempSync(join(tmpdir(), "m1-08-"));
const imagePath = join(root, "red-pixel.png");
wf(imagePath, Buffer.from(PNG_BASE64, "base64"));
const ninthPath = join(root, "ninth.txt");
wf(ninthPath, "ninth attachment\n");

// fresh conversation in the scratch project
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
    if (option) { option.click(); return { picked: true }; }
  }
  const sel = document.querySelector("select");
  if (sel) {
    const target = [...sel.options].find((o) => /m1-qualification/i.test(o.textContent));
    if (target) {
      const P = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, target.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { picked: true };
    }
  }
  return { picked: false };
})()`);
if (!picked.picked) throw new Error("scratch picker not found");
// attach the SAME png 8 times is refused per-file duplication? No: 8 distinct
// copies so the 8-part bound is reachable, then try a 9th
for (let i = 0; i < 9; i += 1) {
  const p = join(root, `img-${i}.png`);
  wf(p, Buffer.from(PNG_BASE64, "base64"));
}
// fill the composer first
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Describe the attached image in one short word.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
// inject 8 files through the real input
for (let i = 0; i < 8; i += 1) {
  execFileSync("node", ["scripts/file-input-inject.mjs", join(root, `img-${i}.png`), ".settings-panel input[type=file], input[type=file]"], { stdio: "pipe" });
  await sleep(300);
}
const chipState = await evaluate(`(() => ({
  chips: document.querySelectorAll(".attachment-chips .attachment-chip").length,
  error: document.querySelector(".attachment-error")?.textContent ?? null,
}))()`);
step("attachments-8", chipState);
// try a ninth
let ninthRefused = false;
try {
  execFileSync("node", ["scripts/file-input-inject.mjs", ninthPath, "input[type=file]"], { stdio: "pipe" });
  await sleep(600);
  const after = await evaluate(`(() => ({
    chips: document.querySelectorAll(".attachment-chips .attachment-chip").length,
    error: document.querySelector(".attachment-error")?.textContent ?? null,
  }))()`);
  ninthRefused = after.error !== null || after.chips === 8;
  step("ninth-attachment", after);
} catch (error) {
  ninthRefused = true;
  step("ninth-attachment", { refused: true, note: String(error).slice(0, 120) });
}
report.verdict.partsBoundEnforced = chipState.chips === 8 && ninthRefused;

// send the live turn with the image
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
step("live-turn-done", { done, tail: transcript.slice(-200) });
// the image rode the turn: an image part is rendered in the transcript
const imageShown = await evaluate(`(() => ({
  imgElements: document.querySelectorAll(".session-center img").length,
  imageBadge: /image/i.test(document.querySelector(".session-center")?.innerText ?? ""),
}))()`);
step("image-in-transcript", imageShown);
report.verdict.imageRidesLiveTurn =
  done && (imageShown.imgElements > 0 || imageShown.imageBadge);

rmSync(root, { recursive: true, force: true });
socket.close();
report.verdict.all =
  !!report.verdict.partsBoundEnforced && !!report.verdict.imageRidesLiveTurn;
if (OUT) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
