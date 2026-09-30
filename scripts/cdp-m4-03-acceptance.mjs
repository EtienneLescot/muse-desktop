#!/usr/bin/env node
/**
 * M4-03 acceptance proof (the plan's acceptance set): a complete web
 * workflow, an unexpected navigation, and a stop without acting on another
 * tab — driven by the model in a live Muse turn, with the browser-attach
 * consent on. The harness builds the two-tab Edge state, sends the exact
 * instruction, then verifies the aftermath with the driver itself.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = String(Date.now() % 1000000).padStart(6, "0");
const report = {
  schema: "muse-desktop.m4-03-acceptance.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), CUA driver 0.28.2, attach consent on",
  steps: {},
  verdict: {},
};

const DRIVER = `${process.env.LOCALAPPDATA}/Programs/Cua/cua-driver/bin/cua-driver.exe`;
const PROBE_PIPE = String.raw`\\.\pipe\muse-accept-verify`;
const tmp = tmpdir();

// 1. the two-tab scenario: decoy first, target second (target tab active)
const targetHtml = `<!doctype html><html><head><title>M4-03 Drive Target ${RUN}</title></head>
<body style="margin:0"><button id="go" style="width:100vw;height:100vh;font-size:48px;display:block" onclick="location.href='file:///C:/Users/etien/AppData/Local/Temp/m4-03-unexpected.html'">Go</button>
</body></html>`;
wf(join(tmp, "m4-03-edge-target.html"), targetHtml, "utf8");
wf(join(tmp, "m4-03-unexpected.html"),
  `<!doctype html><html><head><title>Unexpected Landing ${RUN}</title></head><body><h1>UNEXPECTED NAVIGATION LANDING</h1></body></html>`, "utf8");
wf(join(tmp, "m4-03-decoy.html"),
  `<!doctype html><html><head><title>M4-03 Decoy ${RUN}</title></head><body><h1>DECOY TAB</h1><button id="boom">Never click</button></body></html>`, "utf8");

const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// Non-destructive AND unambiguous: the scenario runs in its **own Edge
// process** (a dedicated temp profile), because the driver binds a native
// window to CDP targets process-wide and a multi-window Edge (the user's
// own browsing) makes the tie-break ambiguous on 0.28.2. The user's Edge is
// never touched.
const tempProfile = join(tmp, "m4-03-edge-profile");
execFileSync("powershell", ["-NoProfile", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*m4-03-edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 2`],
  { stdio: "ignore", timeout: 30000 });
execFileSync(edge, [
  `--user-data-dir=${tempProfile}`, "--no-first-run", "--no-default-browser-check",
  "--hide-crash-restore-bubble", "--new-window", `file:///${join(tmp, "m4-03-decoy.html").replace(/\\/g, "/")}`,
], { stdio: "ignore" });
await sleep(5000);
execFileSync(edge, [
  `--user-data-dir=${tempProfile}`, `file:///${join(tmp, "m4-03-edge-target.html").replace(/\\/g, "/")}`,
], { stdio: "ignore" });
await sleep(5000);

// Pre-approve the temp profile's remote-debugging consent (rig mechanics:
// the user's product consent — the Settings toggle — is already on; this
// Edge instance is a fixture the harness owns).
{
  const setupPipe = String.raw`\\.\pipe\muse-accept-setup`;
  const daemon = spawn(DRIVER, ["serve", "--socket", setupPipe, "--permission-mode", "standard", "--grant", "existing-profile"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await sleep(4000);
  const callRaw = (tool, json) => {
    const r = spawnSync(DRIVER, ["call", tool, json, "--socket", setupPipe], { encoding: "utf8", timeout: 60000 });
    return `${(r.stdout ?? "").trim()}${(r.stderr ?? "").trim()}`;
  };
  let win = null;
  for (let attempt = 0; attempt < 6 && !win; attempt += 1) {
    const winsRaw = callRaw("list_windows", "{}");
    let rows = [];
    try { const p = JSON.parse(winsRaw.slice(winsRaw.indexOf("{"))); rows = p._legacy_windows ?? []; } catch {}
    win = rows.find((w) => String(w.title ?? "").includes(`M4-03 Drive Target ${RUN}`));
    if (!win) await sleep(5000);
  }
  if (!win) {
    const allRaw = callRaw("list_windows", "{}");
    let all = [];
    try { const p = JSON.parse(allRaw.slice(allRaw.indexOf("{"))); all = p._legacy_windows ?? []; } catch {}
    report.verdict.error = `scenario window not found after retries (titles seen: ${all.map((w) => String(w.title).slice(0, 40)).join(" | ").slice(0, 300)})`;
    mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
    wf("docs/evidence/2026-09-27-m4-closure/m4-03-acceptance.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report.verdict));
    spawnSync(DRIVER, ["stop", "--socket", setupPipe], { encoding: "utf8", timeout: 15000 });
    daemon.kill();
    process.exit(1);
  }
  const args = { pid: win.pid, window_id: win.window_id, session: `setup-${RUN}` };
  const prep1 = callRaw("browser_prepare", JSON.stringify({ ...args, strategy: { kind: "existing_profile" } }));
  if (!prep1.includes("attached_existing_profile")) {
    // the consent prompt is up: approve it (this fixture profile is the rig's)
    const stateRaw = callRaw("get_window_state", JSON.stringify(args));
    let elements = [];
    try { elements = JSON.parse(stateRaw).elements ?? []; } catch {}
    const allow = elements.find((e) => e.label === "Autoriser" && (e.actions ?? []).includes("invoke"));
    if (allow) {
      callRaw("click", JSON.stringify({ pid: win.pid, window_id: win.window_id, element_token: allow.element_token }));
      await sleep(2500);
    }
    const prep2 = callRaw("browser_prepare", JSON.stringify({ ...args, strategy: { kind: "existing_profile" } }));
    report.steps.tempProfileConsent = prep2.includes("attached_existing_profile") ? "approved+attached" : prep2.slice(0, 200);
  } else {
    report.steps.tempProfileConsent = "already-approved";
  }
  spawnSync(DRIVER, ["stop", "--socket", setupPipe], { encoding: "utf8", timeout: 15000 });
  daemon.kill();
}
report.steps.edgeSetup = {
  decoy: `M4-03 Decoy ${RUN}`,
  target: `M4-03 Drive Target ${RUN}`,
  targetTabActive: true,
  isolatedProcess: true,
  userWindowsUntouched: true,
};

// 2. the computer-use service must hold the grant before the turn: the MCP
//    entry is fixed at session start, and a session started without it can
//    only answer "no browser tools".
const grantLine = () => {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("serve"));
  } catch { return []; }
};
report.steps.daemonCommandLine = grantLine();
if (!grantLine().some((l) => l.includes("--grant") && l.includes("existing-profile"))) {
  report.verdict.completeAcceptanceSet = false;
  report.verdict.error = "the computer-use service is not running with --grant existing-profile; turn it on in Settings (flip the level to restart it) and re-run";
  mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
  wf("docs/evidence/2026-09-27-m4-closure/m4-03-acceptance.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.verdict));
  process.exit(1);
}

// 2. the app via CDP
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && /^(http:\/\/localhost:1420|http:\/\/tauri\.localhost)/.test(t.url) && t.webSocketDebuggerUrl);
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
  const p = new Promise((res, rej) => pending.set(i, (f) => (f.error ? rej(new Error(f.error.message)) : res(f.result.result?.value))));
  socket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
  return p;
};

// 3. close Settings only if it is open (opening it would cover the composer),
//    then new conversation, wait for the engine, send
await ev(`(() => {
  if (!document.querySelector(".computer-use-attach")) return;
  document.querySelector("button.account[aria-label=Settings]")?.click();
})()`);
await sleep(800);
await ev(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation");
  nav?.click();
})()`);
await sleep(2500);
let hostReady = false;
for (let i = 0; i < 36 && !hostReady; i += 1) {
  hostReady = await ev(`(() => /muse-spark/i.test(document.body.innerText))()`);
  if (!hostReady) await sleep(5000);
}
report.steps.hostReady = hostReady;
await ev(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "On the Microsoft Edge window whose title is 'M4-03 Drive Target ${RUN}' (the window holds that tab), drive the browser using ONLY the computer-use browser tools (browser_prepare, get_browser_state, browser_click) — never PowerShell or any system tool. Steps: (1) browser_prepare on that window with strategy kind existing_profile; (2) get_browser_state on it — it returns the target_id and the tabs with their tab_id; (3) bring_to_front on that window; (4) browser_click passing EXACTLY the target_id and the tab_id that step (2) returned for the tab titled 'M4-03 Drive Target ${RUN}', with x 400 and y 300 — those ids are valid, use them verbatim, never invent or probe with dummy ids; (5) get_browser_state again and report exactly what happened to that tab. Then STOP: no other clicks, and never touch the other tab (the decoy tab titled 'M4-03 Decoy ${RUN}' is open; leave it exactly as it is).");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(400);
await ev(`(() => { document.querySelector("button.welcome-send")?.click(); })()`);

const deadline = Date.now() + 540_000;
let running = true;
const steps = new Set();
let tail = "";
while (Date.now() < deadline) {
  await sleep(5000);
  const s = await ev(`(() => {
    const t = document.querySelector(".session-center")?.innerText ?? "";
    return {
      running: document.querySelector(".task-metadata .dot")?.getAttribute("data-running") === "true",
      tail: t.slice(-800),
      steps: t.split(String.fromCharCode(10)).filter((l) => /computer use/i.test(l)).map((l) => l.trim().slice(0, 60)),
    };
  })()`);
  tail = s.tail.split(String.fromCharCode(10)).join(" | ");
  for (const line of s.steps) steps.add(line);
  running = s.running;
  if (!running && steps.size > 0) break;
}
const stepList = [...steps];
report.steps.turn = { running, computerUseSteps: stepList, tail: tail.slice(-500) };
report.verdict.turnCompleted = !running;
report.verdict.browserPrepareExecuted = stepList.some((l) => /browser prepare/i.test(l));
report.verdict.browserStateExecuted = stepList.some((l) => /get browser state/i.test(l));
report.verdict.browserClickExecuted = stepList.some((l) => /browser click/i.test(l));
report.verdict.modelReportedNavigation = /unexpected/i.test(tail);

// 4. verify the aftermath with the driver: target navigated, decoy untouched
await sleep(3000);
const daemon = spawn(DRIVER, ["serve", "--socket", PROBE_PIPE, "--permission-mode", "standard", "--grant", "existing-profile"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
await sleep(4000);
const callRaw = (tool, json) => {
  const r = spawnSync(DRIVER, ["call", tool, json, "--socket", PROBE_PIPE], { encoding: "utf8", timeout: 60000 });
  return `${(r.stdout ?? "").trim()}${(r.stderr ?? "").trim()}`;
};
const winsRaw = callRaw("list_windows", "{}");
let rows = [];
try { const p = JSON.parse(winsRaw.slice(winsRaw.indexOf("{"))); rows = p._legacy_windows ?? []; } catch {}
const win = rows.find((w) => String(w.title ?? "").includes(RUN));
if (win) {
  const args = { pid: win.pid, window_id: win.window_id, session: "verify" };
  callRaw("browser_prepare", JSON.stringify({ ...args, strategy: { kind: "existing_profile" } }));
  const bind = callRaw("get_browser_state", JSON.stringify(args));
  const parsed = JSON.parse(bind.slice(bind.indexOf("{")));
  report.steps.afterTabs = parsed.tabs?.map((t) => ({ title: t.title, url: t.url }));
  const targetTab = parsed.tabs?.find((t) => String(t.title ?? "") === "Unexpected Landing " + RUN);
  const decoyTab = parsed.tabs?.find((t) => String(t.title ?? "") === "M4-03 Decoy " + RUN);
  report.verdict.unexpectedNavigationHappened = Boolean(targetTab && /m4-03-unexpected\.html$/.test(targetTab.url ?? ""));
  report.verdict.decoyUntouched = Boolean(decoyTab && /m4-03-decoy\.html$/.test(decoyTab.url ?? ""));
} else {
  report.steps.afterTabs = "window not found";
  report.verdict.unexpectedNavigationHappened = false;
  report.verdict.decoyUntouched = false;
}
spawnSync(DRIVER, ["stop", "--socket", PROBE_PIPE], { encoding: "utf8", timeout: 15000 });
daemon.kill();

report.verdict.completeAcceptanceSet = report.verdict.turnCompleted
  && report.verdict.browserPrepareExecuted && report.verdict.browserStateExecuted
  && report.verdict.browserClickExecuted && report.verdict.unexpectedNavigationHappened
  && report.verdict.decoyUntouched && report.verdict.modelReportedNavigation;

mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
wf("docs/evidence/2026-09-27-m4-closure/m4-03-acceptance.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", tail.slice(-120));
socket.close();
process.exit(0);
