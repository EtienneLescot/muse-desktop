#!/usr/bin/env node

/**
 * Measure the bounded transcript window on a synthetic long conversation
 * (M1-13): 2 000 persisted entries, then read the DOM window the app actually
 * mounts. Restores the original log afterwards.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-long-transcript.mjs [--entries 2000] [--keep]
 *
 * The measurement mutates one `localStorage` log key and reloads the page. The
 * original value is captured first and written back in a `finally` block, so a
 * failure does not leave the profile modified.
 *
 * Reading proof (M1-13, 06/10/2026): `node scripts/cdp-long-transcript.mjs
 * <phase>` drives an instance it starts itself in the isolated test mode
 * (ADR 0003): a fresh data folder under --base, no WEBVIEW2_* variable, the
 * staged engine as the only local engine, MUSE_NO_AUTO_UPDATE=1, CDP on
 * MUSE_CDP_PORT (default 9333). It refuses an exe without the switch, stops an
 * app that writes no test-mode.pid, and drives nothing unless the WebView2
 * profile lies under the data folder. Outside the stream phase the IPC trace
 * refuses every command that could start a turn. Each phase merges a
 * path-free result into --out.
 *   launch  the instance, on the exe copy named by --exe in --bin.
 *   setup   no turn. The test conversation in <base>\ws: start_session with
 *           the profile's own posture and isolation, a reload adopts it.
 *   load    no turn. The synthetic loading of the default mode (--entries,
 *           2,000) with a selection pair near the end and a 220-line last
 *           answer, then the window read.
 *   stream  1 live turn. (1) Sent from the end, then the reader scrolls up
 *           with the wheel: an entry's offset in the viewport is sampled
 *           while the turn streams in, the "Latest messages" button is
 *           clicked, and the end is sampled while the stream goes on.
 *   replay  no turn. The same steps on output events forged into
 *           poll_events (a new item every 3 s); the log is put back.
 *   bottom  no turn. (2) The window reopened at the top of the history (the
 *           saved viewport says so), then back to the end by the button,
 *           then by the End key.
 *   copy    no turn. (3) A mouse drag from one entry into the next, Ctrl+C:
 *           the selection, the clipboard read over CDP and the OS clipboard,
 *           against the hidden strings of the selected nodes.
 *   block   no turn. (4) A 5,000-line code block inserted outside the window:
 *           the finder jumps to it (and first to a plain entry, the baseline),
 *           render cost and DOM size, then wheel, PageDown and past its end.
 *           The log is put back.
 *   theme   no turn. (5) prefers-color-scheme light then dark (CDP
 *           Emulation.setEmulatedMedia, stored theme cleared): WCAG contrast of
 *           entries from getComputedStyle; a stored theme against the OS.
 *   finder  no turn. (6) scripts/cdp-finder-jump.mjs replayed on this build.
 *   stop    the instance closed from its window, forced after 20 s.
 * Order used on 06/10/2026, a fresh data folder per build, phases relabelled
 * by build in the record and superseded passes pruned: 1898938 launch,
 * setup, load, bottom; f5fb1ec launch, setup, load, stream; 26d6397 launch,
 * setup, load, stream, bottom (load without the long last answer, added
 * after this run); f2e2d37 launch, setup, load, bottom; 6581e25 the final
 * sequence, copy failing; 6c02f29 launch, setup, load, bottom, replay, copy,
 * block, theme, finder, stop. Two live turns in all, the stream phases.
 *
 * Usage: node scripts/cdp-long-transcript.mjs <phase> [--base G:\muse-proofs\m1-13]
 *   [--bin <base>\bin] [--exe muse-desktop.exe] [--entries 2000] [--as <record key>]
 *   [--out docs/evidence/2026-10-05-roadmap-closure/m1-13-reading.json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";

const PHASE = argv[2] && !argv[2].startsWith("--") ? argv[2] : null;
// The reading phases drive their own instance: never a developer's app on 9222.
if (PHASE) process.env.MUSE_CDP_PORT ??= "9333";
const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const index = argv.indexOf("--entries");
const ENTRIES = index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : 2000;
const KEEP = argv.includes("--keep");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error("no CDP page target");
  return page;
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (frame.id === undefined) return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${frame.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 60_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

/** Read the transcript's observability attributes and mounted node count. */
const WINDOW_SNIPPET = `(() => {
  const host = document.querySelector('[data-entry-count]');
  if (!host) return { transcriptFound: false };
  const entries = host.querySelectorAll('[role="article"], article');
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    transcriptFound: true,
    dataEntryCount: host.getAttribute("data-entry-count"),
    dataWindowStart: host.getAttribute("data-window-start"),
    dataWindowEnd: host.getAttribute("data-window-end"),
    ariaLabel: host.getAttribute("aria-label"),
    ariaKeyshortcuts: host.getAttribute("aria-keyshortcuts"),
    mountedArticles: entries.length,
    mountedNodes: host.querySelectorAll("*").length,
    setsizeSample: entries[0] ? entries[0].getAttribute("aria-setsize") : null,
    posinsetSample: entries[0] ? entries[0].getAttribute("aria-posinset") : null,
    hasLoadOlder: /Load older messages/i.test(body),
    hasLatest: /Latest messages/i.test(body)
  };
})()`;

