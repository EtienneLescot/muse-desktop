#!/usr/bin/env node

/**
 * M1-05 (terminal) and M3-02 (remote MCP) native acceptance: the plan criteria
 * the 05/10/2026 audit found without evidence. No model turn.
 *
 * Phases, each in its own launch of the dev build (results merge into --out,
 * path-free):
 *   inspect   read-only: the connector registry, the posture, the default folder.
 *   terminal  A test conversation in <base>\project, created once: its first
 *             message is refused by the harness IPC guard, so no turn is ever
 *             sent; the default folder points there for the start only. In its
 *             Terminal panel, through the real input and the real PTY:
 *             - Unicode (é, € and 😀): chcp, echo, the code points a program reads from
 *               the typed line, a UTF-8 file before and after `chcp 65001`, then
 *               1,500 lines and 4,000 CJK lines (~240 KB) of multibyte output,
 *               checked in the DOM and in the raw terminal_read stream;
 *             - a long-running node HTTP server (one tick a second, one line per
 *               request) kept across a work-tab change and a page change; the
 *               harness requests it while it is hidden; every tick and hit must
 *               show once the panel is back, on the same terminal id;
 *             - Close with the server running: the app's process tree by PID and
 *               creation time before/after (shell, ConPTY host, server) and the
 *               port refused; then a fresh terminal (restart); then `exit` typed
 *               in the shell; then a server left running while the app is closed
 *               from its window (WM_CLOSE), the tree read after the exit.
 *   mcp       Extensions > Remote MCP connector form, no token ever entered:
 *             a private address, an unresolvable host, two blackholed public
 *             addresses, a non-MCP page (no CORS), a non-MCP JSON echo (CORS), a
 *             401 responder, expired and self-signed TLS, then a real MCP server
 *             (mcp.deepwiki.com): connect, a real tools/call, the endpoint blocked
 *             in the webview network stack (CDP Network.setBlockedURLs) as a
 *             disconnection, the next call, Reconnect. A new "proof-remote"
 *             connector is removed afterwards; when the registry already holds an
 *             earlier campaign's DeepWiki connector (single-remote plan), the
 *             scenarios run under its name and leave it as found. Any other
 *             remote blocks the phase, and a stored bearer is never let out to
 *             another host.
 *   verdict   no app: recomputes the verdicts and the summary of every run in --out.
 *
 * Usage:
 *   node scripts/cdp-m1-05-m3-02-terminal-mcp.mjs [inspect|terminal|mcp|verdict ...]  (default: terminal mcp)
 *     [--base G:\muse-proofs\terminal-mcp] [--build pre-fix|fixed]
 *     [--exe G:\muse-build\cool-rubin-target\debug\muse-desktop.exe]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m1-05-m3-02-terminal-mcp.json]
 * The harness launches and stops the app itself (MUSE_NO_AUTO_UPDATE=1, CDP on
 * MUSE_CDP_PORT or 9222) and refuses to run beside another muse-desktop process.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const VALUE_FLAGS = new Set(["--base", "--build", "--exe", "--out"]);
const ASKED = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !VALUE_FLAGS.has(all[i - 1]));
const PHASES = ASKED.length > 0 ? ASKED : ["terminal", "mcp"];
const BASE = argValue("--base", "G:\\muse-proofs\\terminal-mcp");
const BUILD = argValue("--build", "fixed");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m1-05-m3-02-terminal-mcp.json");
const TARGET = join(dirname(EXE), "muse.exe");
const PROJECT = join(BASE, "project");
const STATE_FILE = join(BASE, "harness-state.json");
const SHOTS = "docs/evidence/2026-10-05-roadmap-closure/shots";
// e-acute, euro sign, grinning face. Built from code points: an e-acute written next to
// another non-ASCII character reads as cp1252 mojibake to test/encoding.test.ts.
const UNICODE = String.fromCodePoint(0xe9, 0x20ac, 0x1f600);
const LONG_LINES = 1500;
const WIDE_LINES = 4000;
const REMOTE_NAME = "proof-remote";
const REMOTE_ID = `remote-${REMOTE_NAME}`;
const DEEPWIKI = "https://mcp.deepwiki.com/mcp";
const redactPaths = redactor([[PROJECT, "<test project>"], [BASE, "<proof>"]]);

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE_FILE, {});
const saveState = (patch) => writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...patch }, null, 2));

// ---- fixtures -----------------------------------------------------------------

const FIXTURES = {
  "server.js": `// M1-05 proof: a long-running HTTP server that keeps writing to the terminal.
const http = require("node:http");
let hits = 0;
let ticks = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  console.log(\`hit \${hits} \${req.url}\`);
  res.end(\`ok \${hits} pid \${process.pid}\`);
});
server.listen(0, "127.0.0.1", () => console.log(\`listening \${server.address().port} pid \${process.pid}\`));
setInterval(() => { ticks += 1; console.log(\`tick \${ticks}\`); }, 1000);
`,
  "cp.js": `// M1-05 proof: print the code points of one line typed into the terminal.
process.stdout.write("CP-READY\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {
  console.log(\`CP:\${[...line].map((c) => c.codePointAt(0).toString(16)).join(",")}\`);
  process.exit(0);
});
`,
  "long.js": `// M1-05 proof: a long multibyte output, many PTY reads long ("wide": 3-byte CJK, ~58 bytes a line).
const lines = Number(process.argv[2] || 1500);
const wide = process.argv[3] === "wide";
for (let i = 1; i <= lines; i += 1) {
  const n = String(i).padStart(4, "0");
  console.log(wide ? \`W\${n} 中文字符測試漢字中文字符測試漢字😀\` : \`U\${n} ${UNICODE} 中文 ✓ ${UNICODE}\`);
}
console.log(\`LONG-DONE \${lines}\`);
`,
  "utf8.txt": `UTF8-FILE ${UNICODE} 中文 ✓\r\n`,
};

function writeFixtures() {
  mkdirSync(PROJECT, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) writeFileSync(join(PROJECT, name), text);
  if (!existsSync(join(PROJECT, ".git"))) {
    // A repository keeps the Changes tab (the work panel's default) quiet.
    execFileSync("git", ["init", "-q"], { cwd: PROJECT });
    execFileSync("git", ["add", "-A"], { cwd: PROJECT });
    execFileSync("git", ["-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", "M1-05 proof fixtures"], { cwd: PROJECT });
  }
}

// ---- processes ------------------------------------------------------------------

function ps(command) {
  // "exit 0": Get-Process finding nothing is an answer, not a failure.
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", `${command}; exit 0`], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
}
const appProcesses = () => ps("Get-Process muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }")
  .split(/\s+/).filter(Boolean).map(Number);
const targetProcesses = () => ps(`Get-Process muse -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${TARGET}' } | ForEach-Object { $_.Id }`)
  .split(/\s+/).filter(Boolean).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every process with its creation time: a PID is only "the same process" with the same stamp. */
function processTable() {
  return ps("Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }")
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, name, created] = line.trim().split("|");
      return { pid: Number(pid), ppid: Number(ppid), name, created };
    });
}
const procKey = (p) => `${p.pid}@${p.created}`;
function descendants(table, root) {
  const out = [];
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of table) {
      if (row.ppid !== parent || seen.has(row.pid)) continue;
      seen.add(row.pid);
      out.push(row);
      queue.push(row.pid);
    }
  }
  return out;
}
const stillAlive = (table, proc) => table.some((p) => p.pid === proc.pid && p.created === proc.created);
const brief = (p) => (p ? { pid: p.pid, ppid: p.ppid, name: p.name } : null);

/**
 * The terminals' own processes, new in the app's tree since `baseline`: the
 * ConPTY hosts and shells the app spawned, and everything under those shells.
 * (The Changes tab's git.exe and its console are not terminal processes.)
 */
