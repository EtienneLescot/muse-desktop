#!/usr/bin/env node
/**
 * M4-03 follow-up: prescribe the exact tool — a live turn asking the model to
 * call get_browser_state (the driver's read-only browser inspection) on the
 * open Edge window. Edge already holds the real test page from the previous
 * harness run; this proves the driver's browser tool binds to a RECOGNIZED
 * browser holding a real page (the muse-browser WebView2 refusal is the
 * counter-case recorded in m4-03-browser-drive.json).
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  schema: "muse-desktop.m4-03-edge-browser-state.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), CUA driver 0.28.2",
  steps: {},
  verdict: {},
};

// Edge must still hold the test page; if the window was closed, reopen it
const edgePaths = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const { execFileSync } = await import("node:child_process");
for (const p of edgePaths) {
  try {
    execFileSync(p, ["--new-window", `file:///${"C:/Users/etien/AppData/Local/Temp/m4-03-edge-target.html".replace(/\\/g, "/")}`], { stdio: "ignore" });
    report.steps.edgeReopened = { path: p };
    break;
  } catch {}
}
await sleep(4000);

// follow-up turn in the still-open conversation
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Now call the tool named exactly get_browser_state (read-only browser inspection) on the open Microsoft Edge window. Report the page title from its result. If the driver refuses the call, quote the refusal verbatim.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
})()`);

const deadline = Date.now() + 300_000;
let running = true;
let tail = "";
let steps = [];
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    const lines = t.split(String.fromCharCode(10));
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-600),
      steps: lines.filter((l) => /computer use/i.test(l)).map((l) => l.trim().slice(0, 60)),
    };
  })()`);
  tail = s.tail.split(String.fromCharCode(10)).join(" | ");
  running = s.running;
  steps = s.steps;
  if (!running) break;
}
report.steps.turn = { running, computerUseSteps: [...new Set(steps)], tail: tail.slice(-420) };
report.verdict.turnCompleted = !running;
report.verdict.getBrowserStateToolInSteps = steps.some((l) => /get browser state/i.test(l));
report.verdict.bindingRefused = /not a recognized browser process/i.test(tail);
report.verdict.modelReportedPage = /M4-03 Drive Target|EDGE DRIVE PAGE/i.test(tail);
report.verdict.browserToolBoundToRecognizedBrowser = !running && report.verdict.getBrowserStateToolInSteps && !report.verdict.bindingRefused;

const { writeFileSync: wf } = await import("node:fs");
wf("docs/evidence/2026-09-27-m4-closure/m4-03-edge-browser-state.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-150));
socket.close();
process.exit(0);
