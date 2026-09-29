#!/usr/bin/env node
/**
 * M4-04: a real turn where the model calls a computer_* tool.
 * Fresh conversation (the computer-use MCP entry is handed to the host at
 * session start), explicit instruction to call get_screen_size, then observe
 * the tool lane and the model's answer.
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost") && t.webSocketDebuggerUrl);
if (!page) throw new Error("main tauri.localhost page not found");
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
const report = { schema: "muse-desktop.m4-04-computer-turn.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

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
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Use the computer-use tool get_screen_size right now, then report the exact screen dimensions it returned.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);
// poll the transcript for a computer tool lane and the final answer
const deadline = Date.now() + 240_000;
let tail = "";
let running = true;
let sawComputerTool = false;
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-350),
      hasComputerTool: /get_screen_size|computer_use|computer\\./i.test(t),
    };
  })()`);
  tail = s.tail.split("\n").join(" | ");
  running = s.running;
  sawComputerTool = sawComputerTool || s.hasComputerTool;
  if (!running && s.hasComputerTool) break;
}
report.steps.turn = { running, sawComputerTool, tail: tail.slice(-280) };
report.verdict.computerToolCalled = sawComputerTool;
report.verdict.turnCompleted = !running;
const { writeFileSync: wf, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-04-computer-turn.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-160));
socket.close();
process.exit(0);