function terminalTree(baseline) {
  const table = processTable();
  const fresh = descendants(table, appPid).filter((p) => !baseline.has(procKey(p)));
  const newest = (list) => list.reduce((a, b) => (a === null || BigInt(b.created) > BigInt(a.created) ? b : a), null);
  const hosts = fresh.filter((p) => /^(conhost|openconsole)\.exe$/i.test(p.name) && p.ppid === appPid);
  const shells = fresh.filter((p) => /^cmd\.exe$/i.test(p.name) && p.ppid === appPid);
  const under = shells.flatMap((shell) => descendants(table, shell.pid));
  return {
    table,
    procs: [...hosts, ...shells, ...under],
    shell: newest(shells),
    host: newest(hosts),
    nodes: under.filter((p) => /^node\.exe$/i.test(p.name)),
  };
}
/** FILETIME (100 ns since 1601) of a JS millisecond timestamp, to compare with creation stamps. */
const fileTime = (ms) => (BigInt(ms) + 11_644_473_600_000n) * 10_000n;

// ---- app lifecycle --------------------------------------------------------------

let appPid = null;
async function launch() {
  const foreign = appProcesses();
  if (foreign.length > 0) throw new Error(`blocked: foreign instance (${foreign.length} muse-desktop process not started by this harness)`);
  const child = spawn(EXE, [], {
    cwd: BASE,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  });
  child.unref();
  appPid = child.pid;
  const app = await waitFor(async () => { try { return await openPage(); } catch { return null; } }, 60_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 30_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(INSTALL_TAPS);
  return app;
}

/** Close this harness's instance from its window (WM_CLOSE), force only as a fallback. */
async function stopApp(app) {
  app?.close();
  if (appPid === null) return null;
  const pid = appPid;
  appPid = null;
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await waitFor(() => !alive(pid), 20_000));
  if (!graceful) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
    await waitFor(() => !alive(pid), 10_000);
  }
  await sleep(1_000);
  const leftovers = targetProcesses();
  for (const leftover of leftovers) { try { execFileSync("taskkill", ["/F", "/PID", String(leftover)], { stdio: "ignore" }); } catch { /* gone */ } }
  return { graceful, exited: !alive(pid), enginesLeftAndKilled: leftovers.length };
}

// ---- page side -------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/**
 * Taps above the shared IPC trace, which keeps only the last 400 calls (the
 * panel polls terminal_read every 180 ms): every terminal_open answer and
 * terminal_close outcome, the full terminal_read stream and read count per
 * terminal id, and every https request the page makes itself (the remote MCP
 * transport is the page's own fetch) with its duration and outcome.
 */
const INSTALL_TAPS = `(() => {
  if (window.__tmTaps) return 'already';
  const taps = window.__tmTaps = { raw: {}, reads: {}, opens: [], closes: [], net: [] };
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const ipc = url.match(/^https?:\\/\\/ipc\\.localhost\\/(terminal_read|terminal_open|terminal_close)/);
    if (ipc) {
      const response = await inner(input, init);
      const ok = response.headers.get('Tauri-Response') === 'ok';
      try {
        const value = JSON.parse(await response.clone().text());
        if (ipc[1] === 'terminal_read' && ok && value && typeof value.terminalId === 'string') {
          taps.raw[value.terminalId] = (taps.raw[value.terminalId] || '') + (value.output || '');
          taps.reads[value.terminalId] = (taps.reads[value.terminalId] || 0) + 1;
        }
        if (ipc[1] === 'terminal_open') taps.opens.push(ok ? value : { error: String(value).slice(0, 300) });
        if (ipc[1] === 'terminal_close') taps.closes.push({ ok, error: ok ? null : String(value).slice(0, 300) });
      } catch { /* not JSON */ }
      return response;
    }
    if (!/^https:/.test(url)) return inner(input, init);
    const entry = { url, host: new URL(url).host, method: (init && init.method) || 'GET', t0: Date.now() };
    try { entry.rpc = JSON.parse(init && init.body).method || null; } catch { entry.rpc = null; }
    taps.net.push(entry);
    // Safety net: a probe under an existing connector's name re-reads its stored
    // bearer (if any) from the native store. Never let it leave for a host
    // other than the one it was stored for; the phase then stops as blocked.
    const headers = (init && init.headers) || {};
    if ((headers.Authorization || headers.authorization) && entry.host !== 'mcp.deepwiki.com') {
      taps.bearerRefused = true;
      entry.ms = 0;
      entry.error = 'refused by the test harness';
      throw new TypeError('refused by the test harness');
    }
    try {
      const response = await inner(input, init);
      entry.ms = Date.now() - entry.t0;
      entry.status = response.status;
      entry.contentType = response.headers.get('content-type');
      return response;
    } catch (error) {
      entry.ms = Date.now() - entry.t0;
      entry.error = String((error && error.name) || 'Error') + ': ' + String((error && error.message) || error);
      throw error;
    }
  };
  return 'installed';
})()`;

const calls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})`);

async function shot(app, selector, name) {
  const clip = await app.ev(page(`const n = q(${JSON.stringify(selector)})[0]; if (!n) return null; n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 1400), height: Math.min(r.height, 900), scale: 1 };`));
  if (!clip || clip.width < 1 || clip.height < 1) return null;
  mkdirSync(SHOTS, { recursive: true });
  const capture = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(capture.data, "base64"));
  return `shots/${name}.png`;
}

/** Settings > Change folder, the OS dialog answered with `folder` (the project list is full). */
async function setDefaultFolder(app, folder) {
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  return app.ev(page(`
    document.querySelector('button.account[aria-label="Settings"]')?.click();
    await pause(800);
    const b = q('.workspace-picker button.workspace-button')[0];
    if (!b) return { clicked: false, applied: false };
    b.click();
    await pause(1200);
    return { clicked: true, applied: store('muse-desktop.workspace.v1', 'null') === ${JSON.stringify(folder)} };
  `));
}

/** Sidebar click: also closes Settings and destination pages. */
async function selectConversation(app, sid) {
  const found = await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  if (!found) return false;
  return Boolean(await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)} && !document.querySelector('.settings-panel');`)), 15_000, 300));
}

/**
 * The test conversation, created once in <base>\project. Its first message is
 * refused by the harness IPC guard (`send_input` blocked), then discarded: no
 * turn ever reaches the engine.
 */
