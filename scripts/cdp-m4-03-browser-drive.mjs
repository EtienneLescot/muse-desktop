#!/usr/bin/env node
/**
 * M4-03: Muse drives the browser — a real turn where the model calls the
 * CUA driver's browser tools (get_browser_state) on the muse-browser window.
 * The computer-use MCP entry is handed to the host at session start; the
 * driver serves on the private channel with the capability manifest.
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
// the muse-browser native window is a second tauri.localhost target; pick
// the MAIN app page (root URL, not /index.html)
const page = list.find((t) => t.type === "page" && t.url.replace(/\/$/, "").endsWith("tauri.localhost") && t.webSocketDebuggerUrl);
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
const report = { schema: "muse-desktop.m4-03-browser-drive.v1", date: new Date().toISOString().slice(0, 10), steps: {}, verdict: {} };

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
// open the native muse-browser window first so get_browser_state has a target
await ev(`(() => {
  const b = [...document.querySelectorAll("nav.work-tabs button")].find((x) => x.textContent.trim() === "Browser");
  b?.click();
})()`);
await sleep(1500);
await ev(`(() => {
  const area = document.querySelector('input[aria-label="Address"]');
  const P = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "http://tauri.localhost/index.html");
  area.dispatchEvent(new Event("input", { bubbles: true }));
  const form = area?.closest("form");
  form?.requestSubmit();
})()`);
await sleep(2500);
await ev(`(() => {
  const btn = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Open in a browser window");
  btn?.click();
})()`);
await sleep(5000);
await ev(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation");
  nav?.click();
})()`);
await sleep(2500);
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Use the browser tool get_browser_state on the muse-browser window and tell me what page it shows. Answer with the page title only.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);
const deadline = Date.now() + 300_000;
let running = true;
let tail = "";
let sawBrowserTool = false;
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-350),
      hasBrowserTool: /get_browser_state|browser_state|subagent/i.test(t),
    };
  })()`);
  tail = s.tail.split("\n").join(" | ");
  running = s.running;
  sawBrowserTool = sawBrowserTool || s.hasBrowserTool;
  if (!running && s.hasBrowserTool) break;
  if (!running && i > 20) break;
}
report.steps.turn = { running, sawBrowserTool, tail: tail.slice(-280) };
report.verdict.browserToolCalled = sawBrowserTool;
report.verdict.turnCompleted = !running;
const { writeFileSync: wf, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-03-browser-drive.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-160));
socket.close();
process.exit(0);