/** Press a key on the focused transcript; the app's shortcut listener sits on window. */
const pressOnTranscript = (key, ctrlKey = false) => `(() => {
  const host = document.querySelector('[data-entry-count]');
  if (!host) return false;
  host.focus();
  return host.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true }));
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-long-transcript.v1", requestedEntries: ENTRIES, steps: {} };
  let restore = null;
  try {
    // Pick the conversation to lengthen: the active one, else the first log key.
    const picked = await evaluate(client, `(() => {
      const active = localStorage.getItem("muse-desktop.active.v1");
      const id = active ? active.replace(/^"|"$/g, "") : null;
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.log.v1."));
      const key = (id && localStorage.getItem("muse-desktop.log.v1." + id)) ? "muse-desktop.log.v1." + id : null; // never fall back to another conversation
      return { key, sessionId: key ? key.replace("muse-desktop.log.v1.", "") : null, logKeys: keys.length };
    })()`);
    report.target = picked;
    if (!picked.key) throw new Error("no transcript log key found in localStorage");

    const original = await evaluate(client, `localStorage.getItem(${JSON.stringify(picked.key)})`);
    restore = { key: picked.key, value: original };
    report.original = { bytes: (original ?? "").length, entries: (() => { try { return JSON.parse(original ?? "[]").length; } catch { return null; } })() };

    // Build a long log with the shape the app persists.
    const written = await evaluate(client, `(() => {
      const base = (() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(picked.key)}) || "[]"); } catch { return []; } })();
      const first = base[0] || { clientMessageId: "seed", id: "seed-0", role: "user", text: "seed", ts: Date.now() };
      const now = Date.now();
      const entries = [];
      for (let i = 0; i < ${ENTRIES}; i += 1) {
        entries.push({
          clientMessageId: "long-" + i,
          id: "long-" + i,
          role: i % 2 === 0 ? "user" : "assistant",
          text: "Long transcript entry " + i + " — filler line to give the window something to measure.",
          ts: now - (${ENTRIES} - i) * 1000
        });
      }
      localStorage.setItem(${JSON.stringify(picked.key)}, JSON.stringify(entries));
      return { entries: entries.length, bytes: JSON.stringify(entries).length, seedUsed: first ? true : false };
    })()`);
    report.written = written;

    // Reload so boot hydration reads the new log.
    await client.send("Page.enable").catch(() => undefined);
    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(12_000);

    // Open the lengthened conversation.
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const withCount = nodes.find((n) => /Long transcript entry 0/i.test(n.innerText || "")) || nodes[0];
      return { found: Boolean(withCount) };
    })()`);
    report.afterReload = await evaluate(client, WINDOW_SNIPPET);
    // The finder renders only after Ctrl/Cmd+F and its name is an aria-label,
    // not body text: open it, then look for the element itself.
    await evaluate(client, pressOnTranscript("f", true));
    await sleep(500);
    report.afterReload.hasFinder = await evaluate(client, `Boolean(document.querySelector(".stream-find"))`);
    await evaluate(client, pressOnTranscript("Escape"));
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    if (restore && !KEEP) {
      const restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        return { key: ${JSON.stringify(restore.key)}, bytes: (localStorage.getItem(${JSON.stringify(restore.key)}) || "").length };
      })()`).catch((error) => ({ error: String(error.message || error) }));
      report.restored = restored;
      await evaluate(client, "location.reload()").catch(() => undefined);
    } else if (restore && KEEP) {
      report.restored = "skipped (--keep)";
    }
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// ---- reading proof (M1-13, 06/10/2026), isolated test mode ------------------

const arg = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const J = JSON.stringify;
const BASE = resolve(arg("--base", "G:\\muse-proofs\\m1-13"));
const BIN = resolve(arg("--bin", join(BASE, "bin")));
const OUT = arg("--out", "docs/evidence/2026-10-05-roadmap-closure/m1-13-reading.json");
const ENGINE = resolve(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"));
const STATE = join(BASE, "harness-state.json");
const WS = join(BASE, "ws");
const SHOTS = join(BASE, "shots");
// What can start or steer a turn: refused by the IPC trace outside the stream phase.
const TURN_COMMANDS = ["send_input", "steer_input", "user_shell"];
// Long enough to keep streaming while the reader is up in the history, then after the click.
const STREAM_PROMPT = "Write a numbered list from 1 to 220. Each item is one plain sentence of about twelve words about a different day in the life of a lighthouse keeper. Output only the list: no introduction, no conclusion, no headings, no code block. Do not use any tool.";
const SELECT_A = "SELECT-A alpha bravo charlie delta";
const SELECT_B = "SELECT-B echo foxtrot golf hotel";
const BLOCK_LINES = 5000;
const CRITERIA = {
  stream: "1. interleaved streaming",
  replay: "1. interleaved streaming",
  bottom: "2. back to the bottom from the top",
  copy: "3. selection and copy across two entries",
  block: "4. large block",
  theme: "5. theme",
  finder: "6. finder jump and reduced motion",
};

let H_ = null; // cdp-harness.mjs, imported once the port is set
let liveTurnSent = false; // a failed stream phase still counts its turn
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));
const parse = (text) => { try { return JSON.parse(text); } catch { return text ?? null; } };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
const ps = (command) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
const alive = (pid) => {
  try { return lines(ps(`Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`)).length > 0; } catch { return false; }
};
const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };
const childPids = (pid) => {
  try { return lines(ps(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { $_.ProcessId }`)).map(Number); } catch { return []; }
};