async function ensureConversation(app) {
  const known = state().sid;
  if (known && await selectConversation(app, known)) return { sid: known, reused: true };
  const userFolder = await app.ev(page("return store('muse-desktop.workspace.v1', 'null');"));
  if (typeof userFolder !== "string") throw new Error("no default folder to restore afterwards; refusing to change it");
  saveState({ userFolder });
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  let switched = false;
  const facts = { reused: false };
  try {
    switched = (await setDefaultFolder(app, PROJECT)).applied;
    if (!switched) throw new Error("could not point the default folder at the test folder");
    await app.ev(page(`
      sessionStorage.removeItem('muse-desktop.welcome-environment');
      q('.primary-nav button').find((n) => /Automations/.test(n.innerText))?.click();
      await pause(700);
      q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
      await pause(1200);
      return true;
    `));
    const folderName = PROJECT.split(/[\\/]/).pop();
    const picked = await app.ev(page(`
      const trigger = document.querySelector('.project-trigger-name')?.textContent.trim() ?? null;
      const inTestFolder = (document.body.innerText || '').includes(${JSON.stringify(`Runs in ${folderName} with the global settings`)});
      if (trigger !== 'Choose a project' || !inTestFolder) return { clicked: false, trigger, inTestFolder };
      setValue(document.querySelector('textarea[aria-label="Your first message"]'), 'M1-05 terminal proof. The harness refuses this message: it is never sent.');
      await pause(300);
      const start = document.querySelector('button.welcome-send');
      if (!start || start.disabled) return { clicked: false, startDisabled: true };
      start.click();
      return { clicked: true };
    `));
    if (!picked.clicked) throw new Error(`refusing to start outside the test folder: ${JSON.stringify(picked)}`);
    const started = await waitFor(async () => {
      const list = await calls(app, "start_session");
      return list.length > 0 && list.at(-1).result ? list.at(-1) : null;
    }, 90_000);
    const sid = started?.ok ? JSON.parse(started.result).session_id : null;
    if (!sid) throw new Error(`start_session failed: ${JSON.stringify(started)?.slice(0, 300)}`);
    saveState({ sid });
    facts.startedInTestFolder = started.args?.workspacePath === PROJECT;
    await waitFor(() => app.ev(page("return q('.pending-send').length > 0;")), 20_000);
    const sends = await calls(app, "send_input");
    facts.firstMessageRefusedByHarness = sends.length > 0 && sends.every((c) => c.blockedByHarness === true);
    for (let i = 0; i < 4; i++) {
      const discarded = await app.ev(page("const b = q('.pending-send button').find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); return !!b;"));
      if (!discarded) break;
      await sleep(800);
    }
    facts.outboxAfterDiscard = await app.ev(page(`return (store('muse-desktop.outbox.v1.${sid}', '[]') || []).length;`));
    return { sid, ...facts };
  } finally {
    if (switched) facts.defaultFolderRestored = (await setDefaultFolder(app, userFolder).catch(() => ({ applied: false }))).applied;
    await app.ev("(window.__baselineIpc.block = [], true)");
    const sid = state().sid;
    if (sid) await selectConversation(app, sid);
  }
}

// ---- terminal --------------------------------------------------------------------

const termText = async (app) => (await app.ev("document.querySelector('pre.terminal-output')?.textContent ?? null")) ?? "";
const taps = (app) => app.ev("({ opens: window.__tmTaps.opens, closes: window.__tmTaps.closes, reads: window.__tmTaps.reads })");
const readCount = async (app) => Object.values((await taps(app)).reads).reduce((n, k) => n + k, 0);

async function workTab(app, label) {
  return app.ev(page(`
    if (!document.querySelector('nav.work-tabs')) { document.querySelector('button[aria-label="Show work panel"]')?.click(); await pause(500); }
    const tab = q('nav.work-tabs button').find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return false;
    tab.click();
    await pause(400);
    return true;
  `));
}

/** The panel's real input: CDP inserts the text into the focused field, then the Send button. */
async function typeLine(app, line) {
  await app.ev("(document.querySelector('form.terminal-input input').focus(), true)");
  await app.send("Input.insertText", { text: line });
  await sleep(150);
  return app.ev("(() => { const b = document.querySelector('form.terminal-input button[type=submit]'); if (!b || b.disabled) return false; b.click(); return true; })()");
}

let currentTerminal = null;
const rawLength = async (app) => (currentTerminal ? app.ev(`(window.__tmTaps.raw[${JSON.stringify(currentTerminal)}] || '').length`) : 0);
const rawSince = async (app, from) => (currentTerminal ? app.ev(`(window.__tmTaps.raw[${JSON.stringify(currentTerminal)}] || '').slice(${from})`) : "");

/** Type a line and wait until the output added since then satisfies `until`; `raw` is the PTY text of the step. */
async function run(app, line, until, timeoutMs = 10_000) {
  const before = await termText(app);
  const rawFrom = await rawLength(app);
  const sent = await typeLine(app, line);
  const added = await waitFor(async () => {
    const text = await termText(app);
    const tail = text.startsWith(before) ? text.slice(before.length) : text;
    return until(tail) ? tail : null;
  }, timeoutMs, 250);
  await sleep(200);
  const raw = await rawSince(app, rawFrom);
  if (added) return { sent, ok: true, added, raw };
  const text = await termText(app);
  return { sent, ok: false, added: text.startsWith(before) ? text.slice(before.length) : text.slice(-2000), raw };
}

const opensSoFar = async (app) => (await taps(app)).opens.length;

/** Wait for a (re)opened terminal: a new terminal_open answer and the prompt of the test folder. */
async function awaitTerminal(app, openedBefore) {
  const opened = await waitFor(async () => {
    const list = (await taps(app)).opens;
    return list.length > openedBefore ? list.at(-1) : null;
  }, 20_000, 300);
  if (!opened || opened.error) return { opened: null, error: opened?.error ?? "no terminal_open" };
  const prompt = await waitFor(async () => ((await termText(app)).includes(`${PROJECT}>`) ? true : null), 20_000, 300);
  return { opened, prompt: Boolean(prompt) };
}

// No line anchors: the panel strips cursor sequences, so a repaint can glue two lines.
const ticksIn = (text) => [...text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
const HIT_URL = /hit (\d+) (\/(?:visible|hidden-tab|hidden-page)-\d|\/after-close|\/before-exit|\/after-exit)/g;
const hitsIn = (text) => [...text.matchAll(HIT_URL)].map((m) => ({ n: Number(m[1]), url: m[2] }));
function loneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) i++;
    else if (c >= 0xd800 && c <= 0xdfff) n++;
  }
  return n;
}
const replacements = (s) => s.split("\ufffd").length - 1;

async function request(port, path) {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
    return { path, status: response.status, body: await response.text(), ms: Date.now() - started };
  } catch (error) {
    return { path, error: String(error?.cause?.code ?? error?.name ?? error), ms: Date.now() - started };
  }
}

