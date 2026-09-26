#!/usr/bin/env node
/**
 * M1-05 native terminal qualification through the CDP-enabled dev build.
 *
 * Drives, from the real webview and a real PTY (portable-pty 0.8.1):
 *   1. baseline PTY geometry (`mode con`) vs the panel's own size label;
 *   2. window resize -> the ResizeObserver path resizes the PTY (`mode con`
 *      follows) — the in-app replay of the 97f9eb1 fix;
 *   3. the −/+ explicit width buttons -> the pane-observer must not revert
 *      the manual choice (review fix, TerminalPanel manualCols);
 *   4. shortcuts Ctrl+C (interrupt), Ctrl+L (clear), Tab (completion),
 *      Escape (discard input);
 *   5. a long interactive command: the `node` REPL (enter, evaluate, Ctrl+D).
 *
 * Usage: node scripts/cdp-m1-terminal.mjs [--out docs/evidence/.../file.json]
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
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  }
  return r.result?.result?.value;
};

const report = {
  schema: "muse-desktop.m1-05-terminal-native.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 220)}`);
};

// --- open a conversation if the welcome screen is up, then the Terminal tab
await sleep(1500);
let active = null;
for (let i = 0; i < 30 && !active; i++) {
  active = await evaluate(`(() => {
    const tabs = document.querySelector("nav.work-tabs");
    if (tabs) return { sessionView: true };
    const row = document.querySelector("button.session-select");
    if (row) return { sessionView: false, rows: true };
    return null;
  })()`).catch((error) => {
    if (i === 0) console.error("probe error:", String(error).slice(0, 300));
    return null;
  });
  if (!active) await sleep(500);
}
if (!active) throw new Error("page did not reach an interactive state");
if (!active.sessionView) {
  await evaluate(`document.querySelector("button.session-select")?.click()`);
  await sleep(2500);
}
// open the work panel (toolbar toggle) if it is hidden, then the Terminal tab
await evaluate(`(() => {
  if (document.querySelector("nav.work-tabs")) return "open";
  document.querySelector('button[aria-label="Show work panel"]')?.click();
  return "toggled";
})()`);
await sleep(600);
const tabClick = await evaluate(`(() => {
  const tab = Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((b) => b.textContent.trim() === "Terminal");
  if (!tab) return { found: false };
  tab.click();
  return { found: true };
})()`);
if (!tabClick.found) throw new Error("Terminal work tab not found");
step("terminal-tab-opened", tabClick);

// a previous run may have left queued junk in the PTY: close and reopen it.
// Reopening needs a REMOUNT (the open effect refuses to retry within one
// mount), so switch to another tab and back.
await evaluate(`(() => {
  const close = document.querySelector("button.terminal-close");
  if (close) { close.click(); return "closed"; }
  return "no-terminal";
})()`);
await sleep(800);
await evaluate(`(() => {
  Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((b) => b.textContent.trim() === "Changes")?.click();
})()`);
await sleep(600);
await evaluate(`(() => {
  Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((b) => b.textContent.trim() === "Terminal")?.click();
})()`);
await sleep(800);

// wait for the PTY banner
const bannerDeadline = Date.now() + 30_000;
let output = "";
while (Date.now() < bannerDeadline) {
  output = await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
  if (output.trim().length > 0) break;
  await sleep(500);
}
step("pty-banner", { received: output.trim().length > 0, sample: output.slice(0, 120) });
if (output.trim().length === 0) throw new Error("PTY produced no banner");

const sizeLabel = async () =>
  evaluate(`document.querySelector(".terminal-size")?.textContent ?? ""`);

// The shortcut contract lives in the app (key -> PTY bytes): dispatch the key
// in-page so React's onKeyDown fires and the REAL onWrite -> PTY path runs.
// The ConPTY effect (^C interrupt, clear, completion echo) is then real.
const pressKey = async (key, { ctrl = false } = {}) => {
  await evaluate(`(() => {
    const input = document.querySelector("form.terminal-input input");
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true,
    }));
  })()`);
  await sleep(200);
};

// type + send a command through the panel's real input and Send button
const runCommand = async (command, settleMs = 1000) => {
  await evaluate(`document.querySelector("form.terminal-input input").focus()`);
  await send("Input.insertText", { text: command });
  await sleep(120);
  await evaluate(`document.querySelector("form.terminal-input button[type=submit]").click()`);
  await sleep(settleMs);
  return await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
};

const parseModeCon = (text) => {
  // English and French Windows; the LAST occurrence wins (earlier runs of
  // `mode con` stay in the transcript).
  const matches = (label) => Array.from(text.matchAll(new RegExp(`${label}\\s*:?\\s*(\\d+)`, "gi")));
  const columns = [...matches("Colonnes"), ...matches("Columns")].pop()?.[1];
  const lines = [...matches("Lignes"), ...matches("Lines")].pop()?.[1];
  return columns ? { columns: Number(columns), lines: lines ? Number(lines) : null } : null;
};
const modeCon = async (settleMs = 1100) => {
  const before = await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
  await evaluate(`document.querySelector("form.terminal-input input").focus()`);
  await send("Input.insertText", { text: "mode con" });
  await sleep(120);
  await evaluate(`document.querySelector("form.terminal-input button[type=submit]").click()`);
  // wait for the reply to actually land (the tail at a fixed delay can still
  // show the previous command's output)
  let text = before;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(400);
    text = await evaluate(`document.querySelector("pre.terminal-output")?.innerText ?? ""`);
    const added = text.slice(before.length);
    if (added.includes("Colonnes") || added.includes("Columns")) break;
  }
  await sleep(settleMs - 400 > 0 ? 200 : 0);
  return { parsed: parseModeCon(text), label: await sizeLabel(), tail: text.slice(-220) };
};

// --- 1. baseline geometry
const baseline = await modeCon(1400);
step("baseline-mode-con", baseline);

// --- 2. window resize -> PTY follows (ResizeObserver fix replay)
const windowId = await send("Browser.getWindowForTarget", { targetId: page.targetId })
  .then((r) => r.result?.windowId)
  .catch((error) => null);
if (windowId !== null) {
  // WebView2 may not report windowBounds; the page's real window metrics
  // answer the same question.
  const originalBounds = await evaluate(`({ width: window.outerWidth, height: window.outerHeight })`);
  await send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: originalBounds.width + 260, height: originalBounds.height + 180, windowState: "normal" },
  });
  await sleep(1700);
  const afterWider = await modeCon();
  step("resize-wider-mode-con", { windowWidth: originalBounds.width + 260, ...afterWider });
  report.verdict.resizeFollowsPty =
    afterWider.parsed !== null && baseline.parsed !== null &&
    afterWider.parsed.columns !== baseline.parsed.columns;

  // --- 3. explicit + width must stick (manual override, not reverted)
  const beforePlus = await sizeLabel();
  await evaluate(`document.querySelector('button[aria-label="Increase terminal width"]').click()`);
  await sleep(400);
  const afterPlus = await sizeLabel();
  const manual = await modeCon();
  await sleep(2200);
  const manualAgain = await modeCon();
  step("manual-plus", { beforePlus, afterPlus, modeCon: manual.parsed, label: manual.label });
  step("manual-stable-4s-later", { modeCon: manualAgain.parsed, label: manualAgain.label });
  report.verdict.manualWidthSticks =
    manual.parsed !== null && manualAgain.parsed !== null &&
    manual.parsed.columns === manualAgain.parsed.columns &&
    manual.parsed.columns !== afterWider.parsed.columns;

  // --- 4. a real pane resize lifts the manual override
  await send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: originalBounds.width, height: originalBounds.height, windowState: "normal" },
  });
  await sleep(1700);
  const restored = await modeCon();
  step("resize-back-mode-con", { windowWidth: originalBounds.width, ...restored });
  report.verdict.manualOverrideLiftsOnPaneMove =
    restored.parsed !== null && manual.parsed !== null &&
    restored.parsed.columns !== manual.parsed.columns;
} else {
  step("resize-wider-mode-con", { skipped: "Browser.getWindowForTarget unavailable" });
}

// --- 5. Tab completion on an IDLE shell (a running child eats the bytes)
const beforeDir = await evaluate(`document.querySelector("pre.terminal-output").innerText.length`);
const dirAll = await runCommand("dir /b", 1600);
const dirAdded = dirAll.slice(beforeDir).replace(/^dir \/b\r?\n/, "");
const candidate = dirAdded
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => /^[A-Za-z0-9._-]{5,}$/.test(line));
const tabPrefix = candidate ? candidate.slice(0, 4) : "pack";
await evaluate(`document.querySelector("form.terminal-input input").focus()`);
await send("Input.insertText", { text: `type ${tabPrefix}` });
await sleep(150);
await pressKey("Tab");
await sleep(1000);
const afterTab = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
const tabTail = afterTab.slice(-300);
step("tab-completion", { candidate, tabPrefix, echoed: candidate ? tabTail.includes(candidate) : false, tail: tabTail.slice(-160) });
report.verdict.tabCompletes = candidate ? tabTail.includes(candidate) : false;

// --- 6. Escape discards the typed command line (app contract)
await evaluate(`document.querySelector("form.terminal-input input").focus()`);
await send("Input.insertText", { text: "abcXYZ-should-vanish" });
await sleep(150);
await pressKey("Escape");
await sleep(400);
const inputAfterEscape = await evaluate(`document.querySelector("form.terminal-input input").value`);
step("escape-discards", { inputAfterEscape });
report.verdict.escapeDiscards = inputAfterEscape === "";

// --- 7. long interactive command: the node REPL. Ctrl+L (clear) and Ctrl+D
// (EOF) are exercised INSIDE the REPL, where they are real shell features;
// cmd.exe itself handles neither.
await runCommand("node", 3000);
const replStarted = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
const replUp = /Welcome to Node\.js/.test(replStarted.slice(-400));
step("repl-started", { up: replUp, tail: replStarted.slice(-160) });
const beforeCtrlL = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
await pressKey("l", { ctrl: true });
await sleep(1000);
const afterCtrlL = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
// The panel renders the bounded byte stream (a log), not a screen emulator:
// a clear reaches the renderer as the ConPTY screen REPAINT (a flood of
// newlines), not as a shorter innerText.
const repaint = (afterCtrlL.slice(beforeCtrlL.length).match(/\r?\n/g) ?? []).length;
step("repl-ctrl-l", { before: beforeCtrlL.length, after: afterCtrlL.length, repaintLines: repaint });
// a full-screen clear repaints ~one terminal height (27-row PTY -> 26 lines)
report.verdict.ctrlLClears = repaint >= 20;
await evaluate(`document.querySelector("form.terminal-input input").focus()`);
await send("Input.insertText", { text: "1+1" });
await sleep(150);
await evaluate(`document.querySelector("form.terminal-input button[type=submit]").click()`);
await sleep(1300);
const replEvaluated = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
const answered = /\n2\r?\n>?\s*$/.test(replEvaluated.trimEnd()) || /\n2\r?\n/.test(replEvaluated.slice(-160));
step("repl-evaluate", { answered, tail: replEvaluated.slice(-160) });
await pressKey("d", { ctrl: true });
await sleep(1600);
const afterEof = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
const backToShell = /\\[^\\]*>\s*$/.test(afterEof.trimEnd());
step("repl-exit-ctrl-d", { tail: afterEof.slice(-160), backToShell });
report.verdict.replRoundTrip = replUp && answered && backToShell;

// --- 8. Ctrl+C interrupt attempt through the synthetic key path, LAST so a
// non-interrupted ping cannot pollute the other steps. The reference proof
// for this shortcut is the 27/09 run5 (real keyboard: ping interrupted,
// ^C rendered); the synthetic path is recorded honestly.
await runCommand("ping -n 20 127.0.0.1", 3000);
const beforeCtrlC = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
await pressKey("c", { ctrl: true });
await sleep(1600);
const afterCtrlC = await evaluate(`document.querySelector("pre.terminal-output").innerText`);
const caretShown = afterCtrlC.includes("^C");
step("ctrl-c", {
  pingSeen: /Réponse|Reply/.test(beforeCtrlC),
  caret: caretShown,
  note: "real-keyboard proof: m1-05-fix-portable-pty.md run5 (27/09)",
});
report.verdict.ctrlCInterrupts = caretShown;

socket.close();
// `all` covers TODAY's remaining M1-05 criteria (geometry replay, the
// Ctrl+D/L/Tab/Escape shortcuts, the REPL). Ctrl+C was already proved with a
// real keyboard on 27/09 (run5) and is reported informationally here.
report.verdict.all =
  !!report.verdict.resizeFollowsPty &&
  !!report.verdict.manualWidthSticks &&
  !!report.verdict.manualOverrideLiftsOnPaneMove &&
  !!report.verdict.ctrlLClears &&
  !!report.verdict.tabCompletes &&
  !!report.verdict.escapeDiscards &&
  !!report.verdict.replRoundTrip;
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