function engineVersion() {
  try {
    return execFileSync(ENGINE, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

const redact = (value) => H_.redactor([[WS, "<test folder>"], [BASE, "<proof>"], [dirname(ENGINE), "<engine dir>"], [resolve("."), "<repo>"]])(value);

/** One phase's result into the record, path-free; the build and engine facts refreshed. */
function merge(key, result) {
  const s = state();
  const record = readJson(OUT, {
    schema: "muse-desktop.m1-13-reading.v1",
    ticket: "M1-13",
    criteria: {},
    screenReader: "Not exercised: the screen-reader half stays for a later session with the user (NVDA), as for M0-12. The roles, labels and live regions recorded here are a necessary condition, not proof of what a screen reader announces.",
    phases: {},
  });
  record.date = new Date().toISOString().slice(0, 10);
  record.commit = H_.gitHead();
  record.platform = `win32 ${release()}, debug build with the embedded frontend, isolated test mode (ADR 0003), WebView2 over CDP`;
  if (s.webview2) record.webview2 = s.webview2;
  record.engine = engineVersion();
  record.engineSha256 = sha256(readFileSync(ENGINE));
  if (s.exe) {
    record.build = { exe: basename(s.exe), exeSha256: sha256(readFileSync(s.exe)), commit: readJson(join(BIN, "builds.json"), {})[basename(s.exe)]?.commit ?? null };
  }
  const exeSha256 = s.exe ? sha256(readFileSync(s.exe)) : null;
  record.phases[key] = redact({ exeSha256, ...result });
  if (CRITERIA[key]) {
    const criterion = record.criteria[CRITERIA[key]] ?? { phases: {} };
    criterion.phases[key] = { pass: result.pass === true, exeSha256 };
    criterion.verdict = Object.values(criterion.phases).every((p) => p.pass) ? "pass" : "fail";
    record.criteria[CRITERIA[key]] = criterion;
  }
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[key];
}

// ---- the instance ---------------------------------------------------------------

/** Started from PowerShell: fresh data folder, no WEBVIEW2_*, the staged engine only, CDP on PORT. */
async function launchApp() {
  const file = resolve(BIN, arg("--exe", "muse-desktop.exe"));
  if (!existsSync(file)) throw new Error(`no exe at ${file}`);
  if (!readFileSync(file).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  const launches = (state().launches ?? 0) + 1;
  const data = join(BASE, `appdata-${launches}`);
  if (existsSync(data)) throw new Error(`${data} exists: every launch takes a fresh data folder`);
  mkdirSync(data, { recursive: true });
  const pid = Number(ps([
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${data}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${J([ENGINE.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${file}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")).trim());
  saveState({ pid, data, launches, exe: file, sid: null });
  const entered = await H_.waitFor(() => { try { return readFileSync(join(data, "test-mode.pid"), "utf8").trim() === String(pid); } catch { return false; } }, 10_000, 100);
  if (!entered) {
    forceKill(pid);
    saveState({ pid: null });
    throw new Error("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  }
  return pid;
}

const installTrace = async (app, allowTurn) => {
  await app.ev(H_.INSTALL_IPC_TRACE);
  await app.ev(`(window.__baselineIpc.block = ${J(allowTurn ? [] : TURN_COMMANDS)}, true)`);
};

/** CDP on this harness's instance only: its WebView2 profile must lie under its data folder. */
async function attach({ allowTurn = false } = {}) {
  const s = state();
  if (!s.pid || !alive(s.pid)) throw new Error("no instance of this harness is running: run launch first");
  let app = null;
  await H_.waitFor(async () => { try { app = await H_.openPage(); return true; } catch { return false; } }, 120_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  if (!s.data || !H_.under(H_.webviewProfile(), s.data)) {
    app.close();
    forceKill(s.pid);
    saveState({ pid: null });
    throw new Error("the WebView2 browser is not on the test profile: stopped before driving the app");
  }
  await app.send("Page.enable");
  await H_.waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))").catch(() => false), 60_000, 500);
  await installTrace(app, allowTurn);
  return app;
}

async function reloadPage(app) {
  await app.send("Page.reload", {});
  await sleep(1_500);
  const back = await H_.waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))").catch(() => false), 60_000, 500);
  if (!back) throw new Error("the page did not come back after the reload");
  await installTrace(app, false);
}

// ---- page side ------------------------------------------------------------------

const PAGE = `
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const host = () => document.querySelector('[data-entry-count]');
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('[data-running]')?.getAttribute('data-running') ?? null;
  const entries = () => [...(host()?.querySelectorAll('[data-entry-index]') ?? [])];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const latestButton = () => host()?.querySelector('.jump-to-latest') ?? null;
  const shown = (el) => { if (!el) return false; const c = rect(el); const hit = document.elementFromPoint(c.x, c.y); return Boolean(hit) && (hit === el || el.contains(hit)); };
  const win = () => {
    const h = host();
    if (!h) return null;
    const box = h.getBoundingClientRect();
    const list = entries();
    const inView = list.filter((n) => { const r = n.getBoundingClientRect(); return r.bottom > box.top + 1 && r.top < box.bottom - 1; });
    const b = latestButton();
    return {
      entryCount: Number(h.dataset.entryCount), windowStart: Number(h.dataset.windowStart), windowEnd: Number(h.dataset.windowEnd),
      mountedArticles: h.querySelectorAll('[role="article"]').length, mountedNodes: h.querySelectorAll('*').length,
      scrollTop: Math.round(h.scrollTop), scrollHeight: h.scrollHeight, clientHeight: h.clientHeight,
      fromBottom: Math.round(h.scrollHeight - h.scrollTop - h.clientHeight),
      firstVisibleIndex: inView.length ? Number(inView[0].dataset.entryIndex) : null,
      lastVisibleIndex: inView.length ? Number(inView[inView.length - 1].dataset.entryIndex) : null,
      lastMountedIndex: list.length ? Number(list[list.length - 1].dataset.entryIndex) : null,
      latestButton: b ? { text: b.innerText.trim(), shown: shown(b) } : null,
      announcement: h.querySelector(':scope > .sr-only[role="status"]')?.textContent ?? null,
    };
  };
`;
const page = (body) => `(async () => { ${PAGE} ${body} })()`;

// ---- real input -----------------------------------------------------------------

const mouse = (app, type, at, extra = {}) => app.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, ...extra });
async function click(app, at) {
  await mouse(app, "mouseMoved", at);
  await mouse(app, "mousePressed", at, { button: "left", buttons: 1, clickCount: 1 });
  await mouse(app, "mouseReleased", at, { button: "left", buttons: 0, clickCount: 1 });
}
async function drag(app, from, to, steps = 12) {
  await mouse(app, "mouseMoved", from);
  await mouse(app, "mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await mouse(app, "mouseMoved", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await mouse(app, "mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
}
const wheel = (app, at, deltaY) => mouse(app, "mouseWheel", at, { deltaX: 0, deltaY });
async function key(app, keyName, code, vk, modifiers = 0, text) {
  const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (text) await app.send("Input.dispatchKeyEvent", { type: "char", text, ...base });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ---- shared steps ---------------------------------------------------------------

async function openConversation(app, sid) {
  const opened = await app.ev(page(`
    for (let i = 0; i < 100 && !row(${J(sid)}); i += 1) await pause(100);
    if (activeSid() !== ${J(sid)}) row(${J(sid)})?.querySelector('button.session-select')?.click();
    for (let i = 0; i < 100 && (activeSid() !== ${J(sid)} || !host()); i += 1) await pause(100);
    return activeSid() === ${J(sid)} && Boolean(host());
  `));
  if (!opened) throw new Error("the test conversation could not be opened");
  await sleep(800);
}

async function guard(app) {
  const { sid } = state();
  if (!sid) throw new Error("no test conversation: run setup first");
  await openConversation(app, sid);
  return { sid };
}

/** The End key on the focused transcript, as a keyboard user goes to the latest messages. */
async function toLatest(app) {
  await app.ev(page("host().focus(); return true;"));
  await key(app, "End", "End", 35);
  await H_.waitFor(() => app.ev(page("const w = win(); return Boolean(w) && w.fromBottom <= 80;")), 5_000, 200);
  await sleep(600);
  return app.ev(page("return win();"));
}

const ipcCalls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${J(cmd)}).map((c) => ({ ok: c.ok, blocked: Boolean(c.blockedByHarness) }))`);
const metricsOf = (result) => Object.fromEntries((result?.metrics ?? []).map((m) => [m.name, m.value]));
function costBetween(before, after) {
  const ms = (name) => Math.round((after[name] - before[name]) * 10_000) / 10;
  return {
    layoutMs: ms("LayoutDuration"), recalcStyleMs: ms("RecalcStyleDuration"), scriptMs: ms("ScriptDuration"), taskMs: ms("TaskDuration"),
    layouts: after.LayoutCount - before.LayoutCount, styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    nodesBefore: before.Nodes, nodesAfter: after.Nodes, heapUsedKiBAfter: Math.round(after.JSHeapUsedSize / 1024),
  };
}
const shot = async (app, name) => {
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await app.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  return `${name}.png (local, not committed)`;
};

// ---- phases ---------------------------------------------------------------------

async function launch() {
  if (state().pid && alive(state().pid)) throw new Error("this harness's instance is still running: run stop first");
  const pid = await launchApp();
  const app = await attach();
  const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  saveState({ webview2: version?.Browser ?? null });
  const profile = await app.ev(page("return { conversations: (store('muse-desktop.sessions.v1', '[]') || []).length, theme: localStorage.getItem('muse-desktop.theme.v1'), visibility: document.visibilityState };"));
  return {
    app,
    result: {
      liveTurns: 0, pidRecorded: Boolean(pid), webview2: version?.Browser ?? null, profile,
      isolation: { testModeMarker: true, webviewProfileUnderDataFolder: true, webview2VariablesRemoved: true, autoUpdateOff: true, cdpPort: PORT },
    },
  };
}

/** No turn: the native start_session with the profile's own posture and isolation, adopted after a reload. */
async function setup(app) {
  if (state().sid) throw new Error("this profile has its test conversation already");
  mkdirSync(WS, { recursive: true });
  const raw = await app.ev(page("return { posture: localStorage.getItem('muse-desktop.authorization-mode.v1'), sandbox: localStorage.getItem('muse-desktop.settings.v1') };"));
  const { parseAuthorizationMode } = await import("../src/lib/authorization.ts");
  const { hostSandboxConfigForProject, parseSandboxSettings } = await import("../src/lib/settings.ts");
  const mode = parseAuthorizationMode(parse(raw.posture));
  const isolation = hostSandboxConfigForProject(parseSandboxSettings(parse(raw.sandbox)));
  const meta = await app.ev(`window.__TAURI_INTERNALS__.invoke('start_session', ${J({
    workspacePath: WS, authorizationMode: mode, sandboxMode: isolation.mode,
    sandboxDisableWrite: isolation.disableWrite, sandboxDisableShell: isolation.disableShell })})`);
  if (!meta?.session_id) throw new Error(`start_session failed: ${J(meta)}`);
  saveState({ sid: meta.session_id });
  await reloadPage(app);
  await openConversation(app, meta.session_id);
  const logEntries = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(meta.session_id)}, '[]') || []).length;`));
  const verdict = { adoptedAndOpen: true, noTurn: logEntries === 0 };
  return {
    liveTurns: 0, startSession: { authorizationMode: mode, isolation, approvalMode: meta.approval_mode ?? null, durability: meta.session_durability ?? null },
    view: await app.ev(page("return win();")), verdict, pass: verdict.noTurn,
  };
}

/** No turn: the default mode's synthetic loading, plus the copy phase's pair near the end. */
async function load(app) {
  const { sid } = await guard(app);
  const key = `muse-desktop.log.v1.${sid}`;
  const original = parse(await app.ev(`localStorage.getItem(${J(key)})`)) ?? [];
  const written = await app.ev(`(() => {
    const now = Date.now();
    const n = ${ENTRIES};
    const entries = [];
    for (let i = 0; i < n; i += 1) {
      entries.push({ clientMessageId: "long-" + i, id: "long-" + i, role: i % 2 === 0 ? "user" : "assistant",
        text: "Long transcript entry " + i + " — filler line to give the window something to measure.", ts: now - (n - i) * 1000 });
    }
    const a = n - 4 - ((n - 4) % 2);
    entries[a].text = ${J(SELECT_A)};
    entries[a + 1].text = ${J(SELECT_B)};
    // A long last answer, as long conversations often end: the shape that sent End 4,985 px short.
    entries[n - 1] = { ...entries[n - 1], role: "assistant",
      text: Array.from({ length: 220 }, (_, k) => (k + 1) + ". Line " + (k + 1) + " of the long last answer, a sentence of about twelve words.").join("\\n") };
    localStorage.setItem(${J(key)}, JSON.stringify(entries));
    return { entries: n, bytes: JSON.stringify(entries).length, selectionPair: [a, a + 1] };
  })()`);
  await reloadPage(app);
  await openConversation(app, sid);
  const view = await toLatest(app);
  const stored = await app.ev(page(`const log = store(${J(key)}, '[]') || []; return { entries: log.length, appended: log.slice(${ENTRIES}).map((e) => ({ role: e.role, text: String(e.text).slice(0, 60) })) };`));
  // The stream phase's page probes, tried here before any turn is spent on them.
  const probes = { anchor: await app.ev(PICK_ANCHOR), sample: await app.ev(SAMPLE(sid, null, view.entryCount - 2)) };
  // The anchor may be null here: at the end, the long last answer fills the view.
  const verdict = { tailWindow: view.windowEnd === view.entryCount, domBound: view.mountedArticles <= 160, probesAnswer: typeof probes.sample?.count === "number" };
  return { liveTurns: 0, original: { entries: Array.isArray(original) ? original.length : null }, written, stored, view, probes, verdict, pass: Object.values(verdict).every(Boolean) };
}

/** The anchor: the first synthetic entry wholly inside the viewport. */
const PICK_ANCHOR = page(`
  const h = host();
  const box = h.getBoundingClientRect();
  const n = entries().find((e) => { const r = e.getBoundingClientRect(); return r.top >= box.top + 4 && r.bottom <= box.bottom - 4 && /Long transcript entry \\d+ —/.test(e.textContent || ''); });
  if (!n) return null;
  return { index: Number(n.dataset.entryIndex), token: (n.textContent || '').match(/Long transcript entry \\d+ —/)[0],
    top: Math.round((n.getBoundingClientRect().top - box.top) * 10) / 10,
    fromBottom: Math.round(h.scrollHeight - h.scrollTop - h.clientHeight), clientHeight: h.clientHeight };
`);

/** One sample: the anchor's offset in the viewport, the window, and the live turn's entries (index >= from). */
const SAMPLE = (sid, token, from) => page(`
  const h = host();
  const list = entries();
  const anchor = ${J(token)} ? list.find((n) => (n.textContent || '').includes(${J(token)})) : null;
  const live = list.filter((n) => Number(n.dataset.entryIndex) >= ${from});
  const b = latestButton();
  return {
    count: Number(h.dataset.entryCount), start: Number(h.dataset.windowStart),
    scrollTop: Math.round(h.scrollTop * 10) / 10, fromBottom: Math.round(h.scrollHeight - h.scrollTop - h.clientHeight),
    anchorTop: anchor ? Math.round((anchor.getBoundingClientRect().top - h.getBoundingClientRect().top) * 10) / 10 : null,
    liveEntries: live.length, liveChars: live.reduce((n, e) => n + (e.textContent || '').length, 0),
    liveOpen: live.some((e) => e.getAttribute('data-open') === 'true' || e.classList.contains('is-live')),
    latestShown: b ? shown(b) : null,
    running: running(${J(sid)}),
  };
`);

/**
 * Forged output events through poll_events, the path every host event takes to
 * the renderer: a delta every 200 ms, a new item every 3 s (cdp-m0-05-06-approvals.mjs forges the same way).
 */
const FORGE = (sid) => `(() => {
  const forge = window.__m113forge = { queue: [] };
  const fetch0 = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!url.includes('ipc.localhost/poll_events') || forge.queue.length === 0) return fetch0(input, init);
    const response = await fetch0(input, init);
    if (response.headers.get('Tauri-Response') !== 'ok') return response;
    const body = await response.clone().json();
    body.events = [...(body.events || []), ...forge.queue.splice(0)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
  };
  const t0 = Date.now();
  const timer = setInterval(() => {
    const item = 'replay-' + Math.floor((Date.now() - t0) / 3000);
    forge.queue.push({ session_id: ${J(sid)}, kind: 'output', payload: JSON.stringify({ itemId: item, text: 'Forged delta of ' + item + ', streamed while the reader is elsewhere. ' }) });
  }, 200);
  forge.stop = () => clearInterval(timer);
  return true;
})()`;

/** (1) The reader up in the history while a turn streams in: 1 live turn, or forged events (replay, no turn, log put back). */
async function stream(app, forged = false) {
  const { sid } = await guard(app);
  const logKey = `muse-desktop.log.v1.${sid}`;
  const original = forged ? await app.ev(`localStorage.getItem(${J(logKey)})`) : null;
  try {
    return await streamTurn(app, sid, forged);
  } finally {
    if (forged) {
      await app.ev("(window.__m113forge && window.__m113forge.stop(), true)").catch(() => undefined);
      await app.ev(`(localStorage.setItem(${J(logKey)}, ${J(original)}), true)`);
      await reloadPage(app);
      await openConversation(app, sid);
      if (!(await app.ev(`localStorage.getItem(${J(logKey)}) === ${J(original)}`))) process.stderr.write("the log was not put back identically\n");
    }
  }
}

async function streamTurn(app, sid, forged) {
  const before = await toLatest(app);
  if (!(before.entryCount > 600)) throw new Error("the conversation is not long: run load first");
  const from = before.entryCount;
  if (forged) {
    await app.ev(FORGE(sid));
  } else {
    const sent = await app.ev(page(`
      const field = document.querySelector('textarea[aria-label="Message Muse"]');
      if (!field) return { sent: false, reason: 'no composer' };
      setValue(field, ${J(STREAM_PROMPT)});
      let send = null;
      for (let i = 0; i < 60; i += 1) { await pause(250); send = document.querySelector('button.send'); if (send && !send.disabled) break; }
      if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
      send.click();
      return { sent: true };
    `));
    if (!sent.sent) throw new Error(`prompt not sent: ${sent.reason}`);
    liveTurnSent = true;
  }
  const tSend = Date.now();
  // The reader goes up with the wheel as soon as the turn is sent, past the
  // last answer until a whole entry of the history is in view.
  const at = await app.ev(page("const c = rect(host()); return { x: c.x, y: c.y };"));
  let anchor = null;
  for (let i = 0; i < 24 && !anchor; i += 1) {
    await wheel(app, at, -700);
    await sleep(i < 2 ? 60 : 300);
    if (i >= 2) anchor = await app.ev(PICK_ANCHOR);
  }
  await sleep(400); // the wheel's own scroll animation is over: the anchor is read at rest
  anchor = (await app.ev(PICK_ANCHOR)) ?? anchor;
  if (!anchor) throw new Error("no entry wholly in view after scrolling up");
  const up = [];
  const t0 = Date.now();
  for (;;) {
    const s = await app.ev(SAMPLE(sid, anchor.token, from));
    up.push({ ms: Date.now() - tSend, ...s });
    const elapsed = Date.now() - t0;
    const grew = s.liveChars - up[0].liveChars;
    if ((elapsed >= 8_000 && grew >= 400 && s.liveOpen) || elapsed >= 60_000 || (s.running === "false" && elapsed >= 5_000)) break;
    await sleep(150);
  }
  const sendInput = forged ? null : await ipcCalls(app, "send_input");
  const button = await app.ev(page("const b = latestButton(); return b && shown(b) ? { ...rect(b), text: b.innerText.trim() } : null;"));
  const clickedAt = Date.now() - tSend;
  if (button) await click(app, button);
  const after = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 8_000) {
    after.push({ ms: Date.now() - tSend, ...(await app.ev(SAMPLE(sid, null, from))) });
    await sleep(150);
  }
  if (forged) await app.ev("(window.__m113forge.stop(), true)");
  const done = forged ? null : await H_.waitFor(async () => {
    const s = await app.ev(SAMPLE(sid, null, from));
    return s.running === "false" && !s.liveOpen ? s : null;
  }, 240_000, 1_000);
  const end = await app.ev(page("return win();"));
  const turn = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).filter((e) => e.ts >= ${tSend - 5_000})
    .map((e) => ({ role: e.role, chars: String(e.text || '').length, head: String(e.text || '').replace(/\\s+/g, ' ').slice(0, 90), ...(e.engineError ? { engineError: e.engineError.kind } : {}) }));`));
  const held = up.filter((s) => s.anchorTop !== null);
  const drift = held.length ? Math.max(...held.map((s) => Math.abs(s.anchorTop - anchor.top))) : null;
  const settled = after.filter((s) => s.ms - clickedAt >= 300);
  const verdict = {
    scrolledUpPx: anchor.fromBottom,
    readingPositionHeld: held.length === up.length && drift !== null && drift <= 1,
    maxAnchorDriftPx: drift,
    whileUp: {
      liveCharsAdded: up.at(-1).liveChars - up[0].liveChars,
      entriesAddedSinceSend: up.at(-1).count - from,
      entriesAddedWhileSampled: up.at(-1).count - up[0].count,
      windowStartMoved: up.at(-1).start - up[0].start,
      scrollTopRange: [Math.min(...up.map((s) => s.scrollTop)), Math.max(...up.map((s) => s.scrollTop))],
    },
    affordanceShownWhileUp: up.every((s) => s.latestShown === true),
    affordanceClicked: Boolean(button),
    returnedToEnd: settled.length > 0 && settled.every((s) => s.fromBottom <= 80),
    streamContinuedAtEnd: settled.length > 1 && settled.at(-1).liveChars > settled[0].liveChars,
    affordanceGoneAtEnd: settled.length > 0 && settled.at(-1).latestShown === null,
    turnCompleted: forged ? null : Boolean(done),
  };
  const pass = verdict.readingPositionHeld && verdict.whileUp.liveCharsAdded > 0 && verdict.affordanceShownWhileUp
    && verdict.affordanceClicked && verdict.returnedToEnd && verdict.streamContinuedAtEnd && verdict.affordanceGoneAtEnd && (forged || verdict.turnCompleted);
  return {
    liveTurns: forged ? 0 : 1, source: forged ? "forged output events through poll_events, no model" : "live model turn",
    prompt: forged ? null : STREAM_PROMPT, sendInput, before, anchor, button, clickedAtMs: clickedAt,
    samplesUp: { fields: ["ms", "scrollTop", "anchorTop", "count", "start", "liveChars", "fromBottom", "latestShown"], rows: up.map((s) => [s.ms, s.scrollTop, s.anchorTop, s.count, s.start, s.liveChars, s.fromBottom, s.latestShown]) },
    samplesAfterClick: { fields: ["ms", "scrollTop", "count", "start", "liveChars", "fromBottom", "latestShown"], rows: after.map((s) => [s.ms, s.scrollTop, s.count, s.start, s.liveChars, s.fromBottom, s.latestShown]) },
    end, turn, verdict, pass,
  };
}

/** The viewport the app restores on open, saved as the first window scrolled to the top. */
async function openAtTop(app, sid) {
  await sleep(400); // past the stream's 180 ms viewport-save debounce
  await app.ev(page(`
    const key = 'muse-desktop.stream-position.v1';
    const rows = (store(key, '[]') || []).filter((r) => r.sessionId !== ${J(sid)});
    rows.push({ sessionId: ${J(sid)}, scrollTop: 0, windowStart: 0, updatedAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(rows));
    return true;
  `));
  await reloadPage(app);
  await openConversation(app, sid);
  await sleep(1_500);
  return app.ev(page("return win();"));
}

/** No turn: (2) from a window opened at the top of the history back to the end, by the button then by End. */
async function bottom(app) {
  const { sid } = await guard(app);
  const runs = [];
  for (const how of ["Latest messages button", "End key"]) {
    const opened = await openAtTop(app, sid);
    let action;
    const t0 = Date.now();
    if (how === "End key") {
      action = await app.ev(page("host().focus(); return { focused: document.activeElement === host() };"));
      await key(app, "End", "End", 35);
    } else {
      const button = await app.ev(page("const b = latestButton(); return b && shown(b) ? { ...rect(b), text: b.innerText.trim() } : null;"));
      action = { button: button?.text ?? null };
      if (button) await click(app, button);
    }
    const reached = await H_.waitFor(async () => {
      const w = await app.ev(page("return win();"));
      return w.fromBottom <= 80 && w.windowEnd === w.entryCount ? w : null;
    }, 10_000, 50);
    const msToEnd = reached ? Date.now() - t0 : null;
    await sleep(1_500);
    const after = await app.ev(page("return win();"));
    const verdict = {
      openedAtTop: opened.windowStart === 0 && opened.scrollTop <= 10 && opened.firstVisibleIndex === 0,
      affordanceAtTop: opened.latestButton?.shown === true,
      atEnd: after.windowEnd === after.entryCount && after.fromBottom <= 80 && after.lastVisibleIndex === after.lastMountedIndex,
      domBound: opened.mountedArticles <= 160 && after.mountedArticles <= 160,
      affordanceGone: after.latestButton === null,
    };
    runs.push({ how, opened, action, msToEnd, after, verdict });
  }
  return { liveTurns: 0, runs, pass: runs.every((r) => Object.values(r.verdict).every(Boolean)) };
}

/** The selection, the text of its visible nodes, and every string the selected nodes hide. */
const SELECTION = page(`
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const entryOf = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); const e = el && el.closest('[data-entry-index]'); return e ? Number(e.dataset.entryIndex) : null; };
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 1 ? common : common.parentElement;
  const hidden = new Set();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el !== root && !range.intersectsNode(el)) continue;
    for (const name of ['aria-label', 'title', 'alt', 'placeholder']) { const v = (el.getAttribute(name) || '').trim(); if (v) hidden.add(v); }
    const cs = getComputedStyle(el);
    if (el.classList.contains('sr-only') || el.getAttribute('aria-hidden') === 'true' || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
      const t = (el.textContent || '').trim();
      if (t) hidden.add(t);
    }
  }
  const visible = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const el = n.parentElement;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest('.sr-only, [aria-hidden="true"]')) continue;
    let text = n.data.slice(n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : n.data.length);
    if (getComputedStyle(el).textTransform === 'uppercase') text = text.toUpperCase();
    visible.push(text);
  }
  return { text: sel.toString(), anchorEntry: entryOf(sel.anchorNode), focusEntry: entryOf(sel.focusNode), visibleText: visible.join(' '), hiddenStrings: [...hidden] };