async function unicodeChecks(app, terminalId) {
  const out = {};
  const chcp = await run(app, "chcp", (a) => /:\s*\d{3,5}/.test(a));
  out.initialCodePage = Number(chcp.added.match(/(?:code page|codes active)\s*:\s*(\d+)/i)?.[1] ?? NaN);
  // The console echoes the typed command line, then echo prints its argument.
  const echo = await run(app, `echo ${UNICODE}`, (a) => a.split(UNICODE).length - 1 >= 2);
  out.echo = {
    ok: echo.ok,
    occurrences: echo.added.split(UNICODE).length - 1,
    replacementChars: replacements(echo.added),
    shown: echo.added.slice(0, 240),
    raw: echo.raw.slice(0, 400),
  };
  const ready = await run(app, "node cp.js", (a) => a.includes("CP-READY"), 15_000);
  const cp = ready.ok ? await run(app, UNICODE, (a) => /CP:[0-9a-f,]+/.test(a)) : { ok: false, added: "" };
  out.inputCodePoints = {
    ok: cp.ok,
    read: cp.added.match(/CP:([0-9a-f,]+)/)?.[1] ?? null,
    expected: [...UNICODE].map((c) => c.codePointAt(0).toString(16)).join(","),
    shown: cp.added.slice(0, 160),
  };
  const before = await run(app, "type utf8.txt", (a) => /UTF8-FILE.*\r?\n/.test(a));
  const switched = await run(app, "chcp 65001", (a) => /65001/.test(a));
  const after = await run(app, "type utf8.txt", (a) => /UTF8-FILE.*\r?\n/.test(a));
  const fileLine = (text) => text.match(/UTF8-FILE[^\r\n]*/)?.[0] ?? null;
  out.utf8File = {
    expected: `UTF8-FILE ${UNICODE} 中文 ✓`,
    underInitialCodePage: fileLine(before.added),
    switchedTo65001: switched.ok,
    after65001: fileLine(after.added),
    shownAfter65001: after.added.slice(0, 200),
    rawAfter65001: after.raw.slice(0, 300),
  };
  const rawBefore = (await app.ev(`window.__tmTaps.raw[${JSON.stringify(terminalId)}] || ''`)).length;
  const readsBefore = await app.ev(`window.__tmTaps.reads[${JSON.stringify(terminalId)}] || 0`);
  const long = await run(app, `node long.js ${LONG_LINES}`, (a) => a.includes(`LONG-DONE ${LONG_LINES}`), 90_000);
  const raw = (await app.ev(`window.__tmTaps.raw[${JSON.stringify(terminalId)}] || ''`)).slice(rawBefore);
  const readsAfter = await app.ev(`window.__tmTaps.reads[${JSON.stringify(terminalId)}] || 0`);
  const rows = long.added.split(/\r?\n/);
  const numbered = rows.filter((l) => /^U\d{4}/.test(l));
  const intact = numbered.filter((l) => l.replace(/\s+/g, "") === `${l.slice(0, 5)}${UNICODE}中文✓${UNICODE}`);
  out.longOutput = {
    done: long.ok,
    lines: LONG_LINES,
    linesSeen: numbered.length,
    distinctLineNumbers: new Set(numbered.map((l) => l.slice(1, 5))).size,
    intactLines: intact.length,
    domReplacementChars: replacements(long.added),
    domLoneSurrogates: loneSurrogates(long.added),
    rawUtf16Units: raw.length,
    rawUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    rawReplacementChars: replacements(raw),
    rawLoneSurrogates: loneSurrogates(raw),
    terminalReadCalls: readsAfter - readsBefore,
    damagedSamples: numbered.filter((l) => !intact.includes(l)).slice(0, 5),
  };
  // Stress: ~240 KB of 3-byte characters, so PTY reads are likely to end mid-character.
  const wideRawFrom = await rawLength(app);
  const wide = await run(app, `node long.js ${WIDE_LINES} wide`, (a) => a.includes(`LONG-DONE ${WIDE_LINES}`), 120_000);
  const wideRaw = await rawSince(app, wideRawFrom);
  const wideRows = wide.added.split(/\r?\n/).filter((l) => /^W\d{4}/.test(l));
  const wideIntact = wideRows.filter((l) => l.replace(/\s+/g, "") === `${l.slice(0, 5)}中文字符測試漢字中文字符測試漢字😀`);
  out.wideOutput = {
    done: wide.ok,
    lines: WIDE_LINES,
    linesSeen: wideRows.length,
    intactLines: wideIntact.length,
    domReplacementChars: replacements(wide.added),
    domLoneSurrogates: loneSurrogates(wide.added),
    rawUtf8Bytes: Buffer.byteLength(wideRaw, "utf8"),
    rawReplacementChars: replacements(wideRaw),
    rawLoneSurrogates: loneSurrogates(wideRaw),
    damagedSamples: wideRows.filter((l) => !wideIntact.includes(l)).slice(0, 5),
  };
  return out;
}

/** The panel's empty-state control that opens a new terminal, if it has one. */
const PANEL_OPEN_CONTROL = `const panel = document.querySelector('section.terminal-panel');
  return panel && !panel.querySelector('pre.terminal-output')
    ? q('button', panel).map((b) => b.innerText.trim()).find((t) => /open|new terminal|restart/i.test(t)) || null
    : null;`;

/**
 * A fresh terminal after a Close: the one the panel reopened by itself (the
 * pre-fix behaviour after a remount), else the panel's own control, else a
 * remount (work tab away and back).
 */
async function freshTerminal(app, opensAtClose) {
  const now = await opensSoFar(app);
  let via;
  let opened;
  if (now > opensAtClose) {
    via = "reopened by itself right after Close";
    opened = { opened: (await taps(app)).opens.at(-1) };
    opened.prompt = Boolean(await waitFor(async () => ((await termText(app)).includes(`${PROJECT}>`) ? true : null), 20_000, 300));
  } else {
    const control = await app.ev(page(PANEL_OPEN_CONTROL));
    if (control) {
      via = `panel button "${control}"`;
      await app.ev(page(`const b = button(${JSON.stringify(control)}, document.querySelector('section.terminal-panel')); if (b) b.click(); return !!b;`));
    } else {
      via = "work-tab remount (no control in the panel)";
      await workTab(app, "Files");
      await workTab(app, "Terminal");
    }
    opened = await awaitTerminal(app, now);
  }
  if (opened.opened && !opened.opened.error) currentTerminal = opened.opened.terminalId;
  return { via, ...opened };
}

const panelState = (app) => app.ev(page(`
  const panel = document.querySelector('section.terminal-panel');
  return panel ? {
    terminalShown: Boolean(panel.querySelector('pre.terminal-output')),
    text: panel.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200),
    buttons: q('button', panel).map((b) => b.innerText.trim()).filter(Boolean),
  } : null;
`));

/** Click the panel's Close, then read the process table once things settle. */
async function closeTerminal(app, baseline, doomed) {
  const opensBefore = await opensSoFar(app);
  const before = terminalTree(baseline);
  const at = Date.now();
  const clicked = await app.ev("(() => { const b = document.querySelector('button.terminal-close'); if (b) b.click(); return !!b; })()");
  await sleep(3_000);
  const table = processTable();
  const doomedList = Object.values(doomed).filter(Boolean);
  const doomedPids = new Set(doomedList.map((p) => p.pid));
  const beforeKeys = new Set(before.procs.map(procKey));
  return {
    clicked,
    terminalCloseOk: (await taps(app)).closes.at(-1)?.ok ?? null,
    treeBefore: before.procs.map(brief),
    gone: Object.fromEntries(Object.entries(doomed).map(([role, p]) => [role, p ? !stillAlive(table, p) : null])),
    survivors: Object.entries(doomed).filter(([, p]) => p && stillAlive(table, p)).map(([role, p]) => ({ role, ...brief(p) })),
    // A child of a closed process still running (created before the click).
    orphanedChildren: table.filter((p) => doomedPids.has(p.ppid) && BigInt(p.created) < fileTime(at)
      && !doomedList.some((d) => d.pid === p.pid && d.created === p.created)).map(brief),
    reopenedByItself: (await opensSoFar(app)) - opensBefore,
    newAfterClose: terminalTree(baseline).procs.filter((p) => !beforeKeys.has(procKey(p))).map(brief),
    panelAfterClose: await panelState(app),
  };
}

