#!/usr/bin/env node
/**
 * M4-03: browser driving on a REAL page — open a test page in Edge (a browser
 * the CUA driver recognizes), then a live turn asks the model to call
 * get_browser_state; the driver should bind to the real browser and the model
 * reports the page title it observed.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1. test page as a real file (Edge blocks command-line data: URLs)
const targetPath = join(tmpdir(), "m4-03-edge-target.html");
wf(targetPath, `<!doctype html><html><head><title>M4-03 Drive Target</title></head>
<body><h1>M4-03 EDGE DRIVE PAGE</h1><p>Computer-use driving target.</p></body></html>
`, "utf8");
const targetUrl = `file:///${targetPath.replace(/\\/g, "/")}`;

// 2. open it in Edge (recognized browser process)
const edgePaths = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
let edge = null;
for (const p of edgePaths) {
  try {
    execFileSync(p, ["--new-window", targetUrl], { stdio: "ignore" });
    edge = p;
    break;
  } catch {}
}
if (edge === null) throw new Error("Edge not found");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);

// 3. drive the app via CDP
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
// the muse-browser native window is a second tauri.localhost target; pick
// the MAIN app page (root URL — dev serves localhost:1420, prod tauri.localhost)
const page = list.find((t) => t.type === "page" && !t.url.includes("index.html")
  && /^(http:\/\/localhost:1420|http:\/\/tauri\.localhost)/.test(t.url)
  && t.webSocketDebuggerUrl);
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

const report = {
  schema: "muse-desktop.m4-03-edge-drive.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), CUA driver 0.28.2",
  steps: { edgePage: { path: edge, url: targetUrl } },
  verdict: {},
};

await ev(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation");
  nav?.click();
})()`);
await sleep(2500);
// computer-use MCP entry is host-global (settings mcpServers) — no project pick
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Use the computer-use browser tool get_browser_state on the open Microsoft Edge window and tell me the page title it shows. Answer with the page title only.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);

const deadline = Date.now() + 300_000;
let running = true;
let tail = "";
let sawBrowserTool = false;
let sawRefusal = false;
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-500),
      hasBrowserTool: /get_browser_state/i.test(t),
    };
  })()`);
  tail = s.tail.split(String.fromCharCode(10)).join(" | ");
  running = s.running;
  sawBrowserTool = sawBrowserTool || s.hasBrowserTool;
  sawRefusal = /not a recognized browser process/i.test(tail);
  if (!running && sawBrowserTool) break;
}
report.steps.turn = { running, sawBrowserTool, sawRefusal, tail: tail.slice(-380) };
report.verdict.getBrowserStateCalled = sawBrowserTool;
report.verdict.turnCompleted = !running;
// success = the driver bound to Edge and the model read the real page
report.verdict.bindingRefused = sawRefusal;
report.verdict.modelReportedPage = /M4-03 Drive Target|EDGE DRIVE PAGE/i.test(tail);
report.verdict.completeWorkflowOnRecognizedBrowser = !running && sawBrowserTool && !sawRefusal && report.verdict.modelReportedPage;

mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-03-edge-drive.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-160));
socket.close();
process.exit(0);