`);

/** A Browser.* command on the browser endpoint, for builds that refuse it on the page session. */
async function browserCommand(method, params) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, ko) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", () => ko(new Error("browser socket error")), { once: true });
  });
  try {
    return await new Promise((ok, ko) => {
      const timer = setTimeout(() => ko(new Error(`${method}: timed out`)), 10_000);
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.id !== 1) return;
        clearTimeout(timer);
        if (frame.error) ko(new Error(frame.error.message));
        else ok(frame.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

async function readClipboardOverCdp(app) {
  const origin = await app.ev("location.origin");
  const permissions = ["clipboardReadWrite", "clipboardSanitizedWrite"];
  let granted = "page session";
  try {
    await app.send("Browser.grantPermissions", { origin, permissions });
  } catch (error) {
    try {
      await browserCommand("Browser.grantPermissions", { origin, permissions });
      granted = "browser session";
    } catch (second) {
      granted = `refused: ${String(error.message).slice(0, 100)}; ${String(second.message).slice(0, 100)}`;
    }
  }
  await app.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  const read = await app.ev(`Promise.race([
    navigator.clipboard.readText().then((text) => ({ read: true, text }), (error) => ({ read: false, reason: String((error && error.message) || error) })),
    new Promise((done) => setTimeout(() => done({ read: false, reason: 'no answer in 4 s' }), 4000)),
  ])`);
  await app.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
  return { granted, ...read };
}

/** The Windows clipboard, read only right after this copy put the selection there. */
function readOsClipboard() {
  try {
    const text = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"], { encoding: "utf8", timeout: 20_000 });
    return { read: true, text: text.replace(/\r?\n$/, "") };
  } catch (error) {
    return { read: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

/** No turn: (3) a mouse drag from one entry into the next, Ctrl+C, then what each reader of the copy gets. */
async function copy(app) {
  await guard(app);
  await toLatest(app);
  const pair = await app.ev(page(`
    const a = entries().find((n) => (n.textContent || '').includes(${J(SELECT_A)}));
    const b = entries().find((n) => (n.textContent || '').includes(${J(SELECT_B)}));
    if (!a || !b) return null;
    a.scrollIntoView({ block: 'center' });
    await pause(800);
    const charAt = (entry, word, last) => {
      const walk = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.data.indexOf(word);
        if (i < 0) continue;
        const at = last ? i + word.length - 1 : i;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + 1);
        const b = r.getBoundingClientRect();
        return { x: last ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
      }
      return null;
    };
    return { a: Number(a.dataset.entryIndex), b: Number(b.dataset.entryIndex), from: charAt(a, 'bravo', false), to: charAt(b, 'golf', true) };
  `));
  if (!pair?.from || !pair?.to) throw new Error("the selection pair is not in view");
  await app.ev(`(() => {
    window.__m113copy = [];
    if (!window.__m113copySpy) { document.addEventListener('copy', () => window.__m113copy.push(String(getSelection())), true); window.__m113copySpy = true; }
    getSelection().removeAllRanges();
    return true;
  })()`);
  await drag(app, pair.from, pair.to);
  await sleep(300);
  const selection = await app.ev(SELECTION);
  if (!selection) throw new Error("the drag selected nothing");
  await key(app, "c", "KeyC", 67, 2);
  await sleep(500);
  let copyPath = "Ctrl+C";
  let copies = await app.ev("window.__m113copy.length");
  if (copies === 0) {
    copyPath = "document.execCommand('copy') under a CDP user gesture";
    await app.send("Runtime.evaluate", { expression: "document.execCommand('copy')", userGesture: true });
    await sleep(300);
    copies = await app.ev("window.__m113copy.length");
  }
  const norm = (text) => String(text ?? "").replace(/\r\n/g, "\n");
  const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const leaked = (text) => selection.hiddenStrings.filter((s) => norm(text).includes(s));
  // A read that is not the selection keeps only its size and hash: it could be the user's own clipboard.
  const judge = (r) => {
    if (!r.read) return r;
    const equal = norm(r.text) === norm(selection.text);
    return { ...r, text: equal ? norm(r.text) : undefined, chars: r.text.length, sha256: equal ? undefined : sha256(r.text).slice(0, 16), equalsSelection: equal, hiddenStringsFound: leaked(r.text) };
  };
  const cdp = copies > 0 ? judge(await readClipboardOverCdp(app)) : { read: false, reason: "no copy event" };
  const os = copies > 0 ? judge(readOsClipboard()) : { read: false, reason: "no copy event" };
  await app.send("Browser.resetPermissions", {}).catch(() => undefined);
  const verdict = {
    spansTwoEntries: selection.anchorEntry === pair.a && selection.focusEntry === pair.b && pair.b === pair.a + 1,
    selectionFromBravoToGolf: selection.text.startsWith("bravo") && selection.text.endsWith("golf"),
    copyEventFired: copies > 0,
    copyEventSawTheSelection: copies > 0 && norm(await app.ev("window.__m113copy[0]")) === norm(selection.text),
    clipboardOverCdpEqualsSelection: cdp.read ? cdp.equalsSelection : null,
    osClipboardEqualsSelection: os.read ? os.equalsSelection : null,
    noHiddenStringCopied: leaked(selection.text).length === 0 && (cdp.hiddenStringsFound ?? []).length === 0 && (os.hiddenStringsFound ?? []).length === 0,
    selectionIsItsVisibleText: flat(selection.visibleText) === flat(selection.text),
  };
  const clipboard = verdict.clipboardOverCdpEqualsSelection ?? verdict.osClipboardEqualsSelection;
  const pass = verdict.spansTwoEntries && verdict.selectionFromBravoToGolf && verdict.copyEventFired && clipboard === true
    && verdict.osClipboardEqualsSelection !== false && verdict.noHiddenStringCopied && verdict.selectionIsItsVisibleText;
  return { liveTurns: 0, pair, copyPath, selection, clipboardOverCdp: cdp, osClipboard: os, verdict, pass };
}

/** Ctrl+F, the needle, ArrowDown, Enter: the render cost until `ready` (a page predicate) holds. */
async function finderJump(app, needle, ready) {
  await app.ev(page("host().focus(); return true;"));
  await key(app, "f", "KeyF", 70, 2);
  await sleep(600);
  const typed = await app.ev(page(`const f = document.querySelector('input[aria-label="Search messages"]'); if (!f) return false; setValue(f, ${J(needle)}); f.focus(); return true;`));
  if (!typed) throw new Error("the finder did not open");
  await sleep(800);
  const hits = await app.ev("document.querySelectorAll('#conversation-search-results [role=\"option\"]').length");
  await key(app, "ArrowDown", "ArrowDown", 40);
  await sleep(200);
  await app.ev(`(() => {
    window.__m113lt = [];
    if (!window.__m113ltObserver) {
      window.__m113ltObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__m113lt.push(Math.round(e.duration)); });
      window.__m113ltObserver.observe({ type: 'longtask' });
    }
    return true;
  })()`);
  const before = metricsOf(await app.send("Performance.getMetrics"));
  const t0 = Date.now();
  await key(app, "Enter", "Enter", 13, 0, "\r");
  const mounted = await H_.waitFor(() => app.ev(page(ready)), 15_000, 50);
  const msToMounted = mounted ? Date.now() - t0 : null;
  await sleep(2_000);
  const after = metricsOf(await app.send("Performance.getMetrics"));
  const longTasks = await app.ev("window.__m113lt.splice(0)");
  const status = await app.ev("document.querySelector('.stream-find-count')?.innerText ?? null");
  await key(app, "Escape", "Escape", 27);
  await sleep(500);
  return {
    needle, hits, status, msToMounted, cost: costBetween(before, after),
    longTasks: { count: longTasks.length, maxMs: longTasks.length ? Math.max(...longTasks) : 0, totalMs: longTasks.reduce((n, d) => n + d, 0) },
  };
}

const BLOCK_CODE = "[...host().querySelectorAll('.message-code code')].find((c) => c.textContent.startsWith('BIGBLOCK-LINE-00001'))";
/** Where the viewport's centre falls: the code line under it, or the entry. */
const AT_CENTER = page(`
  const h = host();
  const b = h.getBoundingClientRect();
  const caret = document.caretRangeFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  const node = caret ? caret.startContainer : null;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const inCode = Boolean(el && el.closest('.message-code code') && node.nodeType === 3);
  const entry = el ? el.closest('[data-entry-index]') : null;
  return { scrollTop: Math.round(h.scrollTop), line: inCode ? node.data.slice(0, caret.startOffset).split('\\n').length : null,
    entryIndex: entry ? Number(entry.dataset.entryIndex) : null, text: inCode ? null : (entry ? (entry.textContent || '').replace(/\\s+/g, ' ').slice(0, 50) : null) };