async function terminalPhase() {
  writeFixtures();
  const result = { liveTurns: 0 };
  const app = await launch();
  let lastDoomed = null;
  let lastPort = NaN;
  try {
    result.conversation = await ensureConversation(app);
    const sid = result.conversation.sid;
    delete result.conversation.sid;
    if (!(await selectConversation(app, sid))) throw new Error("the test conversation is not selectable");
    // The terminal needs the conversation's workspace known to the bridge: after a
    // relaunch that is the host resuming it (boot resume, or an explicit Reconnect).
    const connected = () => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';"));
    result.conversation.connected = (await waitFor(connected, 30_000, 1_000)) ? "already" : null;
    if (!result.conversation.connected) {
      await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b) b.click(); return !!b;"));
      result.conversation.connected = (await waitFor(connected, 90_000, 1_000)) ? "after Reconnect" : "no";
    }

    // 1. Open: the shell and its ConPTY host join the app's tree.
    const baseline = new Set(descendants(processTable(), appPid).map(procKey));
    await workTab(app, "Changes");
    const openedBefore = await opensSoFar(app);
    await workTab(app, "Terminal");
    const first = await awaitTerminal(app, openedBefore);
    if (!first.opened) throw new Error(`no terminal opened: ${first.error}`);
    if (first.opened.cwd.toLowerCase() !== PROJECT.toLowerCase()) {
      await app.ev("(document.querySelector('button.terminal-close')?.click(), true)");
      throw new Error("the terminal did not open in the test folder; closed it");
    }
    const terminalId = first.opened.terminalId;
    currentTerminal = terminalId;
    let tree = terminalTree(baseline);
    result.open = {
      prompt: first.prompt,
      generation: first.opened.generation,
      shell: first.opened.shell.split(/[\\/]/).pop(),
      size: `${first.opened.cols}x${first.opened.rows}`,
      tree: tree.procs.map(brief),
    };
    const shellProc = tree.shell;
    const hostProc = tree.host;

    // 2. Unicode output and input.
    result.unicode = await unicodeChecks(app, terminalId);
    result.unicode.shot = await shot(app, "section.terminal-panel", `m1-05-a-unicode-${BUILD}`);

    // 3. Long-running server, visible.
    const started = await run(app, "node server.js", (a) => /listening \d+ pid \d+/.test(a), 20_000);
    const port = Number(started.added.match(/listening (\d+)/)?.[1] ?? NaN);
    const serverPid = Number(started.added.match(/listening \d+ pid (\d+)/)?.[1] ?? NaN);
    tree = terminalTree(baseline);
    const server = tree.nodes.find((p) => p.pid === serverPid) ?? null;
    const visible1 = await request(port, "/visible-1");
    await sleep(2_500);
    const s = { listening: started.ok, serverIsShellChild: server !== null && shellProc !== null && server.ppid === shellProc.pid, visible1 };
    const readsBeforeHide = await readCount(app);
    s.lastTickBeforeHide = Math.max(...ticksIn(await termText(app)));

    // 4. Work-tab change: the panel unmounts, the harness requests the server meanwhile.
    await workTab(app, "Files");
    s.panelUnmountedOnTabChange = await app.ev("document.querySelector('pre.terminal-output') === null");
    const hidden = [];
    for (let i = 1; i <= 3; i++) { await sleep(2_000); hidden.push(await request(port, `/hidden-tab-${i}`)); }
    s.terminalReadsWhileHidden = (await readCount(app)) - readsBeforeHide;
    s.hiddenTabRequests = hidden;
    await workTab(app, "Terminal");
    await waitFor(async () => hitsIn(await termText(app)).some((h) => h.url === "/hidden-tab-3"), 10_000, 300);

    // 5. Page change: the whole conversation view unmounts.
    await app.ev(page("q('.primary-nav button').find((n) => /Automations/.test(n.innerText))?.click(); await pause(800); return true;"));
    s.panelUnmountedOnPageChange = await app.ev("document.querySelector('pre.terminal-output') === null");
    const away = [];
    for (let i = 1; i <= 2; i++) { await sleep(2_000); away.push(await request(port, `/hidden-page-${i}`)); }
    s.hiddenPageRequests = away;
    await selectConversation(app, sid);
    await workTab(app, "Terminal");
    await waitFor(async () => hitsIn(await termText(app)).some((h) => h.url === "/hidden-page-2"), 10_000, 300);

    // 6. Still streaming while shown.
    const tickA = Math.max(...ticksIn(await termText(app)));
    await sleep(3_200);
    const shown = await termText(app);
    const tickB = Math.max(...ticksIn(shown));
    const ticks = ticksIn(shown);
    const firstTick = Math.min(...ticks);
    const missing = [];
    for (let n = firstTick; n <= tickB; n++) if (!ticks.includes(n)) missing.push(n);
    const readIds = new Set(Object.keys((await taps(app)).reads));
    Object.assign(s, {
      ticksAdvanceWhileShown: tickB - tickA,
      ticksSeen: ticks.length,
      tickRange: [firstTick, tickB],
      missingTicks: missing.slice(0, 20),
      duplicatedTicks: ticks.length - new Set(ticks).size,
      hitsShown: hitsIn(shown).map((h) => `${h.n} ${h.url}`),
      sameTerminalIdThroughout: readIds.size === 1 && readIds.has(terminalId),
      opensDuringViewChanges: (await opensSoFar(app)) - openedBefore - 1,
      serverAliveAfterViewChanges: server !== null && stillAlive(processTable(), server),
    });
    s.shot = await shot(app, "section.terminal-panel", `m1-05-b-server-after-view-changes-${BUILD}`);
    result.server = s;

    // 7. Close with the server running: shell, host and server must leave the tree.
    const opensAtClose = await opensSoFar(app);
    result.close = await closeTerminal(app, baseline, { shell: shellProc, host: hostProc, server });
    result.close.portAfterClose = Number.isFinite(port) ? await request(port, "/after-close") : null;
    result.close.shot = await shot(app, "section.terminal-panel", `m1-05-c-after-close-${BUILD}`);

    // 8. Restart: a fresh terminal in the same conversation.
    const second = await freshTerminal(app, opensAtClose);
    const echoed = second.opened ? await run(app, "echo restart-ok", (a) => a.replace(/echo restart-ok/g, "").includes("restart-ok")) : { ok: false };
    tree = terminalTree(baseline);
    result.restart = {
      via: second.via,
      opened: Boolean(second.opened),
      newTerminalId: second.opened ? second.opened.terminalId !== terminalId : null,
      generation: second.opened?.generation ?? null,
      prompt: second.prompt ?? false,
      newShell: tree.shell ? tree.shell.pid !== shellProc?.pid : null,
      commandRuns: echoed.ok,
    };

    // 9. `exit` typed in the shell: the panel must say so, and Close must clean up.
    const shell2 = tree.shell;
    const host2 = tree.host;
    const exitAt = Date.now();
    await typeLine(app, "exit");
    const exitShown = await waitFor(async () => ((await termText(app)).includes("[process exited]") ? Date.now() - exitAt : null), 8_000, 300);
    const afterExit = processTable();
    result.shellExit = {
      processExitedShownMs: exitShown,
      shellGone: shell2 ? !stillAlive(afterExit, shell2) : null,
      hostAliveUntilClose: host2 ? stillAlive(afterExit, host2) : null,
      panel: (await panelState(app))?.text?.slice(-120) ?? null,
    };
    const opensAtSecondClose = await opensSoFar(app);
    const secondClose = await closeTerminal(app, baseline, { host: host2 });
    result.shellExit.hostGoneAfterClose = secondClose.gone.host;
    result.shellExit.reopenedByItself = secondClose.reopenedByItself;
    result.shellExit.panelAfterClose = secondClose.panelAfterClose;

    // 10. A server left running while the app is closed from its window.
    const third = await freshTerminal(app, opensAtSecondClose);
    const lastServer = third.opened ? await run(app, "node server.js", (a) => /listening \d+ pid \d+/.test(a), 20_000) : { ok: false, added: "" };
    lastPort = Number(lastServer.added.match(/listening (\d+)/)?.[1] ?? NaN);
    const lastPid = Number(lastServer.added.match(/listening \d+ pid (\d+)/)?.[1] ?? NaN);
    tree = terminalTree(baseline);
    lastDoomed = { shell: tree.shell, host: tree.host, server: tree.nodes.find((p) => p.pid === lastPid) ?? null };
    result.appExit = {
      via: third.via,
      serverListening: lastServer.ok,
      before: Object.fromEntries(Object.entries(lastDoomed).map(([role, p]) => [role, brief(p)])),
      portBefore: Number.isFinite(lastPort) ? await request(lastPort, "/before-exit") : null,
    };
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    const at = Date.now();
    result.stop = await stopApp(app);
    if (lastDoomed && result.appExit) {
      const table = processTable();
      const doomedList = Object.values(lastDoomed).filter(Boolean);
      const doomedPids = new Set(doomedList.map((p) => p.pid));
      result.appExit.measured = result.stop?.graceful === true;
      result.appExit.gone = Object.fromEntries(Object.entries(lastDoomed).map(([role, p]) => [role, p ? !stillAlive(table, p) : null]));
      result.appExit.survivors = Object.entries(lastDoomed).filter(([, p]) => p && stillAlive(table, p)).map(([role, p]) => ({ role, ...brief(p) }));
      result.appExit.orphanedChildren = table.filter((p) => doomedPids.has(p.ppid) && BigInt(p.created) < fileTime(at)
        && !doomedList.some((d) => d.pid === p.pid && d.created === p.created)).map(brief);
      result.appExit.portAfterExit = Number.isFinite(lastPort) ? await request(lastPort, "/after-exit") : null;
    }
  }
  return result;
}

