#!/usr/bin/env node
/**
 * M4-03 attach proof (after the product decision of 29/09/2026): turn on the
 * dedicated "Attach the user's browser" consent in Settings, let the service
 * restart with `--grant existing-profile` (its command line is read back from
 * the process), then a live turn calls get_browser_state on the Edge window
 * holding the real test page. The driver must bind — no `browser_consent_required`.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  schema: "muse-desktop.m4-03-attach-proof.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), CUA driver 0.28.2",
  steps: {},
  verdict: {},
};

// 1. the real test page in Edge (a recognized browser)
const targetPath = join(tmpdir(), "m4-03-edge-target.html");
if (!rf(targetPath, "utf8").includes("M4-03 Drive Target")) {
  wf(targetPath, `<!doctype html><html><head><title>M4-03 Drive Target</title></head>
<body><h1>M4-03 EDGE DRIVE PAGE</h1><p>Computer-use driving target.</p></body></html>
`, "utf8");
}
const targetUrl = `file:///${targetPath.replace(/\\/g, "/")}`;
const edgePaths = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
// A previous run may have left the target window open: reuse it rather than
// piling up same-titled windows (the driver refuses an ambiguous bind).
const alreadyOpen = (() => {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `
Add-Type '
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> Titles() {
    var titles = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      titles.Add(sb.ToString());
      return true;
    }, IntPtr.Zero);
    return titles;
  }
}';
if ([WinEnum]::Titles() | Where-Object { $_ -like '*M4-03 Drive Target*' } | Select-Object -First 1) { 'yes' } else { 'no' }
`], { encoding: "utf8", timeout: 30000 });
    return out.trim().toLowerCase() === "yes";
  } catch { return false; }
})();
let edge = null;
if (!alreadyOpen) {
  for (const p of edgePaths) {
    try {
      execFileSync(p, ["--new-window", targetUrl], { stdio: "ignore" });
      edge = p;
      break;
    } catch {}
  }
  if (edge === null) throw new Error("Edge not found");
} else {
  edge = "already-open";
}
report.steps.edgePage = { path: edge, url: targetUrl, reusedWindow: alreadyOpen };
await sleep(5000);

// 2. the app via CDP
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

// 3. Settings → Computer use: level "act", then the dedicated attach toggle
await ev(`(() => { document.querySelector('button.account[aria-label=Settings]')?.click(); })()`);
await sleep(1500);
await ev(`(() => { document.querySelector('input[name=computer-use-level][value=act]')?.click(); })()`);
await sleep(6000);
const afterLevel = await ev(`(() => {
  const s = document.querySelector(".computer-use-state")?.textContent?.trim() ?? "";
  const c = document.querySelector(".computer-use-attach input");
  return { state: s, attachChecked: c ? c.checked : null, attachFound: c !== null };
})()`);
report.steps.afterLevel = afterLevel;
// idempotent: only click when the consent is not already recorded
if (afterLevel.attachChecked !== true) {
  await ev(`(() => { document.querySelector('.computer-use-attach input')?.click(); })()`);
}
// set_attach writes the consent then restarts the daemon — poll until the UI
// reflects it (enable waits for the service, up to ~30 s)
let afterToggle = { state: "", attachChecked: null };
for (let i = 0; i < 24; i += 1) {
  await sleep(5000);
  afterToggle = await ev(`(() => {
    const s = document.querySelector(".computer-use-state")?.textContent?.trim() ?? "";
    const c = document.querySelector(".computer-use-attach input");
    return { state: s, attachChecked: c ? c.checked : null };
  })()`);
  if (afterToggle.attachChecked === true) break;
}
report.steps.afterToggle = afterToggle;
report.verdict.consentRecorded = afterToggle.attachChecked === true;

// 4. the daemon's own command line — the grant is visible on the process, not
//    claimed in prose
let commandLine = [];
for (let i = 0; i < 12; i += 1) {
  commandLine = (() => {
    try {
      const out = execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | Select-Object -ExpandProperty CommandLine",
      ], { encoding: "utf8" });
      return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("serve"));
    } catch (error) {
      return [`probe failed: ${error.message}`];
    }
  })();
  if (commandLine.some((l) => l.includes("--grant") && l.includes("existing-profile"))) break;
  await sleep(5000);
}
report.steps.daemonCommandLine = commandLine;
report.verdict.grantFlagOnProcess = commandLine.some((l) => l.includes("--grant") && l.includes("existing-profile"));

// 5. a fresh conversation (the MCP entry is fixed at session start) with the
//    exact tool prescribed
// Close Settings if the toggle steps left it open: the welcome composer sits
// under that panel, and a send fired while it is up never reaches the host.
await ev(`(() => { document.querySelector("button.account[aria-label=Settings]")?.click(); })()`);
await sleep(800);
await ev(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation");
  nav?.click();
})()`);
await sleep(2500);
// Wait for the engine: the composer's model list is engine-derived, and a
// message sent before the host answers is queued as "unsent" instead of run.
let hostReady = false;
for (let i = 0; i < 36 && !hostReady; i += 1) {
  hostReady = await ev(`(() => /muse-spark/i.test(document.body.innerText))()`);
  if (!hostReady) await sleep(5000);
}
report.steps.hostReady = hostReady;
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Call the computer-use tools named exactly browser_prepare and then get_browser_state on the Microsoft Edge window whose tab shows the M4-03 Drive Target page (its title starts with 'M4-03 Drive Target'): first browser_prepare for that window with strategy kind existing_profile, then get_browser_state on the same window, and report the page title from the result. If a call is refused, quote the refusal verbatim.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);

const deadline = Date.now() + 300_000;
let running = true;
let tail = "";
const steps = new Set();
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-600),
      steps: t.split(String.fromCharCode(10)).filter((l) => /computer use/i.test(l)).map((l) => l.trim().slice(0, 60)),
    };
  })()`);
  tail = s.tail.split(String.fromCharCode(10)).join(" | ");
  for (const line of s.steps) steps.add(line);
  running = s.running;
  if (!running && steps.size > 0) break;
}
const stepList = [...steps];
report.steps.turn = { running, computerUseSteps: stepList, tail: tail.slice(-420) };
report.verdict.turnCompleted = !running;
report.verdict.browserPrepareExecuted = stepList.some((l) => /browser prepare/i.test(l));
report.verdict.getBrowserStateExecuted = stepList.some((l) => /get browser state/i.test(l));
report.verdict.bindingRefused = /not a recognized browser process|browser_consent_required/i.test(tail);
report.verdict.modelReportedPage = /M4-03 Drive Target|EDGE DRIVE PAGE/i.test(tail);
report.verdict.completeWorkflowOnRecognizedBrowser = !running && report.verdict.browserPrepareExecuted
  && report.verdict.getBrowserStateExecuted
  && !report.verdict.bindingRefused && report.verdict.modelReportedPage && report.verdict.grantFlagOnProcess;

mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-03-attach-proof.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-150));
socket.close();
process.exit(0);