`);

/** No turn: (4) a 5,000-line code block outside the window, reached by the finder; the log put back after. */
async function block(app) {
  const { sid } = await guard(app);
  const key_ = `muse-desktop.log.v1.${sid}`;
  const original = await app.ev(`localStorage.getItem(${J(key_)})`);
  const log = parse(original);
  if (!Array.isArray(log) || log.length <= 1_200) throw new Error("the conversation is not long: run load first");
  const at = log.length - 1_000;
  const lines_ = Array.from({ length: BLOCK_LINES }, (_, k) => `BIGBLOCK-LINE-${String(k + 1).padStart(5, "0")} const value${k + 1} = compute(${k + 1}); // line of the large block`);
  const text = `A large block follows (${BLOCK_LINES} lines).\n\n\`\`\`ts\n${lines_.join("\n")}\n\`\`\`\n`;
  const entry = { clientMessageId: "bigblock", id: "bigblock", role: "assistant", text, ts: log[at - 1].ts + 1 };
  let result = null;
  try {
    await app.ev(`(localStorage.setItem(${J(key_)}, ${J(JSON.stringify([...log.slice(0, at), entry, ...log.slice(at)]))}), true)`);
    await reloadPage(app);
    await openConversation(app, sid);
    const start = await toLatest(app);
    await app.send("Performance.enable", {});
    // A jump to a plain entry first: the same window move without the block, as the baseline.
    const plainNeedle = `Long transcript entry ${at - 700} —`;
    const baseline = await finderJump(app, plainNeedle, `return entries().some((n) => (n.textContent || '').includes(${J(plainNeedle)}));`);
    const big = await finderJump(app, "BIGBLOCK-LINE-02500", `const c = ${BLOCK_CODE}; return Boolean(c) && c.getBoundingClientRect().height > 50000;`);
    const dom = await app.ev(page(`
      const c = ${BLOCK_CODE};
      const e = c.closest('[data-entry-index]');
      return { entryIndex: Number(e.dataset.entryIndex), entryElements: e.querySelectorAll('*').length,
        codeTextNodes: [...c.childNodes].filter((n) => n.nodeType === 3).length, codeLines: c.textContent.split('\\n').length,
        codeHeightPx: Math.round(c.getBoundingClientRect().height), entryHeightPx: Math.round(e.getBoundingClientRect().height),
        documentElements: document.querySelectorAll('*').length, window: win() };
    `));
    const center = await app.ev(page("const c = rect(host()); return { x: c.x, y: c.y };"));
    const steps = [{ step: "landed", ...(await app.ev(AT_CENTER)) }];
    for (let i = 0; i < 6; i += 1) { await wheel(app, center, 600); await sleep(600); steps.push({ step: "wheel +600", ...(await app.ev(AT_CENTER)) }); }
    await app.ev(page("host().focus(); return true;"));
    for (let i = 0; i < 2; i += 1) { await key(app, "PageDown", "PageDown", 34); await sleep(400); steps.push({ step: "PageDown", ...(await app.ev(AT_CENTER)) }); }
    // Near the block's last lines, then on past its end and back.
    await app.ev(page(`const h = host(); const e = ${BLOCK_CODE}.closest('[data-entry-index]');
      h.scrollTop += e.getBoundingClientRect().bottom - h.getBoundingClientRect().top - h.clientHeight / 2 - 300; return true;`));
    await sleep(600);
    steps.push({ step: "near the end", ...(await app.ev(AT_CENTER)) });
    for (let i = 0; i < 6; i += 1) { await wheel(app, center, 600); await sleep(600); steps.push({ step: "wheel +600", ...(await app.ev(AT_CENTER)) }); }
    for (let i = 0; i < 6; i += 1) { await wheel(app, center, -600); await sleep(600); steps.push({ step: "wheel -600", ...(await app.ev(AT_CENTER)) }); }
    // Reading order: a code line, the block's own footer, an entry after it; a gap between entries is unknown.
    const position = (s) => (s.line !== null ? s.line : s.entryIndex === null ? null
      : s.entryIndex === dom.entryIndex ? BLOCK_LINES + 0.5 : s.entryIndex > dom.entryIndex ? BLOCK_LINES + (s.entryIndex - dom.entryIndex) * 1000 : -1);
    const ordered = (list, direction) => {
      const known = list.filter((s) => position(s) !== null);
      return known.every((s, i) => i === 0 || direction * (position(s) - position(known[i - 1])) >= 0);
    };
    const inBlock = steps.slice(0, 9);
    const pastEnd = steps.slice(9, 16);
    const back = steps.slice(15);
    const verdict = {
      boundedDom: dom.entryElements <= 40 && dom.codeTextNodes === 1 && dom.window.mountedArticles <= 160,
      allLinesRendered: dom.codeLines === BLOCK_LINES,
      blockLayoutMs: big.cost.layoutMs,
      baselineLayoutMs: baseline.cost.layoutMs,
      longestTaskMs: big.longTasks.maxMs,
      scrollsForwardThroughTheBlock: inBlock.every((s, i) => s.line !== null && (i === 0 || (s.scrollTop > inBlock[i - 1].scrollTop && s.line > inBlock[i - 1].line))),
      leavesTheBlockPastItsEnd: pastEnd.some((s) => s.entryIndex > dom.entryIndex),
      inOrderPastTheEnd: ordered(pastEnd, 1),
      comesBackIntoTheBlock: back.at(-1).line !== null && ordered(back, -1),
    };
    const pass = verdict.boundedDom && verdict.allLinesRendered && verdict.scrollsForwardThroughTheBlock
      && verdict.leavesTheBlockPastItsEnd && verdict.inOrderPastTheEnd && verdict.comesBackIntoTheBlock;
    result = { liveTurns: 0, insertedAt: at, blockChars: text.length, start, baseline, block: big, dom, steps, verdict, pass };
  } finally {
    await app.ev(`(localStorage.setItem(${J(key_)}, ${J(original)}), true)`);
    await reloadPage(app);
    await openConversation(app, sid);
  }
  const putBack = await app.ev(`localStorage.getItem(${J(key_)}) === ${J(original)}`);
  return { ...result, logPutBackIdentical: putBack, pass: result.pass && putBack };
}