// ---- remote MCP ------------------------------------------------------------------

const REMOTE_PANEL = `
  const panel = document.querySelector('[aria-label="Connectors"]');
  const field = (label) => panel?.querySelector('input[aria-label="' + label + '"]') || null;
  const submit = () => [...(panel?.querySelectorAll('form.integration-form button[type=submit]') || [])]
    .find((b) => /connect|connecting/i.test(b.textContent)) || null;
  const statusRow = () => [...(panel?.querySelectorAll('.integration-remote-status') || [])]
    .map((row) => ({ text: row.innerText.replace(/\\s+/g, ' ').trim(), buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
  const facts = () => ({
    notice: [...(panel?.querySelectorAll('p.integration-notice') || [])].map((n) => n.textContent.trim()).filter((t) => !/^Connected to /.test(t)),
    connectedBlock: panel?.querySelector('[aria-label="Remote MCP connection result"] p')?.textContent.trim() ?? null,
    statusRows: statusRow(),
    callOutput: panel?.querySelector('[aria-label="Remote MCP connection result"] pre.local-mcp-output') ? true : false,
    registry: (store('muse-desktop.connectors.v1', '[]') || []).filter((e) => e && e.kind === 'remote')
      .map((e) => ({ id: e.id, name: e.name, status: e.status, url: e.url, tools: (e.tools || []).length, useInMuse: e.useInMuse === true, addedAt: e.addedAt ?? null, guardMessage: e.guardMessage || null })),
  });
`;
const remote = (body) => page(`${REMOTE_PANEL} ${body}`);

/** The remote section only (heading to the end of the panel): the rest lists the user's connectors. */
async function shotRemote(app, name) {
  const clip = await app.ev(remote(`
    const h = [...panel.querySelectorAll('h4')].find((n) => /^Remote MCP connector/.test(n.textContent.trim()));
    if (!h) return null;
    h.scrollIntoView({ block: 'start' });
    await pause(200);
    const top = h.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    return { x: box.x, y: top.y - 8, width: Math.min(box.width, 1400), height: Math.min(box.bottom - top.y + 16, 900), scale: 1 };
  `));
  if (!clip || clip.width < 1 || clip.height < 1) return null;
  mkdirSync(SHOTS, { recursive: true });
  const capture = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(capture.data, "base64"));
  return `shots/${name}.png`;
}

async function openExtensions(app) {
  return app.ev(page(`
    document.querySelector('button[aria-label="Extensions"]')?.click();
    await pause(1200);
    return Boolean(document.querySelector('[aria-label="Connectors"]'));
  `));
}

/** Fill the form and connect; timed from the click to the end of the busy state. */
async function probe(app, label, url, name) {
  const netBefore = await app.ev("window.__tmTaps.net.length");
  const clicked = await app.ev(remote(`
    setValue(field('Remote connector name'), ${JSON.stringify(name)});
    setValue(field('Public HTTPS connector URL'), ${JSON.stringify(url)});
    setValue(field('Remote MCP bearer token'), '');
    await pause(250);
    const b = submit();
    if (!b || b.disabled) return { clicked: false };
    window.__tmClickAt = Date.now();
    b.click();
    return { clicked: true };
  `));
  if (!clicked.clicked) return { label, url, clicked: false };
  const settled = await waitFor(() => app.ev(remote(`
    const b = submit();
    return b && !b.disabled && /^Connect and list tools$/.test(b.textContent.trim()) ? Date.now() - window.__tmClickAt : null;
  `)), 75_000, 200);
  await sleep(300);
  const facts = await app.ev(remote("return facts();"));
  const host = new URL(url).host;
  const net = (await app.ev(`window.__tmTaps.net.slice(${netBefore})`)).filter((r) => r.host === host);
  return {
    label,
    url,
    settledMs: settled,
    bounded: settled !== null && settled <= 31_000,
    ...facts,
    requests: net.map((r) => ({ rpc: r.rpc, ms: r.ms, status: r.status ?? null, error: r.error ?? null })),
  };
}

/** Call the selected tool (through the one-time approval when the posture asks for it). */
async function callTool(app, args) {
  const netBefore = await app.ev("window.__tmTaps.net.length");
  const clicked = await app.ev(remote(`
    const area = panel.querySelector('[aria-label="Remote MCP connection result"] textarea');
    if (!area) return { clicked: false, reason: 'no connected result block' };
    setValue(area, ${JSON.stringify(JSON.stringify(args))});
    await pause(200);
    const b = [...panel.querySelectorAll('[aria-label="Remote MCP connection result"] button')].find((n) => /call/i.test(n.textContent));
    if (!b || b.disabled) return { clicked: false, reason: 'no enabled call button' };
    const label = b.textContent.trim();
    window.__tmClickAt = Date.now();
    b.click();
    await pause(300);
    const allow = [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.textContent.trim() === 'Allow once');
    if (allow) allow.click();
    return { clicked: true, label, approvedOnce: Boolean(allow) };
  `));
  if (!clicked.clicked) return clicked;
  const settled = await waitFor(() => app.ev(remote(`
    const busy = [...panel.querySelectorAll('button')].some((n) => n.textContent.trim() === 'Calling…');
    return busy ? null : Date.now() - window.__tmClickAt;
  `)), 75_000, 200);
  await sleep(300);
  const facts = await app.ev(remote("return facts();"));
  const net = (await app.ev(`window.__tmTaps.net.slice(${netBefore})`)).filter((r) => r.host === new URL(DEEPWIKI).host);
  return { ...clicked, settledMs: settled, ...facts, requests: net.map((r) => ({ rpc: r.rpc, ms: r.ms, status: r.status ?? null, error: r.error ?? null })) };
}