/** The contrast of a few entries, from getComputedStyle (WCAG 2 relative luminance). */
const CONTRAST = page(`
  const rgb = (c) => {
    let m = c.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = c.match(/^color\\(srgb ([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const backdrop = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    return layers.reverse().reduce((under, layer) => over(layer, under), { r: 255, g: 255, b: 255, a: 1 });
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const sample = (name, el) => {
    if (!el) return { name, found: false };
    const cs = getComputedStyle(el);
    const bg = backdrop(el);
    let fg = rgb(cs.color);
    if (fg.a < 1) fg = over(fg, bg);
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    return { name, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50), fg: hex(fg), bg: hex(bg), opacity,
      fontSizePx: size, fontWeight: weight, ratio: Math.round(ratio * 100) / 100, required, pass: opacity === 1 && ratio >= required };
  };
  const last = (selector) => [...host().querySelectorAll(selector)].at(-1) || null;
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const view = win();
  return {
    matchesDark: matchMedia('(prefers-color-scheme: dark)').matches, bodyDark: document.body.classList.contains('dark'),
    storedTheme: localStorage.getItem('muse-desktop.theme.v1'),
    tokens: Object.fromEntries(['--bg', '--surface', '--text', '--muted'].map((t) => [t, body.getPropertyValue(t).trim() || root.getPropertyValue(t).trim()])),
    rendered: { mountedArticles: view.mountedArticles, firstVisibleIndex: view.firstVisibleIndex, lastVisibleIndex: view.lastVisibleIndex },
    samples: [
      sample('user message text', last('.msg.user pre')),
      sample('user role label', last('.msg.user .role')),
      sample('assistant message text', last('.msg.assistant .message-content li, .msg.assistant .message-content p')),
      sample('assistant role label', last('.msg.assistant .role')),
      sample('assistant timestamp', last('.msg.assistant .ts')),
      sample('earlier assistant entry', [...host().querySelectorAll('.msg.assistant .message-content p')].find((p) => p.textContent.includes('SELECT-B')) || null),
      sample('window notice', host().querySelector('.stream-window-notice span')),
    ],
  };
`);

/** No turn: (5) light then dark through prefers-color-scheme with no stored theme; then a stored theme against the OS. */
async function theme(app) {
  const { sid } = await guard(app);
  const stored = await app.ev("localStorage.getItem('muse-desktop.theme.v1')");
  const runs = [];
  let storedAgainstOs = null;
  try {
    for (const scheme of ["light", "dark"]) {
      await app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await app.ev("(localStorage.removeItem('muse-desktop.theme.v1'), true)");
      await reloadPage(app);
      await openConversation(app, sid);
      await toLatest(app);
      const run = await app.ev(CONTRAST);
      run.shot = await shot(app, `m1-13-theme-${scheme}`);
      runs.push({ scheme, ...run, pass: run.matchesDark === (scheme === "dark") && run.bodyDark === (scheme === "dark")
        && run.rendered.mountedArticles > 0 && run.samples.every((s) => s.pass === true) });
    }
    // The theme the first launch wrote stays: does the OS preference still apply afterwards?
    await app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await app.ev("(localStorage.setItem('muse-desktop.theme.v1', 'light'), true)");
    await reloadPage(app);
    storedAgainstOs = await app.ev("({ osPrefersDark: matchMedia('(prefers-color-scheme: dark)').matches, storedTheme: localStorage.getItem('muse-desktop.theme.v1'), bodyDark: document.body.classList.contains('dark') })");
  } finally {
    await app.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
    await app.ev(stored === null ? "(localStorage.removeItem('muse-desktop.theme.v1'), true)" : `(localStorage.setItem('muse-desktop.theme.v1', ${J(stored)}), true)`);
    await reloadPage(app);
    await openConversation(app, sid);
  }
  return { liveTurns: 0, storedBefore: stored, runs, storedAgainstOs, pass: runs.length === 2 && runs.every((r) => r.pass) };
}