async function mcpPhase() {
  const result = { liveTurns: 0, tokenEntered: false, scenarios: {} };
  const app = await launch();
  let created = false;
  let borrowed = null;
  let name = REMOTE_NAME;
  try {
    if (!(await openExtensions(app))) throw new Error("Extensions page not reached");
    const before = await app.ev(remote("return facts().registry;"));
    result.remotesBefore = before.map((e) => ({ id: e.id, status: e.status, url: e.url, tools: e.tools, useInMuse: e.useInMuse }));
    if (before.length > 0) {
      // Single-remote plan: a second remote is refused before any transport.
      // Only an earlier campaign's DeepWiki test connector may be borrowed: the
      // scenarios then run under its name (a failure never changes its URL) and
      // it is left connected-and-installed, as found.
      if (before.length !== 1 || before[0].url !== DEEPWIKI) throw new Error("blocked: the registry holds a remote connector this harness cannot borrow (single-remote limit)");
      borrowed = before[0];
      name = borrowed.name;
    }
    result.connectorUsed = borrowed ? "the existing DeepWiki test connector (27/09 campaign), under its own name" : `a new "${REMOTE_NAME}" connector, removed afterwards`;
    result.posture = await app.ev(page("return store('muse-desktop.authorization-mode.v1', 'null');"));

    const failing = [
      ["privateAddress", "https://127.0.0.1:9/mcp"],
      ["unresolvableHost", "https://muse-proof-unreachable.invalid/mcp"],
      ["blackholeTestNet", "https://192.0.2.1/mcp"],
      ["blackholePort", "https://example.com:81/mcp"],
      ["notMcpNoCors", "https://example.com/mcp"],
      ["notMcpJsonEcho", "https://httpbin.org/anything"],
      ["http401", "https://httpbin.org/status/401"],
      ["tlsExpired", "https://expired.badssl.com/mcp"],
      ["tlsSelfSigned", "https://self-signed.badssl.com/mcp"],
    ];
    for (const [label, url] of failing) {
      result.scenarios[label] = await probe(app, label, url, name);
      if (await app.ev("window.__tmTaps.bearerRefused === true")) throw new Error("blocked: a stored credential would have been sent to a third-party host; scenarios stopped");
      process.stdout.write(`- ${label}: ${result.scenarios[label].settledMs} ms ${JSON.stringify(result.scenarios[label].notice)}\n`);
    }
    result.shotFailure = await shotRemote(app, `m3-02-a-failure-${BUILD}`);

    // Real server: connect, call, disconnection, next call, reconnect.
    const connect = await probe(app, "realServer", DEEPWIKI, name);
    created = !borrowed && connect.registry.some((e) => e.id === REMOTE_ID);
    result.scenarios.realServer = connect;
    const tool = await app.ev(remote("return panel.querySelector('[aria-label=\"Remote MCP connection result\"] select')?.value ?? null;"));
    const toolNames = await app.ev(remote("return [...(panel.querySelectorAll('[aria-label=\"Remote MCP connection result\"] select option') || [])].map((o) => o.value);"));
    if (toolNames.includes("read_wiki_structure")) {
      await app.ev(remote("const s = panel.querySelector('[aria-label=\"Remote MCP connection result\"] select'); const P = HTMLSelectElement.prototype; Object.getOwnPropertyDescriptor(P, 'value').set.call(s, 'read_wiki_structure'); s.dispatchEvent(new Event('change', { bubbles: true })); return true;"));
    }
    result.scenarios.realCall = { tool: toolNames.includes("read_wiki_structure") ? "read_wiki_structure" : tool, ...(await callTool(app, { repoName: "modelcontextprotocol/servers" })) };

    await app.send("Network.enable");
    let blockedWith = "Network.setBlockedURLs";
    try { await app.send("Network.setBlockedURLs", { urls: ["*mcp.deepwiki.com*"] }); }
    catch (error) { blockedWith = `unavailable: ${String(error.message ?? error).slice(0, 120)}`; }
    const dropped = await callTool(app, { repoName: "modelcontextprotocol/servers" });
    result.scenarios.disconnection = { simulatedWith: blockedWith, ...dropped };
    result.shotDisconnected = await shotRemote(app, `m3-02-b-disconnected-${BUILD}`);
    await app.send("Network.setBlockedURLs", { urls: [] }).catch(() => null);

    const netBefore = await app.ev("window.__tmTaps.net.length");
    const reconnect = await app.ev(remote(`
      const row = [...panel.querySelectorAll('.integration-remote-status')][0];
      const b = row ? [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Reconnect') : null;
      if (!b || b.disabled) return { clicked: false };
      window.__tmClickAt = Date.now();
      b.click();
      return { clicked: true };
    `));
    const reconnected = await waitFor(() => app.ev(remote("const t = statusRow()[0]?.text || ''; return /^Connected/.test(t) ? Date.now() - window.__tmClickAt : null;")), 60_000, 250);
    result.scenarios.reconnect = {
      ...reconnect,
      settledMs: reconnected,
      ...(await app.ev(remote("return facts();"))),
      requests: (await app.ev(`window.__tmTaps.net.slice(${netBefore})`)).filter((r) => r.host === new URL(DEEPWIKI).host).map((r) => ({ rpc: r.rpc, ms: r.ms, status: r.status ?? null, error: r.error ?? null })),
    };
    result.consoleErrors = app.errors.slice(0, 10);
  } finally {
    if (borrowed) {
      // Leave the borrowed connector as found: installed, same URL (a last
      // Reconnect if a failure above left it in the error state).
      let after = await app.ev(remote("return facts().registry;")).catch(() => []);
      if (after[0]?.status !== "installed") {
        await app.ev(remote(`const row = [...panel.querySelectorAll('.integration-remote-status')][0];
          const b = row ? [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Reconnect') : null;
          if (b) b.click(); return Boolean(b);`)).catch(() => false);
        await waitFor(async () => (await app.ev(remote("return facts().registry;")).catch(() => []))[0]?.status === "installed", 30_000, 500);
        after = await app.ev(remote("return facts().registry;")).catch(() => []);
      }
      result.borrowedAfter = after.map((e) => ({ id: e.id, status: e.status, url: e.url, tools: e.tools, useInMuse: e.useInMuse }));
      result.borrowedRestored = after.length === 1 && after[0].id === borrowed.id && after[0].url === borrowed.url
        && after[0].status === "installed" && after[0].useInMuse === borrowed.useInMuse && after[0].addedAt === borrowed.addedAt;
    }
    if (created) {
      // Cleanup: disconnect, then remove the test connector.
      result.cleanup = await app.ev(remote(`
        const row = [...panel.querySelectorAll('.integration-remote-status')][0];
        const disconnect = row ? [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Disconnect') : null;
        if (disconnect) { disconnect.click(); await pause(400); }
        const entry = [...panel.querySelectorAll('li.integration-row')].find((li) => li.querySelector('strong')?.textContent.includes(${JSON.stringify(REMOTE_NAME)}));
        const remove = entry ? [...entry.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove') : null;
        if (remove) { remove.click(); await pause(600); }
        return { disconnected: Boolean(disconnect), removed: Boolean(remove), remotesAfter: facts().registry.length };
      `)).catch((error) => ({ error: String(error.message ?? error) }));
    }
    result.stop = await stopApp(app);
  }
  return result;
}

async function inspectPhase() {
  const app = await launch();
  try {
    await openExtensions(app);
    return await app.ev(page(`
      const registry = store('muse-desktop.connectors.v1', '[]') || [];
      return {
        connectors: registry.length,
        remotes: registry.filter((e) => e && e.kind === 'remote').map((e) => ({ id: e.id, status: e.status, url: e.url, addedAt: e.addedAt })),
        posture: store('muse-desktop.authorization-mode.v1', 'null'),
        defaultFolderSet: typeof store('muse-desktop.workspace.v1', 'null') === 'string',
        conversations: document.querySelectorAll('li.session-item').length,
      };
    `));
  } finally {
    await stopApp(app);
  }
}

// ---- verdicts and record --------------------------------------------------------