/** No turn: (6) the finder jump and reduced motion of the 05/10 record, replayed by its own harness. */
async function finder(app) {
  const { sid } = await guard(app);
  await toLatest(app);
  app.close();
  const out = join(BASE, "finder-jump.json");
  let child = null;
  try {
    execFileSync(process.execPath, [join("scripts", "cdp-finder-jump.mjs"), "--out", out], { encoding: "utf8", env: { ...process.env, MUSE_CDP_PORT: String(PORT) }, timeout: 300_000 });
  } catch (error) {
    child = String(error?.message ?? error).slice(0, 300);
  }
  const report = readJson(out, null);
  const again = await attach();
  try {
    await openConversation(again, sid);
    const view = await again.ev(page("return win();"));
    const v = report?.verdict ?? {};
    const verdict = { ...v, restoredIdentical: report?.restored?.identical === true, backOnTheTestConversation: view.entryCount > 600 };
    // Reduced motion is judged on screen: the hit lands once and stays (scrollTop alone also counts anchoring).
    const pass = v.jumpedOutsideWindow === true && v.statusAnnounced === true && v.smoothWithoutPreference === true
      && v.hitStillOnceLandedWhenReduced === true && v.domBound <= 160 && verdict.restoredIdentical;
    return { liveTurns: 0, harness: "node scripts/cdp-finder-jump.mjs --out <proof>\\finder-jump.json", childFailure: child, report, view, verdict, pass };
  } finally {
    again.close();
  }
}

async function stop() {
  const pid = state().pid;
  if (!pid) return { liveTurns: 0, closed: false, reason: "no pid" };
  const children = childPids(pid);
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await H_.waitFor(() => !alive(pid), 20_000, 1_000));
  if (!graceful) {
    forceKill(pid);
    await H_.waitFor(() => !alive(pid), 10_000, 1_000);
  }
  await sleep(2_000);
  saveState({ pid: null });
  return { liveTurns: 0, graceful, exited: !alive(pid), children: children.length, childrenAliveAfter: children.filter((p) => alive(p)).length };
}

const PHASES = { setup, load, stream, replay: (app) => stream(app, true), bottom, copy, block, theme, finder };

async function runPhase(name) {
  H_ = await import("./cdp-harness.mjs");
  mkdirSync(BASE, { recursive: true });
  let app = null;
  try {
    let result;
    if (name === "launch") ({ app, result } = await launch());
    else if (name === "stop") result = await stop();
    else if (PHASES[name]) {
      app = await attach({ allowTurn: name === "stream" });
      result = await PHASES[name](app);
    } else throw new Error(`unknown phase ${name}: launch, ${Object.keys(PHASES).join(", ")}, stop`);
    const stored = merge(arg("--as", name), { ...result, pageErrors: app ? app.errors.slice(0, 20) : [] });
    process.stdout.write(`${JSON.stringify(stored.verdict ?? stored, null, 2)}\n`);
  } catch (error) {
    merge(arg("--as", name), { liveTurns: liveTurnSent ? 1 : 0, failure: String(error?.message ?? error).slice(0, 400), pageErrors: app ? app.errors.slice(0, 20) : [], pass: false });
    throw error;
  } finally {
    app?.close();
  }
}

await (PHASE ? runPhase(PHASE) : main()).catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