function engineVersion() {
  try {
    return execFileSync(TARGET, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

/** Per-criterion verdict from the recorded facts only; each failing check is named. */
function verdicts(run) {
  const p = run.phases ?? {};
  const judge = (phase, checks) => {
    if (!phase || phase.error) return { verdict: "blocked", reason: phase?.error ?? "phase not run" };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return { verdict: failed.length === 0 ? "pass" : "fail", failed };
  };
  const t = p.terminal;
  const m = p.mcp;
  const u = t?.unicode;
  const sv = t?.server;
  const sc = m?.scenarios ?? {};
  const honestFailure = (x) => Boolean(x) && x.bounded && x.notice.length > 0 && x.connectedBlock === null
    && !x.statusRows.some((r) => /^Connected/.test(r.text)) && !x.registry.some((e) => e.status === "installed" && e.url === x.url);
  return {
    "M1-05 long-running server across view changes": judge(t, sv ? {
      serverStarted: sv.listening && sv.serverIsShellChild,
      panelReallyUnmounted: sv.panelUnmountedOnTabChange && sv.panelUnmountedOnPageChange,
      answeredWhileHidden: [...sv.hiddenTabRequests, ...sv.hiddenPageRequests].every((r) => r.status === 200),
      noReadsWhileHidden: sv.terminalReadsWhileHidden === 0,
      everyHitShown: ["/visible-1", "/hidden-tab-1", "/hidden-tab-2", "/hidden-tab-3", "/hidden-page-1", "/hidden-page-2"].every((u2) => sv.hitsShown.some((h) => h.endsWith(` ${u2}`))),
      noTickLostOrDoubled: sv.missingTicks.length === 0 && sv.duplicatedTicks === 0,
      stillStreaming: sv.ticksAdvanceWhileShown >= 2,
      sameTerminal: sv.sameTerminalIdThroughout && sv.opensDuringViewChanges === 0 && sv.serverAliveAfterViewChanges,
    } : { ran: false }),
    "M1-05 Unicode output and input": judge(t, u ? {
      echoRendered: u.echo.ok && u.echo.occurrences >= 2 && u.echo.replacementChars === 0,
      inputCodePoints: u.inputCodePoints.read === u.inputCodePoints.expected,
      utf8FileUnder65001: (u.utf8File.after65001 ?? "").startsWith(u.utf8File.expected),
      longOutputIntact: u.longOutput.done && u.longOutput.intactLines === u.longOutput.lines
        && u.longOutput.domReplacementChars === 0 && u.longOutput.rawReplacementChars === 0
        && u.longOutput.domLoneSurrogates === 0 && u.longOutput.rawLoneSurrogates === 0,
      // The wide stress joined the harness after the pre-fix run: judged where measured.
      wideOutputIntact: u.wideOutput === undefined || u.wideOutput.done && u.wideOutput.intactLines === u.wideOutput.lines
        && u.wideOutput.domReplacementChars === 0 && u.wideOutput.rawReplacementChars === 0
        && u.wideOutput.domLoneSurrogates === 0 && u.wideOutput.rawLoneSurrogates === 0,
    } : { ran: false }),
    "M1-05 close leaves no orphan": judge(t, t?.close ? {
      closed: t.close.clicked && t.close.terminalCloseOk === true,
      shellGone: t.close.gone.shell === true,
      hostGone: t.close.gone.host === true,
      serverGone: t.close.gone.server === true,
      noOrphanedChild: t.close.orphanedChildren.length === 0,
      portRefused: Boolean(t.close.portAfterClose?.error),
      appExitMeasured: t.appExit?.measured === true && t.appExit.serverListening === true,
      appExitNoSurvivor: (t.appExit?.survivors ?? [null]).length === 0 && (t.appExit?.orphanedChildren ?? [null]).length === 0
        && Boolean(t.appExit?.portAfterExit?.error),
    } : { ran: false }),
    "M1-05 close/restart": judge(t, t?.restart ? {
      closeStaysClosed: t.close.reopenedByItself === 0 && t.shellExit?.reopenedByItself === 0,
      restartFromThePanel: /^panel button/.test(t.restart.via),
      freshTerminal: t.restart.opened && t.restart.newTerminalId && t.restart.newShell && t.restart.prompt && t.restart.commandRuns,
      shellExitShown: typeof t.shellExit?.processExitedShownMs === "number",
      exitedTerminalCleanedOnClose: t.shellExit?.shellGone === true && t.shellExit?.hostGoneAfterClose === true,
    } : { ran: false }),
    "M3-02 network refusal (unreachable endpoint)": judge(m, {
      privateRefusedBeforeAnyRequest: honestFailure(sc.privateAddress) && sc.privateAddress.requests.length === 0,
      unresolvable: honestFailure(sc.unresolvableHost),
      blackholes: honestFailure(sc.blackholeTestNet) && honestFailure(sc.blackholePort),
    }),
    "M3-02 not an MCP server / invalid TLS": judge(m, {
      notMcpNoCors: honestFailure(sc.notMcpNoCors),
      notMcpJsonEcho: honestFailure(sc.notMcpJsonEcho),
      tls: honestFailure(sc.tlsExpired) && honestFailure(sc.tlsSelfSigned),
    }),
    "M3-02 real server and disconnection": judge(m, sc.realServer ? {
      connectedByExchange: /^Connected to /.test(sc.realServer.connectedBlock ?? "") && ["initialize", "notifications/initialized", "tools/list"].every((r) => sc.realServer.requests.some((x) => x.rpc === r && x.status >= 200 && x.status < 300)),
      realCall: sc.realCall?.callOutput === true && sc.realCall.requests.some((x) => x.rpc === "tools/call" && x.status === 200),
      disconnectionDetected: Boolean(sc.disconnection) && sc.disconnection.requests.some((x) => x.rpc === "tools/call" && x.error)
        && /^Disconnected/.test(sc.disconnection.statusRows[0]?.text ?? "") && sc.disconnection.notice.length > 0,
      noStaleConnectedClaim: Boolean(sc.disconnection) && sc.disconnection.connectedBlock === null,
      reconnectByExchange: sc.reconnect?.settledMs !== null && ["initialize", "tools/list"].every((r) => (sc.reconnect?.requests ?? []).some((x) => x.rpc === r && x.status === 200)),
    } : { ran: false }),
    "M3-02 expired token": { verdict: "blocked", reason: "needs a bearer-protected MCP endpoint and a token from the user; only the client-side 401 mapping is measured (http401)" },
  };
}

/** One line per criterion across the recorded builds. */
function summarize(doc) {
  const criteria = Object.keys(Object.values(doc.runs).at(-1)?.verdicts ?? {});
  doc.summary = Object.fromEntries(criteria.map((k) => [k, Object.entries(doc.runs).map(([build, r]) => `${build}: ${r.verdicts?.[k]?.verdict ?? "not run"}`).join("; ")]));
}

function record(run) {
  const doc = readJson(OUT, {
    schema: "muse-desktop.m1-05-m3-02-terminal-mcp.v1",
    tickets: ["M1-05", "M3-02"],
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    runs: {},
  });
  doc.date = new Date().toISOString().slice(0, 10);
  doc.commit = gitHead();
  doc.engine = engineVersion();
  const key = BUILD;
  const previous = doc.runs[key]?.phases ?? {};
  doc.runs[key] = redactPaths({ ...run, phases: { ...previous, ...run.phases } });
  doc.runs[key].verdicts = verdicts(doc.runs[key]);
  summarize(doc);
  doc.liveTurns = Object.values(doc.runs).reduce((n, r) => n + Object.values(r.phases ?? {}).reduce((k, x) => k + (x.liveTurns ?? 0), 0), 0);
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

async function main() {
  mkdirSync(BASE, { recursive: true });
  if (PHASES.includes("verdict")) {
    const doc = readJson(OUT, null);
    if (!doc) throw new Error(`no record at ${OUT}`);
    for (const run of Object.values(doc.runs)) run.verdicts = verdicts(run);
    summarize(doc);
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(Object.fromEntries(Object.entries(doc.runs).map(([k, r]) => [k, r.verdicts])), null, 2)}\n`);
    return;
  }
  if (PHASES.includes("inspect")) {
    process.stdout.write(`${JSON.stringify(redactPaths(await inspectPhase()), null, 2)}\n`);
    return;
  }
  const run = { build: BUILD, at: new Date().toISOString(), phases: {} };
  const table = { terminal: terminalPhase, mcp: mcpPhase };
  for (const phase of PHASES) {
    if (!table[phase]) throw new Error(`unknown phase ${phase}`);
    try {
      run.phases[phase] = await table[phase]();
    } catch (error) {
      run.phases[phase] = { error: String(error?.message ?? error).slice(0, 400) };
      if (appPid !== null) run.phases[phase].stop = await stopApp(null);
      if (/^blocked/.test(run.phases[phase].error)) break;
    }
    record(run);
  }
  const doc = record(run);
  process.stdout.write(`${JSON.stringify(doc.runs[BUILD].verdicts, null, 2)}\n`);
}

await main();
