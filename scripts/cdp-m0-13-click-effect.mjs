#!/usr/bin/env node

/**
 * M0-13 native acceptance on an isolated instance, one build: a click -> effect
 * audit of every surface that carries a capability badge, a connect action or a
 * capability the host may refuse.
 *
 * The app runs in its test mode (ADR 0003): a fresh data folder per run holds
 * the app data, the WebView2 profile and the computer-use grant, whose driver
 * service runs on a pipe of its own, so the user's profile and desktop-control
 * grant are never touched. Every local engine is MUSE_DESKTOP_TEST_SIDECAR
 * (--sidecar, the native 1.4.2 engine; the app appends serve and the posture).
 *
 * Each action is clicked in the real webview and its effect is measured outside
 * the click: IPC result, storage, processes and their argv, a file on disk, a
 * local server's own log, a second HTTP client, CDP targets, UI Automation. An
 * entry passes as "effect" or "refusal"; "observed" is what a surface says
 * without a click, "check" a harness measurement over IPC; "silent" (nothing
 * visible), "fake" (a success claim without the effect) and "fail" fail.
 *
 *   readonly    Projects page: a project whose sandbox override is Read only,
 *               "New conversation here" (no turn); the engine's argv, what the
 *               host grants, what Run in Muse, the composer and the badges say,
 *               the app's own shell closed from its Close button; then the
 *               project's sandbox switched while the conversation is live, each
 *               way, and the posture note's "Restart host" (engine argv after);
 *   connectors  a failed local MCP probe then a real one (the old error must
 *               go), a quoted command path under a folder with a space, call,
 *               save, Use in Muse, Reconnect with current connectors (the
 *               engine starts the fixture as its child, then no longer once
 *               Use in Muse is off), disable/enable, Refresh tools, start/stop,
 *               remove, a curated catalog Add, an MCP Bundle that is not one, a
 *               loopback remote URL;
 *   remote      a local bearer MCP server (scripts/mcp-bearer-test-server.mjs)
 *               on the one origin test mode allows (MUSE_DESKTOP_TEST_REMOTE_MCP,
 *               ADR 0003): connect with a token, a token too long for the store,
 *               Disconnect, a row's Reconnect with a token typed for another URL,
 *               Forget token during a slowed Reconnect, a redirect, an SSE answer
 *               held open, a private host spelled with a trailing dot, then Use
 *               in Muse on the read-only conversation (the engine connects with
 *               the bearer), Forget token (the conversation is told), Reconnect
 *               with current connectors (the engine no longer has it), Remove;
 *   library     index on/pick/search/rescan/pause/resume/delete/off, import
 *               (unparseable text, one session, a chosen file, remove);
 *   computer    Settings > Computer use, only once the instance's own pipe is
 *               verified (its status probe caught there): Observe only, Refresh,
 *               attach on/off, Turn off and revoke, then Observe only while the
 *               harness holds the instance's pipe (a forced failure) and again
 *               once released; daemons on the user's pipe are read from the
 *               process table, never connected to; "Observe and act" is not
 *               started (see notExercised); no model turn with it on;
 *   share       before the turn, a snapshot of the empty conversation (it must
 *               say why nothing was created); after it, snapshot, invalid URL,
 *               unreachable endpoint, the local reference server (publish ->
 *               200 for a second client, revoke -> 404), forget;
 *   browser     invalid address, local pages (hits counted), back/forward/reload,
 *               add to prompt, open in a window, that window closed by its own
 *               close action (UI Automation), tabs, annotations;
 *   turn        the single live turn: the model is asked to write a file in the
 *               read-only project (--rehearse: send_input is refused in the page).
 *
 * Usage (from PowerShell):
 *   node scripts/cdp-m0-13-click-effect.mjs [--sidecar <engine exe>] [--exe <muse-desktop.exe>]
 *     [--base G:\muse-proofs\m0-13] [--only readonly,connectors,remote,library,computer,share,browser,turn]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-13-click-effect-isolated.json] [--rehearse]
 *     [--before-fix <record of a --rehearse run on the build before the fixes>]
 * CDP on MUSE_CDP_PORT, 9334 by default. The harness starts its own instance and
 * closes it with its own Close window button, then by PID; it never attaches to
 * an app it did not start.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { createServer as pipeServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

// A port of its own: 9222 is a developer's app, 9333 and 9335 other proofs' instances.
process.env.MUSE_CDP_PORT ??= "9334";
const { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const REPO = resolve(".");
const EXE = resolve(argValue("--exe", join(process.env.CARGO_TARGET_DIR ?? join("src-tauri", "target"), "debug", "muse-desktop.exe")));
const SIDECAR = resolve(argValue("--sidecar", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const BASE = argValue("--base", "G:\\muse-proofs\\m0-13");
const REHEARSE = process.argv.includes("--rehearse");
const ONLY = new Set(argValue("--only", "readonly,connectors,remote,library,computer,share,browser,turn").split(","));
const OUT = argValue("--out", REHEARSE ? join(BASE, "rehearsal.json") : "docs/evidence/2026-10-05-roadmap-closure/m0-13-click-effect-isolated.json");
const ID = Date.now().toString(36);
const DATA = join(BASE, `appdata-${ID}`);
const PROJECT_DIR = join(BASE, `readonly-project-${ID}`);
const PROJECT_NAME = `m0-13 read-only ${ID}`;
const FILE = "m0-13-readonly.txt";
const MARKER = `READONLY-${randomBytes(3).toString("hex").toUpperCase()}`;
const PROMPT_WRITE = `Use your file-writing tool to create the file ${FILE} in the current folder with exactly this one line: ${MARKER}. If the write is refused, do not try another way: reply with the refusal you received, in one sentence.`;
// Unquoted on purpose: the quoted form is probed separately (M3-01 quoting),
// on a copy under a folder whose name has a space.
const FIXTURE_PATH = join(REPO, "scripts", "msp-fixture.mjs");
const FIXTURE_CMD = `node ${FIXTURE_PATH} success`;
const SPACED_DIR = join(BASE, `fixture with spaces ${ID}`);
const FIXTURE_CMD_QUOTED = `node "${join(SPACED_DIR, "msp-fixture.mjs")}" success`;
const USER_PIPE = "\\\\.\\pipe\\muse-desktop-computer";
// The remote section's dummy bearers: the record holds their hashes only.
const REMOTE_NAME = `m0-13 remote ${ID}`;
const TOKEN_A = `dummy-a-${randomBytes(18).toString("base64url")}`;
const TOKEN_OTHER = `dummy-x-${randomBytes(18).toString("base64url")}`;
const TOKEN_LONG = `dummy-l-${"x".repeat(1_300)}`;
const SECRETS = [TOKEN_A, TOKEN_OTHER, TOKEN_LONG];
const SERVICE = "com.muse.desktop.mcp";
const CUA = [join(process.env.LOCALAPPDATA ?? "", "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")].find((p) => existsSync(p)) ?? "cua-driver";

// ---- processes -------------------------------------------------------------------

function ps(command) {
  // "exit 0": finding nothing is an answer, not a failure. UTF-8 out: window titles carry a middle dot.
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}; exit 0`], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Processes by image name: pid, parent, argv. */
function processes(image) {
  return ps(`Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }`)
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, ...cmd] = line.split("|");
      return { pid: Number(pid), ppid: Number(ppid), cmd: cmd.join("|") };
    });
}
const engines = () => processes(basename(SIDECAR)).filter((p) => p.ppid === appPid);
/**
 * The engine's own store for one conversation (read only; test mode does not
 * isolate it, ADR 0003): its MSP view's status, whether the last record that
 * view holds is still in the journal, and the journal's last record kinds.
 * A view left "unavailable" sends no live event of that conversation again.
 */
function engineView(sid) {
  if (!sid) return null;
  const root = join(homedir(), ".local", "share", "muse", "sessions");
  const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  let head = null;
  try { head = JSON.parse(readFileSync(join(root, ".msp-view-v1", sid, "HEAD.json"), "utf8")); } catch { /* no view */ }
  const journal = list(root).flatMap((y) => list(join(root, y)).flatMap((m) => list(join(root, y, m)).map((d) => join(root, y, m, d, sid, "session.jsonl")))).find((file) => existsSync(file));
  const records = journal ? readFileSync(journal, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  return {
    viewStatus: head?.status ?? null,
    viewRecordStillInJournal: head ? records.some((r) => r.id === head.source_through?.id) : null,
    lastRecords: records.slice(-3).map((r) => r.payload?.kind ?? r.retained_frame ?? null),
  };
}
/** An engine's flags after its exe path. */
const flagsOf = (engine) => engine.cmd.slice(engine.cmd.indexOf(basename(SIDECAR)) + basename(SIDECAR).length).replace(/^"?\s*/, "");
/**
 * The local MCP fixtures by owner: the engine's own children (a connector
 * handed to a conversation) and the app's persistent servers (cmd, child of
 * the app, then node).
 */
function fixtureTree() {
  const fixtures = processes("node.exe").filter((p) => p.cmd.includes("msp-fixture.mjs"));
  const shells = new Map(processes("cmd.exe").map((p) => [p.pid, p]));
  const engineList = engines();
  return {
    engines: engineList.map((e) => ({ pid: e.pid, flags: flagsOf(e) })),
    engineChildren: fixtures.filter((f) => engineList.some((e) => e.pid === f.ppid)).map((f) => ({ pid: f.pid, ppid: f.ppid, enginePid: f.ppid })),
    appServers: fixtures.filter((f) => shells.get(f.ppid)?.ppid === appPid).length,
    total: fixtures.length,
  };
}
const socketOf = (cmd) => cmd.match(/--socket\s+("[^"]+"|\S+)/)?.[1]?.replaceAll('"', "") ?? null;
/** Every cua-driver process on the machine, with the pipe it names. */
const cuaProcesses = () => processes("cua-driver.exe").map((p) => ({ ...p, socket: socketOf(p.cmd) }));
const cuaServes = () => cuaProcesses().filter((p) => /\sserve(\s|$)/.test(p.cmd));
/** Daemons on the user's pipe, read from the process table: the harness never connects to that pipe. */
const userPipeServes = () => cuaServes().filter((s) => s.socket?.toLowerCase() === USER_PIPE.toLowerCase()).map((s) => s.pid);

/** The pipe this instance must use (computer.rs endpoint_for): FNV-1a 64 of the data folder. */
function expectedTestPipe() {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(DATA, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${USER_PIPE}-test-${hash.toString(16).padStart(16, "0")}`;
}

/**
 * cua-driver keeps one pid file per user account, whatever the pipe: what it
 * names, read without touching any pipe. "ours" is a daemon of this instance.
 */
function driverPidFile() {
  const file = join(process.env.LOCALAPPDATA ?? "", "cua-driver", "cua-driver.pid");
  if (!existsSync(file)) return { present: false };
  const pid = Number(readFileSync(file, "utf8").trim());
  const daemon = cuaServes().find((s) => s.pid === pid);
  return { present: true, names: daemon ? (daemon.ppid === appPid ? "a daemon of this instance" : "another daemon") : alive(pid) ? "a live non-daemon process" : "no live process" };
}

/** The process's top-level windows, by UI Automation. */
function uiaWindows(pid) {
  return ps([
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "$A = [System.Windows.Automation.AutomationElement]",
    `$c = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})`,
    "$A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $c) | ForEach-Object { $_.Current.Name }",
  ].join("\n")).split(/\r?\n/).filter(Boolean);
}

/**
 * Close the process's window whose name starts with `prefix` through its own
 * close action in UI Automation (WindowPattern.Close: what Alt+F4 or a screen
 * reader's close does). The app has no control of its own for that window, and
 * the window exposes no title-bar button to UI Automation (measured).
 */
function uiaClose(pid, prefix) {
  return ps([
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "$A = [System.Windows.Automation.AutomationElement]",
    `$c = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})`,
    `$w = $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $c) | Where-Object { $_.Current.Name -like '${prefix}*' } | Select-Object -First 1`,
    "if ($null -eq $w) { 'no window' } else {",
    "  $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); 'closed through its WindowPattern'",
    "}",
  ].join("\n"));
}

// ---- the remote section's bearer MCP server (as scripts/cdp-m3-02-token.mjs) -------

let remoteServer = null;

/** scripts/mcp-bearer-test-server.mjs on 127.0.0.1: it holds token hashes only. */
async function startRemoteServer() {
  const adminKey = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, ["scripts/mcp-bearer-test-server.mjs", "--port", "0"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    env: { ...process.env, MCP_TEST_ADMIN_KEY: adminKey, MUSE_NO_AUTO_UPDATE: "1" },
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const line = await waitFor(() => out.split("\n").find((l) => l.startsWith("{")) ?? null, 10_000, 100);
  if (!line) { child.kill(); throw new Error("the bearer test server did not start"); }
  const { url } = JSON.parse(line);
  remoteServer = { child, url, adminKey, origin: new URL(url).origin };
  return remoteServer;
}

async function admin(path, body) {
  const response = await fetch(new URL(path, remoteServer.url), {
    method: path === "/admin/log" ? "GET" : "POST",
    headers: { "x-admin-key": remoteServer.adminKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}
const serverSeq = async () => (await admin("/admin/log")).at(-1)?.seq ?? 0;
const bearerOf = (token) => `bearer:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
const tokenLabel = (auth) => ({ [bearerOf(TOKEN_A)]: "token A", [bearerOf(TOKEN_OTHER)]: "token typed for another URL", [bearerOf(TOKEN_LONG)]: "long token" })[auth] ?? auth;
/** The server's own log since `since`: who asked what, with which bearer. */
const serverRequests = async (since) => (await admin("/admin/log")).filter((r) => r.seq > since && r.kind === "mcp").map((r) => ({
  from: r.origin ? "webview" : "engine", path: r.path, rpc: r.rpc ?? null, auth: tokenLabel(r.auth), status: r.status, ...(r.held ? { held: true } : {}),
}));
/** Credential Manager entries under the app's keyring service, by name only (keyring 3: `<key>.<service>`). */
function credentialTargets() {
  const out = execFileSync("cmdkey", ["/list"], { encoding: "latin1" });
  return [...out.matchAll(/target=(\S+)/gi)].map((m) => m[1]).filter((name) => name.endsWith(`.${SERVICE}`));
}
const remoteKey = () => `remote-mcp-remote-${REMOTE_NAME.toLowerCase().replace(/[\s_]+/g, "-")}`.replace(/[^a-z0-9._-]+/g, "-");
const remoteEntryStored = () => credentialTargets().includes(`${remoteKey()}.${SERVICE}`);

// ---- isolated app lifecycle (ADR 0003, as scripts/cdp-m4-07-remote-engine.mjs) ---

let appPid = null;
const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };
/** A refused start: the instance goes at once. */
function abort(message) {
  forceKill(appPid);
  appPid = null;
  throw new Error(message);
}

/**
 * Started from PowerShell: no WEBVIEW2_* variable, a fresh data folder, the
 * local engine pinned, CDP through the WebView2 options, MUSE_NO_AUTO_UPDATE.
 * Refused unless the app proves test mode and its browser runs on the test profile.
 */
async function launch(report) {
  if (!readFileSync(EXE).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  mkdirSync(DATA, { recursive: true });
  appPid = Number(ps([
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${DATA}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${JSON.stringify([SIDECAR.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    // The one loopback origin a remote connector may use (ADR 0003): the bearer test server.
    ...(remoteServer ? [`$env:MUSE_DESKTOP_TEST_REMOTE_MCP = '${remoteServer.origin}'`] : []),
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${EXE}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")));
  const entered = await waitFor(() => { try { return readFileSync(join(DATA, "test-mode.pid"), "utf8").trim() === String(appPid); } catch { return false; } }, 10_000, 100);
  if (!entered) abort("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  const app = await waitFor(async () => { try { return await openPage(); } catch { return null; } }, 120_000, 1_000);
  if (!app) abort("the app page never reached CDP");
  report.isolation = { testModeMarker: true, webviewProfileUnderTestFolder: under(webviewProfile(), DATA) };
  if (!report.isolation.webviewProfileUnderTestFolder) {
    app.close();
    abort("the WebView2 browser is not on the test profile: stopped before driving the app");
  }
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  if (REHEARSE) await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  return app;
}

/**
 * Close this harness's instance with its own "Close window" button, then by
 * PID: WM_CLOSE, and /F only if it is still alive.
 */
async function stopApp(app) {
  if (appPid === null) { app?.close(); return null; }
  const pid = appPid;
  appPid = null;
  const steps = [];
  const clicked = app ? await app.ev("(() => { const b = document.querySelector('button.window-close[aria-label=\"Close window\"]'); if (!b) return false; setTimeout(() => b.click(), 50); return true; })()").catch(() => false) : false;
  app?.close();
  steps.push({ step: "Close window (the app's own control)", clicked, exited: clicked && Boolean(await waitFor(() => !alive(pid), 20_000)) });
  if (alive(pid)) {
    try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
    steps.push({ step: "taskkill /PID (WM_CLOSE)", exited: Boolean(await waitFor(() => !alive(pid), 10_000)) });
  }
  if (alive(pid)) {
    const left = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.Name }`).split(/\r?\n/).filter(Boolean);
    forceKill(pid);
    steps.push({ step: "taskkill /F /T /PID", childrenStillThere: left, exited: Boolean(await waitFor(() => !alive(pid), 10_000)) });
  }
  return { graceful: steps[0].exited === true, steps, exited: !alive(pid) };
}

// ---- page side ---------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const text = (n) => (n ? (n.innerText || '').replace(/\\s+/g, ' ').trim() : null);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label, root) => q('button', root).find((b) => text(b) === label || b.getAttribute('aria-label') === label) || null;
  const click = (label, root) => { const b = button(label, root); if (b && !b.disabled) { b.click(); return true; } return false; };
  const alerts = () => q('[role="alert"]').map(text).filter(Boolean).slice(0, 4);
  const statuses = (root) => q('[role="status"]', root).map(text).filter(Boolean).slice(0, 6);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (probe, ms = 5000) => { for (let t = 0; t < ms; t += 100) { const v = probe(); if (v) return v; await wait(100); } return probe(); };
  const store = (key) => localStorage.getItem(key);
  const json = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const nav = (label) => { const b = q('.primary-nav button').find((n) => n.getAttribute('aria-label') === label); if (b) b.click(); return !!b; };
  const openSettings = () => { const b = document.querySelector('button.account[aria-label="Settings"]'); if (b) b.click(); return !!b; };
  const banner = () => text(document.querySelector('.error-banner'));
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
  .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }))`);
const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)}).map((c) => ({ ok: c.ok, args: c.args, result: (c.result || '').slice(0, 1500) }))`);
const logOf = (app, sid) => app.ev(page(`return json('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];`));

const audit = [];
const note = (surface, action, outcome, measured) => {
  audit.push({ surface, action, outcome, measured });
  process.stdout.write(`${outcome.padEnd(13)} ${surface} · ${action}\n`);
};

/** Local HTTP server owned by the harness: counts the hits the browser makes. */
async function hitServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url, at: Date.now() });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>m0-13 ${req.url}</title><p>m0-13 page ${req.url}</p>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { hits, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Feed a file input through CDP (the OS file dialog cannot be driven) and
 * report how many files its change event carried. A webkitdirectory input
 * takes a folder path.
 */
async function setFiles(app, selector, files) {
  await app.ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    window.__baselineFileChange = null;
    input.addEventListener('change', () => { window.__baselineFileChange = input.files.length; }, { once: true });
    return true;
  })()`);
  await app.send("DOM.enable");
  const doc = await app.send("DOM.getDocument", { depth: -1, pierce: true });
  const node = await app.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error(`no file input ${selector}`);
  await app.send("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
  return waitFor(() => app.ev("window.__baselineFileChange"), 3_000, 100);
}

/** Make a conversation active from its sidebar row. */
async function openConversation(app, sid) {
  const opened = await app.ev(page(`
    const row = document.querySelector('li.session-item[data-session-id="' + ${JSON.stringify(sid)} + '"]');
    if (!row) return 'no row';
    const group = row.closest('details');
    if (group && !group.open) group.querySelector('summary').click();
    await wait(200);
    row.querySelector('button.session-select').click();
    return (await until(() => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${JSON.stringify(sid)}, 10000)) ? 'open' : 'not active';
  `));
  if (opened !== "open") throw new Error(`conversation ${sid}: ${opened}`);
  await sleep(600);
}

// ---- readonly: the project, its host, and every surface that depends on it -----------

async function readonlySetup(app, state) {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(join(PROJECT_DIR, "README.md"), "# M0-13 read-only project\n");
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([PROJECT_DIR])}), true)`);
  const created = await app.ev(page(`
    const manage = q('button.sidebar-manage').find((b) => /Manage projects/.test(text(b)));
    if (!manage) return { error: 'no Manage projects' };
    manage.click();
    const panel = await until(() => q('.projects-panel')[0]);
    if (!panel) return { error: 'no projects panel' };
    setValue(panel.querySelector('input[aria-label="Project name"]'), ${JSON.stringify(PROJECT_NAME)});
    await wait(200);
    click('Choose project folders', panel);
    const picked = await until(() => /1 folder selected/.test(text(panel.querySelector('.project-workspace-picker')) || ''));
    click('+ Add project', panel);
    const row = await until(() => q('li', panel).find((li) => text(li.querySelector('summary .project-name')) === ${JSON.stringify(PROJECT_NAME)}));
    const stored = (json('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT_NAME)});
    return { picked: Boolean(picked), rowShown: Boolean(row), stored: stored ? { id: stored.id, workspace: stored.workspace ?? null, workspaces: stored.workspaces ?? [] } : null };
  `));
  const dialog = (await ipc(app, "plugin:dialog|open")).length;
  note("readonly", "Projects: Choose project folders + Add project", created.rowShown && created.stored ? "effect" : "fail", { ...created, folderDialogAnsweredByHarness: dialog });
  if (!created.stored) throw new Error(`project not created: ${JSON.stringify(created)}`);
  state.projectId = created.stored.id;

  const override = await app.ev(page(`
    const li = q('.projects-panel li').find((n) => text(n.querySelector('summary .project-name')) === ${JSON.stringify(PROJECT_NAME)});
    const details = li.querySelector('details') || li.closest('details');
    if (details && !details.open) details.querySelector('summary').click();
    await wait(300);
    const select = await until(() => li.querySelector('select[aria-label^="Project sandbox"]'));
    if (!select) return { error: 'no sandbox select' };
    const label = select.getAttribute('aria-label');
    const options = [...select.options].map((o) => o.value + '=' + o.text);
    setValue(select, 'read-only');
    await wait(400);
    const stored = (json('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT_NAME)});
    return { label, options, diff: q('ul.project-diff li', li).map(text), flag: text(li.querySelector('.project-diff-flag')), storedOverride: stored?.settings?.sandbox ?? null };
  `));
  note("readonly", "Projects: Project sandbox = Read only", override.storedOverride === "read-only" ? "effect" : "fail", override);

  const before = new Set(engines().map((p) => p.pid));
  await app.ev("(window.__baselineIpc.calls = [], true)");
  const clicked = await app.ev(page(`
    const li = q('.projects-panel li').find((n) => text(n.querySelector('summary .project-name')) === ${JSON.stringify(PROJECT_NAME)});
    return click('New conversation here', li);
  `));
  const start = await waitFor(async () => (await ipc(app, "start_session")).find((c) => c.ok !== undefined) ?? null, 90_000);
  const meta = start?.ok ? JSON.parse(start.result) : null;
  state.sid = meta?.session_id ?? null;
  state.hostMcpServers = (start?.args?.mcpServers ?? []).map((server) => server.name);
  const started = engines().filter((p) => !before.has(p.pid));
  state.enginePids = engines().map((p) => p.pid);
  const flags = started.map((p) => p.cmd.slice(p.cmd.indexOf(basename(SIDECAR)) + basename(SIDECAR).length).replace(/^"?\s*/, ""));
  const diagnostics = await invoke(app, "collect_diagnostics", {});
  state.engine = diagnostics.ok ? diagnostics.value.hostEngines : diagnostics.error;
  const host = {
    clicked,
    startArgs: start ? { sandboxMode: start.args?.sandboxMode, sandboxDisableWrite: start.args?.sandboxDisableWrite, sandboxDisableShell: start.args?.sandboxDisableShell } : null,
    startOk: start?.ok ?? null,
    error: start && !start.ok ? start.result : null,
    engineArgv: flags,
    grantedCapabilities: meta?.granted_capabilities ?? null,
    hostEngines: state.engine,
  };
  const postureOnWire = flags.some((f) => /--disable-write/.test(f) && /--disable-shell/.test(f));
  note("readonly", "Projects: New conversation here (read-only host, no turn)", state.sid && postureOnWire ? "effect" : "fail", host);
  return { project: created, override, host };
}

async function readonlySurfaces(app, state) {
  await openConversation(app, state.sid);
  const composer = await app.ev(page(`
    const wrap = document.querySelector('.composer-wrap');
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    const main = document.querySelector('main.conversation');
    const note = main.querySelector('.posture-note');
    return {
      placeholder: field ? field.getAttribute('placeholder') : null,
      composerText: text(wrap),
      postureNote: note ? { text: text(note), role: note.getAttribute('role'), rightAboveComposer: note.nextElementSibling === wrap } : null,
      readOnlyStated: /read.only|cannot write|cannot run commands/i.test(text(main) || ''),
      capabilityBadgesInConversation: q('.capability-badge', main).map((b) => b.getAttribute('aria-label')),
    };
  `));
  // What the surfaces say before any click: an observation, not a click's effect.
  note("readonly", "composer and conversation (what they say about Read only)", composer.readOnlyStated ? "observed" : "silent", composer);

  await app.ev("(window.__baselineIpc.calls = [], true)");
  const terminal = await app.ev(page(`
    const toggle = q('button').find((b) => b.getAttribute('aria-label') === 'Show work panel');
    if (toggle) toggle.click();
    await wait(400);
    click('Terminal', q('nav.work-tabs')[0]);
    await wait(500);
    const panel = () => q('section.terminal-panel')[0];
    if (panel() && button('Open terminal', panel())) click('Open terminal', panel());
    const input = await until(() => panel() && panel().querySelector('input[aria-label="Terminal command"]'), 20000);
    if (!input) return { error: 'no terminal', panel: text(panel()) };
    setValue(input, 'echo m0-13-run-in-muse');
    await wait(300);
    const b = panel().querySelector('button.terminal-muse');
    return { runInMuse: { label: text(b), disabled: b.disabled, title: b.getAttribute('title') }, terminalMeta: text(panel().querySelector('.terminal-meta')) };
  `));
  const opened = (await ipc(app, "terminal_open")).at(-1);
  terminal.appTerminalOpened = opened ? { ok: opened.ok } : null;
  let after = null;
  if (terminal.runInMuse && !terminal.runInMuse.disabled) {
    await app.ev(page("q('section.terminal-panel button.terminal-muse')[0].click(); return true;"));
    await sleep(5_000);
    const call = (await ipc(app, "user_shell")).at(-1);
    const history = await invoke(app, "read_session_history", { sessionId: state.sid });
    const items = (history.value?.items ?? []).map((raw) => ({ ...raw, ...(raw?.item ?? {}) })).filter((i) => (i.kind ?? i.itemKind) === "userShell");
    after = {
      ipc: call ? { ok: call.ok, result: call.result } : null,
      ui: await app.ev(page(`return { banner: banner(), rows: q('.msg').slice(-2).map((n) => ({ lane: [...n.classList].find((c) => c !== 'msg'), failedMarker: Boolean(n.querySelector('.tool-failed')), text: text(n).slice(0, 300) })) };`)),
      hostItem: items.length ? { status: items.at(-1).status, visibleOutput: String(items.at(-1).visibleOutput ?? "").slice(0, 300) } : null,
    };
  }
  const runInMuse = terminal.runInMuse ?? {};
  const fake = !runInMuse.disabled && after?.ipc?.ok && after?.hostItem?.status !== "failed";
  note("readonly", "terminal: Run in Muse (Read only host)",
    runInMuse.disabled ? (/Read only|cannot run commands/i.test(runInMuse.title ?? "") ? "refusal" : "silent")
      : fake ? "fake" : after?.hostItem?.status === "failed" && after.ui.rows.some((r) => r.failedMarker) ? "refusal-after-click" : "silent",
    { ...terminal, afterClick: after });
  // The app's own shell closes from its Close button: none is left at exit.
  const closed = await app.ev(page(`
    const panel = q('section.terminal-panel')[0];
    const ok = click('Close', panel);
    await wait(800);
    return { clicked: ok, emptyState: text(q('section.terminal-panel .terminal-empty')[0]) };
  `));
  const closeCall = (await ipc(app, "terminal_close")).at(-1);
  note("readonly", "terminal: Close (the app's own shell)", closed.clicked && closeCall?.ok ? "effect" : "fail", { ...closed, ipcOk: closeCall?.ok ?? null });
  await app.ev(page("click('Close panel', q('nav.work-tabs')[0]); return true;"));
  return { composer, terminal, afterClick: after, postureSwitch: await postureSwitch(app, state) };
}

/**
 * M0-13 check (06/10/2026): the posture note and Run in Muse are said from the
 * posture the live host was started with. The project's sandbox is switched
 * while the conversation is live, each way; the note says a restart applies
 * it, and its "Restart host" does (the engine's argv after).
 */
async function postureSwitch(app, state) {
  const setSandbox = (value) => app.ev(page(`
    const manage = q('button.sidebar-manage').find((b) => /Manage projects/.test(text(b)));
    if (!q('.projects-panel')[0] && manage) manage.click();
    await until(() => q('.projects-panel')[0]);
    const li = q('.projects-panel li').find((n) => text(n.querySelector('summary .project-name')) === ${JSON.stringify(PROJECT_NAME)});
    if (!li) return { error: 'no project row' };
    const details = li.querySelector('details') || li.closest('details');
    if (details && !details.open) details.querySelector('summary').click();
    await wait(300);
    const select = await until(() => li.querySelector('select[aria-label^="Project sandbox"]'));
    setValue(select, ${JSON.stringify(value)});
    await wait(400);
    return { stored: (json('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT_NAME)})?.settings?.sandbox ?? null };
  `));
  const look = async () => {
    await openConversation(app, state.sid);
    return app.ev(page(`
      const main = document.querySelector('main.conversation');
      const note = main && main.querySelector('.posture-note');
      const restart = note && note.querySelector('button.posture-restart');
      const toggle = q('button').find((b) => b.getAttribute('aria-label') === 'Show work panel');
      if (toggle) toggle.click();
      await wait(400);
      click('Terminal', q('nav.work-tabs')[0]);
      await wait(500);
      const panel = () => q('section.terminal-panel')[0];
      if (panel() && button('Open terminal', panel())) click('Open terminal', panel());
      const input = await until(() => panel() && panel().querySelector('input[aria-label="Terminal command"]'), 20000);
      if (input) setValue(input, 'echo m0-13-posture');
      await wait(300);
      const b = panel() && panel().querySelector('button.terminal-muse');
      return {
        note: note ? text(note).replace(/\\s*Restart host$/, '') : null,
        restartOffered: Boolean(restart),
        runInMuse: b ? { disabled: b.disabled, title: b.getAttribute('title') } : null,
      };
    `));
  };
  const restartHost = async () => {
    await app.ev("(window.__baselineIpc.calls = [], window.__baselineIpc.messageQueue.push('Ok'), true)");
    const before = engines().map((e) => e.pid);
    await openConversation(app, state.sid);
    const clicked = await app.ev(page(`
      const b = document.querySelector('main.conversation .posture-note button.posture-restart');
      if (!b || b.disabled) return false;
      b.click();
      await wait(500);
      return true;
    `));
    await waitFor(async () => (await ipc(app, "resume_session")).some((c) => c.ok !== undefined), 90_000);
    await sleep(2_000);
    const engineList = engines();
    state.enginePids = [...new Set([...(state.enginePids ?? []), ...engineList.map((e) => e.pid)])];
    const resume = (await ipc(app, "resume_session")).at(-1);
    const confirm = (await ipc(app, "plugin:dialog|message")).length;
    return {
      clicked,
      confirmAnsweredByHarness: confirm,
      resume: resume ? { ok: resume.ok, reload: resume.args?.reload ?? null, sandboxDisableWrite: resume.args?.sandboxDisableWrite, sandboxDisableShell: resume.args?.sandboxDisableShell } : null,
      engineReplaced: engineList.length > 0 && engineList.every((e) => !before.includes(e.pid)),
      engineFlags: engineList.map(flagsOf),
    };
  };
  const out = {};
  out.lifted = { project: await setSandbox("workspace"), shown: await look() };
  note("readonly", "Project switched to Project while live (host started Read only)",
    /started Read only: Muse cannot write files or run commands here until its host restarts/.test(out.lifted.shown.note ?? "") && out.lifted.shown.restartOffered && out.lifted.shown.runInMuse?.disabled === true ? "observed" : "fail",
    out.lifted);
  out.restartToWritable = await restartHost();
  out.restartToWritable.shown = await look();
  // The restarted host's events reach the conversation: Run in Muse, now
  // allowed, leaves its row in the transcript (whatever the command's outcome).
  // On the 0d677ea build they no longer did: a host killed by an earlier
  // replacement had lost records its view already held (see engineView).
  {
    const marker = `m0-13-after-restart-${ID}`;
    await app.ev(page(`
      const panel = q('section.terminal-panel')[0];
      const input = panel && panel.querySelector('input[aria-label="Terminal command"]');
      if (input) setValue(input, 'echo ${marker}');
      await wait(300);
      const b = panel && panel.querySelector('button.terminal-muse');
      if (b && !b.disabled) b.click();
      return true;
    `));
    const logged = await waitFor(async () => (await logOf(app, state.sid)).find((e) => e.role === "tool" && String(e.text ?? "").includes(marker) && /\n\S/.test(String(e.text ?? ""))) ?? null, 20_000, 500);
    out.restartToWritable.hostEventsArrive = { runInMuseRowWithHostOutput: Boolean(logged), status: logged ? (logged.failed ? "failed" : "completed") : null };
    note("readonly", "Run in Muse after every host replacement so far: the host's events reach the conversation", logged ? "effect" : "silent",
      { ...out.restartToWritable.hostEventsArrive, replacementsBefore: "connectors and remote reloads (Use in Muse on/off, Forget token), Restart host", engineView: engineView(state.sid) });
  }
  note("readonly", "Restart host (posture note): the host now writable",
    out.restartToWritable.clicked && out.restartToWritable.resume?.reload === true && out.restartToWritable.engineReplaced && out.restartToWritable.engineFlags.every((f) => !/--disable-write|--disable-shell/.test(f)) && out.restartToWritable.shown.note === null && out.restartToWritable.shown.runInMuse?.disabled === false ? "effect" : "fail",
    out.restartToWritable);
  out.locked = { project: await setSandbox("read-only"), shown: await look() };
  note("readonly", "Project switched to Read only while live (host started writable)",
    /now Read only, but this conversation's Muse host was started before: Muse can still write files and run commands here/.test(out.locked.shown.note ?? "") && out.locked.shown.restartOffered && out.locked.shown.runInMuse?.disabled === false ? "observed" : "fail",
    out.locked);
  out.restartToReadOnly = await restartHost();
  out.restartToReadOnly.shown = await look();
  // The restarted host answers this conversation (a harness IPC check: session/read).
  const t0 = Date.now();
  const history = await invoke(app, "read_session_history", { sessionId: state.sid });
  out.restartToReadOnly.hostAnswers = { ok: history.ok, ms: Date.now() - t0, error: history.ok ? null : String(history.error).slice(0, 200) };
  note("readonly", "Restart host (posture note): the host now Read only",
    out.restartToReadOnly.clicked && out.restartToReadOnly.engineReplaced && out.restartToReadOnly.engineFlags.every((f) => /--disable-write/.test(f) && /--disable-shell/.test(f)) && out.restartToReadOnly.shown.note === "This project is Read only: Muse cannot write files or run commands here." && out.restartToReadOnly.shown.runInMuse?.disabled === true ? "effect" : "fail",
    out.restartToReadOnly);
  // The terminal opened to read Run in Muse closes from its own button.
  await app.ev(page(`
    const panel = q('section.terminal-panel')[0];
    if (panel) click('Close', panel);
    await wait(800);
    click('Close panel', q('nav.work-tabs')[0]);
    return true;
  `));
  return out;
}

/** Until the turn ends: an approval card gets "Allow once" (recorded), the host decides. */
async function waitTurn(app, sid, previousAssistant) {
  const approvals = [];
  const t0 = Date.now();
  const done = await waitFor(async () => {
    const s = await app.ev(page(`
      const log = json('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];
      const cards = q('.approvals .approval').map((g) => ({
        title: text(g.querySelector('.approval-title-row strong')),
        detail: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 300),
        buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()),
      }));
      // A finished reply: the send paints an empty open placeholder at once.
      const assistant = log.filter((e) => e.role === 'assistant' && !e.open && (e.text || '').trim().length > 0);
      return {
        assistantCount: assistant.length,
        failed: log.filter((e) => e.engineError).map((e) => e.engineError),
        running: document.querySelector('.task-metadata .dot')?.getAttribute('data-running') ?? null,
        cards,
      };
    `));
    if (s.cards.length > 0) {
      approvals.push(s.cards[0]);
      await app.ev(page("const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === 'Allow once') ?? q('.approvals .approval-actions button.approve')[0]; if (b) b.click(); return Boolean(b);"));
      return null;
    }
    if (Date.now() - t0 < 5_000) return null;
    if (s.failed.length > 0 && s.running !== "true") return s;
    return s.assistantCount > previousAssistant && s.running !== "true" ? s : null;
  }, 240_000, 1_000);
  return { ...(done ?? { timedOut: true }), approvals, ms: Date.now() - t0 };
}

async function liveTurn(app, state, report) {
  // Never a model turn with desktop control on: the grant is off and the
  // conversation's host was started without the computer-use server.
  const grant = await invoke(app, "computer_status", {});
  const hosted = (state.hostMcpServers ?? []).filter((name) => /computer/i.test(name));
  if (!grant.ok || grant.value.grantState === "active" || hosted.length > 0 || cuaServes().some((s) => s.ppid === appPid)) {
    note("turn", "Send: write a file in the read-only project", "not-exercised", { reason: "desktop control could be on: no turn", grantState: grant.ok ? grant.value.grantState : grant.error, hosted });
    return { refused: true };
  }
  await openConversation(app, state.sid);
  const before = await logOf(app, state.sid);
  await app.ev("(window.__baselineIpc.calls = [], true)");
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { clicked: false, reason: 'no composer' };
    setValue(field, ${JSON.stringify(PROMPT_WRITE)});
    await wait(300);
    const send = document.querySelector('button.send[aria-label="Send message"]');
    const enabled = Boolean(send && !send.disabled);
    if (enabled) send.click();
    return { clicked: enabled };
  `));
  if (REHEARSE) {
    const blocked = (await ipc(app, "send_input")).at(-1);
    note("turn", "Send: write a file in the read-only project", "not-exercised", { rehearsal: true, sendInputRefusedByHarness: blocked ? !blocked.ok : null });
    return { rehearsal: true };
  }
  if (!sent.clicked) {
    note("turn", "Send: write a file in the read-only project", "fail", sent);
    return sent;
  }
  report.liveTurns += 1;
  const turn = await waitTurn(app, state.sid, before.filter((e) => e.role === "assistant" && !e.open && String(e.text ?? "").trim().length > 0).length);
  const log = await logOf(app, state.sid);
  const fresh = log.slice(before.length);
  const history = await invoke(app, "read_session_history", { sessionId: state.sid });
  const items = (history.value?.items ?? []).map((raw) => ({ ...raw, ...(raw?.item ?? {}) }));
  const lastTurn = items.filter((i) => i.turnId).at(-1)?.turnId ?? null;
  const hostItems = items.filter((i) => i.turnId === lastTurn).map((i) => ({
    kind: i.kind ?? i.itemKind ?? null,
    status: i.status ?? null,
    tool: i.tool ?? i.toolName ?? i.name ?? null,
    output: String(i.visibleOutput ?? i.error?.message ?? "").slice(0, 300) || null,
    failureReason: i.failureReason ?? null,
  }));
  const onScreen = await app.ev(page(`
    return {
      rows: q('.msg').map((n) => ({
        lane: [...n.classList].find((c) => c !== 'msg') || null,
        failedMarker: text(n.querySelector('.tool-failed')),
        refusalOpen: n.querySelector('details.tool-call')?.open ?? null,
        text: text(n).slice(0, 400),
      })).slice(-8),
      postureNote: text(document.querySelector('.posture-note')),
      banner: banner(),
      approvalsLeft: q('.approvals .approval').length,
    };
  `));
  const written = existsSync(join(PROJECT_DIR, FILE));
  const toolRows = fresh.filter((e) => e.role === "tool").map((e) => ({ text: String(e.text ?? "").slice(0, 300), failed: e.failed === true }));
  const measured = {
    prompt: PROMPT_WRITE,
    turn: { ...turn, failed: turn.failed },
    fileWritten: written,
    hostItems,
    transcriptEntries: fresh.map((e) => ({ role: e.role, text: String(e.text ?? "").slice(0, 300), failed: e.failed === true })),
    toolRows,
    onScreen,
  };
  const verdict = turnVerdict(measured);
  note("turn", "Send: write a file in the read-only project", verdict.outcome, { ...measured, failedRowShown: verdict.failedRowShown });
  return measured;
}

// Honest: no file, and the screen carries the host's refusal (a Failed row, or
// the refusal in words) once the turn has ended. Fake: the file exists. Silent:
// the turn never ended on screen, or ended without a word of refusal. Only the
// rows after the prompt count, by their text: the prompt itself says "refused",
// and an earlier notice is not the answer (the 0d677ea run matched the row
// key "refusalOpen" of a JSON dump and recorded a timed-out turn as a refusal).
function turnVerdict(measured) {
  const rows = measured.onScreen?.rows ?? [];
  const answer = rows.slice(rows.map((r) => r.lane).lastIndexOf("user") + 1);
  const failedRowShown = answer.some((r) => r.failedMarker === "Failed");
  const refusalShown = failedRowShown || /denied|refus|disabled|not allowed|read.only|lecture seule|cannot|can't|unable|impossible|interdit|policy/i.test(answer.map((r) => r.text ?? "").join("\n"));
  const outcome = measured.fileWritten ? "fake" : measured.turn?.timedOut ? "silent" : refusalShown ? "refusal" : "silent";
  return { outcome, failedRowShown };
}

// ---- connectors ------------------------------------------------------------------

async function connectors(app, state) {
  await app.ev(page("return nav('Extensions');"));
  await sleep(800);
  note("connectors", "capability badge", "observed", await app.ev(page(`
    const b = q('section[aria-label="Connectors"] .capability-badge')[0];
    return { label: text(b), accessibleName: b ? b.getAttribute('aria-label') : null };
  `)));

  const probe = (command) => app.ev(page(`
    const form = q('section[aria-label="Local MCP server"] form')[0];
    setValue(form.querySelector('input[aria-label="Local MCP server name"]'), 'm0-13 probe');
    setValue(form.querySelector('input[aria-label="Local MCP command"]'), ${JSON.stringify(command)});
    await wait(200);
    click('Probe', form);
    await wait(300);
    for (let i = 0; i < 80 && text(button('Probing…', form)); i += 1) await wait(250);
    await wait(500);
    const section = q('section[aria-label="Local MCP server"]')[0];
    return { notice: text(section.querySelector('.integration-notice')), result: Boolean(q('.local-mcp-result')[0]), sectionStatus: statuses(section), alertsOnPage: alerts(), errorBanner: banner() };
  `));

  // Gap 1: a failed probe, then a successful one. The old error must go.
  const missing = await probe("m0-13-no-such-command");
  const missingIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  note("connectors", "Probe (nonexistent command)",
    missing.notice === null && (missing.sectionStatus.length > 0 || missing.alertsOnPage.length > 0) ? "refusal" : missing.notice === null ? "silent" : "fake",
    { ui: missing, ipc: { ok: missingIpc?.ok ?? null, error: missingIpc?.ok ? null : missingIpc?.result ?? null } });
  const real = await probe(FIXTURE_CMD);
  const realIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  const parsed = JSON.parse(realIpc?.ok ? realIpc.result : "{}");
  const staleGone = real.alertsOnPage.length === 0 && real.errorBanner === null;
  note("connectors", "Probe (real local stdio MCP), right after the failed one",
    /Connected to msp-fixture 1\.0\.0 · 1 tool/.test(real.notice ?? "") && realIpc?.ok && staleGone ? "effect" : "fail",
    { ui: real, previousErrorStillShown: !staleGone, previousError: missing.errorBanner ?? missing.alertsOnPage[0] ?? null, ipc: { ok: realIpc?.ok ?? null, serverName: parsed.serverName ?? null, tools: (parsed.tools ?? []).map((t) => t.name) } });
  state.staleError = { failedProbe: { banner: missing.errorBanner, alerts: missing.alertsOnPage }, nextSuccessfulProbe: { banner: real.errorBanner, alerts: real.alertsOnPage, notice: real.notice }, oldErrorGone: staleGone };

  // M3-01: a server under a folder whose name has a space needs a quoted path;
  // cmd never started it while the app re-quoted the line (fixed 06/10/2026).
  mkdirSync(SPACED_DIR, { recursive: true });
  copyFileSync(FIXTURE_PATH, join(SPACED_DIR, "msp-fixture.mjs"));
  const quoted = await probe(FIXTURE_CMD_QUOTED);
  const quotedIpc = (await ipc(app, "mcp_local_probe")).at(-1);
  const quotedParsed = quotedIpc?.ok ? JSON.parse(quotedIpc.result) : null;
  note("connectors", "Probe (quoted command path, folder with a space)",
    /Connected to msp-fixture 1\.0\.0 · 1 tool/.test(quoted.notice ?? "") && quotedIpc?.ok ? "effect" : quoted.notice ? "fake" : "fail",
    { command: FIXTURE_CMD_QUOTED, ui: quoted, ipc: { ok: quotedIpc?.ok ?? null, serverName: quotedParsed?.serverName ?? null, tools: (quotedParsed?.tools ?? []).map((t) => t.name), error: quotedIpc?.ok ? null : quotedIpc?.result ?? null } });
  // Back to the working command for the rest of the section.
  await probe(FIXTURE_CMD);

  const call = await app.ev(page(`
    const box = q('.local-mcp-result')[0];
    setValue(box.querySelector('textarea'), '{"text":"m0-13 echo"}');
    await wait(200);
    const label = q('button', box).map(text).find((t) => t === 'Call tool' || t === 'Review and call');
    click(label, box);
    await wait(500);
    const approval = q('section.connector-approval')[0];
    const approvalShown = Boolean(approval);
    if (approval) click('Allow once', approval);
    for (let i = 0; i < 40 && !q('.local-mcp-output')[0]; i += 1) await wait(250);
    return { label, approvalShown, output: text(q('.local-mcp-output')[0]) };
  `));
  const callIpc = (await ipc(app, "mcp_local_call")).at(-1);
  note("connectors", "Call tool", /m0-13 echo/.test(call.output ?? "") && callIpc?.ok ? "effect" : "fail", { ui: call, ipcOk: callIpc?.ok ?? null });

  const ROW = "q('li.integration-row').find((li) => /m0-13 probe/.test(text(li)))";
  const STORED = "(json('muse-desktop.connectors.v1', '[]') || []).find((e) => e.id === 'local-mcp-m0-13-probe')";
  const saved = await app.ev(page(`
    click('Save connector');
    await wait(500);
    const row = ${ROW};
    const stored = ${STORED};
    return { rowShown: Boolean(row), stored: stored ? { status: stored.status, tools: stored.tools.map((t) => t.name), hasCommand: Boolean(stored.command) } : null };
  `));
  note("connectors", "Save connector", saved.rowShown && saved.stored?.hasCommand ? "effect" : "fail", saved);

  const useInMuse = () => app.ev(page(`
    const row = ${ROW};
    const box = [...row.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(text(l)))?.querySelector('input');
    if (!box) return { error: 'no Use in Muse box' };
    const before = box.checked;
    box.click();
    await wait(400);
    return { before, checked: box.checked, stored: (${STORED})?.useInMuse === true };
  `));
  /**
   * Extensions > "Reconnect with current connectors" on the read-only
   * conversation. Muse 1.4.2 refuses another MCP config on a conversation it
   * has loaded (session_configuration_conflict, measured 06/10/2026): the
   * folder's host is replaced, and the resumed conversation gets the
   * connectors on record. The fixture is then the new engine's own child.
   */
  const reconnectWithCurrent = async (expectFixture) => {
    await app.ev("(window.__baselineIpc.calls = [], true)");
    const before = fixtureTree();
    const ui = await app.ev(page(`
      const b = button('Reconnect with current connectors');
      if (!b) return { shown: false };
      b.click();
      await wait(300);
      for (let i = 0; i < 240 && text(button('Reconnecting…')); i += 1) await wait(250);
      return { shown: true, errorBanner: banner() };
    `));
    const after = await waitFor(() => { const tree = fixtureTree(); return (tree.engineChildren.length > 0) === expectFixture ? tree : null; }, 15_000, 500) ?? fixtureTree();
    const resume = (await ipc(app, "resume_session")).map((c) => ({
      ok: c.ok,
      sameSession: c.args?.sessionId === state.sid,
      reload: c.args?.reload ?? null,
      sandboxDisableWrite: c.args?.sandboxDisableWrite,
      sandboxDisableShell: c.args?.sandboxDisableShell,
      mcpServers: (c.args?.mcpServers ?? []).map((s) => (s.transport === "stdio" ? `stdio: ${s.command} ${(s.args ?? []).join(" ")}` : `${s.transport}: ${s.url}`)),
    }));
    state.enginePids = [...new Set([...(state.enginePids ?? []), ...after.engines.map((e) => e.pid)])];
    return {
      ui,
      resume,
      enginesBefore: before.engines,
      enginesAfter: after.engines,
      engineReplaced: before.engines.length > 0 && after.engines.length > 0 && after.engines.every((e) => !before.engines.some((b) => b.pid === e.pid)),
      fixtureUnderEngine: after.engineChildren,
      readOnlyFlagsKept: after.engines.length > 0 && after.engines.every((e) => /--disable-write/.test(e.flags) && /--disable-shell/.test(e.flags)),
    };
  };

  const on = await useInMuse();
  note("connectors", "Use in Muse: on (local connector)", on.checked && on.stored ? "effect" : "fail", on);
  if (state.sid) {
    const handed = await reconnectWithCurrent(true);
    const last = handed.resume.at(-1);
    note("connectors", "Reconnect with current connectors (Use in Muse on): the engine starts the fixture as its child",
      !handed.ui.shown ? "not-exercised"
        : last?.ok && last.reload === true && last.sameSession && handed.engineReplaced && handed.fixtureUnderEngine.length === 1 && handed.readOnlyFlagsKept ? "effect" : "fail",
      handed);
  }
  const off = await useInMuse();
  note("connectors", "Use in Muse: off (local connector)", !off.checked && !off.stored ? "effect" : "fail", off);
  if (state.sid) {
    const dropped = await reconnectWithCurrent(false);
    const last = dropped.resume.at(-1);
    note("connectors", "Reconnect with current connectors (Use in Muse off): the fixture is gone",
      !dropped.ui.shown ? "not-exercised"
        : last?.ok && last.reload === true && dropped.engineReplaced && dropped.fixtureUnderEngine.length === 0 && dropped.readOnlyFlagsKept && last.mcpServers.length === 0 ? "effect" : "fail",
      dropped);
  }

  const toggled = await app.ev(page(`
    const row = () => ${ROW};
    const box = () => row().querySelector('label.integration-toggle[title="Disable"] input, label.integration-toggle[title="Enable"] input');
    box().click();
    await wait(400);
    const useBox = [...row().querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(text(l)))?.querySelector('input');
    const disabled = { stored: (${STORED})?.status ?? null, shown: text(row()), useInMuseDisabled: useBox?.disabled ?? null, toolsListed: q('.integration-main small', row()).map(text) };
    box().click();
    await wait(400);
    return { disabled, enabled: { stored: (${STORED})?.status ?? null, shown: text(row()) } };
  `));
  note("connectors", "Disable / Enable (local connector)",
    toggled.disabled.stored === "disabled" && toggled.disabled.useInMuseDisabled === true && toggled.disabled.toolsListed.includes("disabled") && toggled.enabled.stored === "installed" && /fixture\.echo/.test(toggled.enabled.shown) ? "effect" : "fail",
    toggled);

  const refreshed = await app.ev(page(`
    const row = () => ${ROW};
    click('Refresh tools', row());
    for (let i = 0; i < 80 && !/Tools refreshed|Refresh failed|returned no tools/.test(text(row())); i += 1) await wait(250);
    return { feedback: text(row().querySelector('.integration-refresh-feedback')), buttons: q('button', row()).map(text) };
  `));
  const refreshIpc = (await ipc(app, "mcp_local_refresh")).at(-1);
  const afterRefresh = fixtureTree();
  note("connectors", "Refresh tools (local connector)",
    /Tools refreshed · 1 discovered/.test(refreshed.feedback ?? "") && refreshIpc?.ok && afterRefresh.appServers === 1 ? "effect" : "fail",
    { ...refreshed, ipcOk: refreshIpc?.ok ?? null, persistentServersOfTheApp: afterRefresh.appServers });

  // Refresh left the app's persistent server running: stop it, then start/stop.
  const startStop = await app.ev(page(`
    const row = () => ${ROW};
    if (button('Stop server', row())) {
      click('Stop server', row());
      for (let i = 0; i < 40 && !/stopped/.test(text(row())); i += 1) await wait(250);
    }
    click('Start server', row());
    for (let i = 0; i < 40 && !/Persistent server running/.test(text(row())); i += 1) await wait(250);
    return text(row().querySelector('.integration-refresh-feedback'));
  `));
  const running = fixtureTree().appServers;
  const stopped = await app.ev(page(`
    const row = () => ${ROW};
    click('Stop server', row());
    for (let i = 0; i < 40 && !/stopped/.test(text(row())); i += 1) await wait(250);
    return text(row().querySelector('.integration-refresh-feedback'));
  `));
  await sleep(500);
  const afterStop = fixtureTree().appServers;
  const startIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /mcp_local_(start|stop)/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok }))");
  note("connectors", "Start server / Stop server", /running · 1 tools/.test(startStop ?? "") && /stopped/.test(stopped ?? "") && running === 1 && afterStop === 0 && startIpc.every((c) => c.ok) ? "effect" : "fail",
    { ui: { started: startStop, stopped }, persistentServersOfTheApp: { whileRunning: running, afterStop }, ipc: startIpc });

  const removed = await app.ev(page(`
    const row = ${ROW};
    click('Remove', row);
    await wait(600);
    return { rowGone: !q('li.integration-row').some((li) => /m0-13 probe/.test(text(li))), stored: Boolean(${STORED}) };
  `));
  note("connectors", "Remove", removed.rowGone && !removed.stored ? "effect" : "fail", removed);

  // The effect is the entry on record, said honestly: no server behind it.
  const curated = await app.ev(page(`
    const entry = q('li.integration-row').find((li) => /^SQLite/.test(text(li)) && button('Add', li));
    if (!entry) return { skipped: 'SQLite already configured' };
    click('Add', entry);
    await wait(500);
    const configured = q('h4').find((h) => /^Configured/.test(text(h)));
    const rows = q('li.integration-row').filter((li) => /^SQLite/.test(text(li)));
    const stored = (json('muse-desktop.connectors.v1', '[]') || []).find((e) => e.id === 'local-sqlite');
    return {
      catalogFlag: text(rows[0].querySelector('.integration-flag')),
      configuredHeading: text(configured),
      configuredRow: rows[1] ? { text: text(rows[1]), badge: text(rows[1].querySelector('.capability-badge')), actions: q('button', rows[1]).map(text), toggles: q('input[type="checkbox"]', rows[1]).length } : null,
      stored: stored ? { status: stored.status, hasCommand: Boolean(stored.command), useInMuse: stored.useInMuse === true } : null,
    };
  `));
  note("connectors", "Add (curated catalog entry)",
    curated.skipped ? "not-exercised"
      : curated.stored?.status === "installed" && curated.catalogFlag === "added" && /Not connected/.test(curated.configuredRow?.badge ?? "") ? "effect" : "fake",
    curated);
  if (!curated.skipped) {
    await app.ev(page(`
      const row = q('li.integration-row').filter((li) => /^SQLite/.test(text(li)))[1];
      if (row) click('Remove', row);
      await wait(400);
      return true;
    `));
  }

  mkdirSync(BASE, { recursive: true });
  const bogus = join(BASE, "not-a-bundle.mcpb");
  writeFileSync(bogus, randomBytes(512));
  const bundleFiles = await setFiles(app, 'section[aria-label="MCP Bundle package"] input[type="file"]', [bogus]);
  const bundle = await app.ev(page(`
    for (let i = 0; i < 40 && /Installing/.test(text(q('section[aria-label="MCP Bundle package"] .package-picker span')[0]) || ''); i += 1) await wait(250);
    await wait(500);
    const section = q('section[aria-label="MCP Bundle package"]')[0];
    return { sectionStatus: statuses(section), alertsOnPage: alerts(), errorBanner: banner() };
  `));
  const bundleRowAdded = await app.ev(page("return q('li.integration-row').some((li) => /not-a-bundle/.test(text(li)));"));
  note("connectors", "Install an MCP Bundle (not a bundle)", bundleRowAdded ? "fake" : (bundle.sectionStatus.length > 0 || bundle.alertsOnPage.length > 0) ? "refusal" : "silent",
    { filesDelivered: bundleFiles, ui: bundle, rowAdded: bundleRowAdded });

  // Not the test origin the instance allows (another port): the public-HTTPS rule refuses it.
  const remote = await app.ev(page(`
    const form = q('form').find((f) => f.querySelector('input[aria-label="Public HTTPS connector URL"]'));
    setValue(form.querySelector('input[aria-label="Remote connector name"]'), 'm0-13 loopback');
    setValue(form.querySelector('input[aria-label="Public HTTPS connector URL"]'), 'http://127.0.0.1:9/mcp');
    await wait(200);
    click('Connect and list tools', form);
    for (let i = 0; i < 60 && text(button('Connecting…', form)); i += 1) await wait(250);
    await wait(400);
    const panel = q('section[aria-label="Connectors"]')[0];
    return { result: text(q('[aria-label="Remote MCP connection result"]')[0]), notices: statuses(panel).filter((s) => !/Connected to msp-fixture/.test(s)), alertsOnPage: alerts() };
  `));
  const remoteIpc = await app.ev("window.__baselineIpc.calls.filter((c) => /remote/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, result: (c.result || '').slice(0, 200) }))");
  note("connectors", "Connect and list tools (loopback URL, not the allowed test origin)", remote.result === null && (remote.notices.length > 0 || remote.alertsOnPage.length > 0) ? "refusal" : remote.result ? "fake" : "silent", { ui: remote, ipc: remoteIpc });
}

// ---- remote: a bearer MCP server on the test origin (M3-02 check, 06/10/2026) ---------

/**
 * The remote connector's own controls against scripts/mcp-bearer-test-server.mjs,
 * which test mode lets the instance reach over loopback HTTP (ADR 0003). The
 * server logs every request with its bearer as a hash: what each click sent,
 * and where, is read there. Tokens are dummies; the record holds labels.
 */
async function remoteConnectors(app, state) {
  const credentialsBefore = credentialTargets().length;
  const at = (path) => remoteServer.url.replace(/\/mcp$/, path);
  await admin("/admin/accept", { sha256: createHash("sha256").update(TOKEN_A).digest("hex") });
  await app.ev(page("return nav('Extensions');"));
  await sleep(800);
  const R = `
    const form = q('form').find((f) => f.querySelector('input[aria-label="Public HTTPS connector URL"]'));
    const field = (label) => form.querySelector('input[aria-label="' + label + '"]');
    const remoteRow = () => q('li.integration-row').find((li) => text(li).startsWith(${JSON.stringify(REMOTE_NAME)}) && /\\(remote\\)/.test(text(li)));
    const statusRow = () => q('.integration-remote-status')[0] || null;
    const remoteNotice = () => { const n = q('section[aria-label="Connectors"] > p.integration-notice'); return n.length ? text(n.at(-1)) : null; };
    const remoteState = () => ({ status: text(statusRow() && statusRow().querySelector('span')), result: text(q('[aria-label="Remote MCP connection result"] .integration-notice')[0]), notice: remoteNotice(), tokenField: field('Remote MCP bearer token').value.length });
  `;
  const connect = (endpoint, token, waitMs = 60_000) => app.ev(page(`${R}
    setValue(field('Remote connector name'), ${JSON.stringify(REMOTE_NAME)});
    setValue(field('Public HTTPS connector URL'), ${JSON.stringify(endpoint)});
    await wait(100);
    setValue(field('Remote MCP bearer token'), ${JSON.stringify(token)});
    await wait(200);
    const t0 = Date.now();
    click('Connect and list tools', form);
    await wait(200);
    while (Date.now() - t0 < ${waitMs} && text(button('Connecting…', form))) await wait(250);
    await wait(400);
    return { ms: Date.now() - t0, stillConnecting: Boolean(text(button('Connecting…', form))), ...remoteState() };
  `));
  const rowClick = (label) => app.ev(page(`${R}
    const ok = click(${JSON.stringify(label)}, statusRow());
    for (let i = 0; i < 120 && text(button('Reconnecting…', statusRow())); i += 1) await wait(250);
    await wait(400);
    return { clicked: ok, ...remoteState() };
  `));
  const stored = () => app.ev(page(`return (json('muse-desktop.connectors.v1', '[]') || []).filter((e) => e.kind === 'remote').map((e) => ({ name: e.name, url: e.url, status: e.status, useInMuse: e.useInMuse === true }));`));

  let mark = await serverSeq();
  const first = await connect(remoteServer.url, TOKEN_A);
  let seen = await serverRequests(mark);
  const connected = { ui: first, server: seen, credentialStored: remoteEntryStored(), registry: await stored() };
  note("remote", "Connect and list tools (test origin, token A)",
    /Connected to m3-02-bearer-test/.test(first.result ?? "") && seen.some((r) => r.from === "webview" && r.rpc === "initialize" && r.auth === "token A" && r.status === 200) && connected.credentialStored && first.tokenField === 0 ? "effect" : "fail",
    connected);
  if (!/Connected/.test(first.result ?? "")) return;

  // F7: refused before any request, the token field emptied.
  mark = await serverSeq();
  const long = await connect(remoteServer.url, TOKEN_LONG);
  seen = await serverRequests(mark);
  note("remote", "Connect with a 1,300-character token (F7)",
    seen.length === 0 && /cannot keep it|accepts at most/.test(long.notice ?? "") ? "refusal" : seen.length > 0 ? "fail" : "silent",
    { ui: long, server: seen });

  mark = await serverSeq();
  const disconnected = await rowClick("Disconnect");
  note("remote", "Disconnect", /^Disconnected/.test(disconnected.status ?? "") && (await serverRequests(mark)).length === 0 ? "effect" : "fail", disconnected);

  // F3: a token typed while the form showed another URL is not sent by the row's Reconnect.
  const typed = await app.ev(page(`${R}
    setValue(field('Public HTTPS connector URL'), ${JSON.stringify(at("/other"))});
    await wait(100);
    setValue(field('Remote MCP bearer token'), ${JSON.stringify(TOKEN_OTHER)});
    await wait(200);
    return field('Remote MCP bearer token').value.length > 0;
  `));
  mark = await serverSeq();
  const reconnected = await rowClick("Reconnect");
  seen = await serverRequests(mark);
  note("remote", "Reconnect (row) with a token typed for another URL (F3)",
    typed && /^Connected/.test(reconnected.status ?? "") && seen.length > 0 && seen.every((r) => r.path === "/mcp" && r.auth === "token A") && reconnected.tokenField === 0 ? "effect" : "fail",
    { typedForAnotherUrl: typed, ui: reconnected, server: seen });

  // F8: Forget token waits while a Reconnect runs (the server slowed down).
  await rowClick("Disconnect");
  await admin("/admin/delay", { ms: 4000 });
  mark = await serverSeq();
  const during = await app.ev(page(`${R}
    click('Reconnect', statusRow());
    await wait(800);
    const forget = button('Forget token', statusRow());
    const whileBusy = { reconnecting: Boolean(text(button('Reconnecting…', statusRow()))), forgetDisabled: forget ? forget.disabled : null };
    for (let i = 0; i < 80 && text(button('Reconnecting…', statusRow())); i += 1) await wait(250);
    await wait(400);
    const after = button('Forget token', statusRow());
    return { whileBusy, after: { ...remoteState(), forgetDisabled: after ? after.disabled : null } };
  `));
  await admin("/admin/delay", { ms: 0 });
  note("remote", "Forget token while a Reconnect runs (F8)",
    during.whileBusy.reconnecting && during.whileBusy.forgetDisabled === true && during.after.forgetDisabled === false && /^Connected/.test(during.after.status ?? "") ? "refusal" : "fail",
    { ...during, server: await serverRequests(mark) });

  // F4: a redirect is not followed, so the bearer stays where it was sent.
  mark = await serverSeq();
  const redirected = await connect(at("/redirect"), TOKEN_A);
  seen = await serverRequests(mark);
  note("remote", "Connect to a URL that redirects (F4)",
    /redirect: Muse does not follow it/.test(redirected.notice ?? "") && seen.length === 1 && seen[0].path === "/redirect" && seen[0].status === 307 ? "refusal" : seen.some((r) => r.path === "/mcp") ? "fail" : "silent",
    { ui: redirected, server: seen });

  // F6: an SSE answer held open ends at the 30 s deadline.
  mark = await serverSeq();
  const held = await connect(at("/hold"), TOKEN_A, 50_000);
  seen = await serverRequests(mark);
  note("remote", "Connect to an SSE answer held open (F6)",
    !held.stillConnecting && /timed out/.test(held.notice ?? "") && held.ms >= 29_000 && held.ms < 45_000 && seen.some((r) => r.held) ? "refusal" : held.stillConnecting ? "fail" : "silent",
    { ui: held, server: seen });

  // F5: a private host spelled with a trailing dot is refused before any request.
  const dotted = await connect("https://localhost./mcp", "");
  note("remote", "Connect to https://localhost./mcp (F5)",
    /public HTTPS endpoint|private\/VPN/.test(dotted.notice ?? "") ? "refusal" : /request failed/.test(dotted.notice ?? "") ? "fail" : "silent",
    { ui: dotted });

  // F2: Use in Muse hands the bearer to the read-only conversation's engine;
  // Forget token cannot take it back, and says so there; a reload does.
  const useOn = await app.ev(page(`${R}
    const box = [...remoteRow().querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(text(l)))?.querySelector('input');
    if (!box || box.disabled) return { error: 'Use in Muse unavailable', disabled: box ? box.disabled : null };
    box.click();
    await wait(400);
    return { checked: box.checked };
  `));
  note("remote", "Use in Muse: on (remote connector)", useOn.checked && (await stored()).some((e) => e.useInMuse) ? "effect" : "fail", useOn);
  if (!state.sid) return;
  const reload = async () => {
    await app.ev("(window.__baselineIpc.calls = [], true)");
    const before = engines().map((e) => e.pid);
    const ui = await app.ev(page(`
      const b = button('Reconnect with current connectors');
      if (!b) return { shown: false };
      b.click();
      await wait(300);
      for (let i = 0; i < 240 && text(button('Reconnecting…')); i += 1) await wait(250);
      return { shown: true, errorBanner: banner() };
    `));
    await sleep(3_000);
    const after = engines().map((e) => e.pid);
    state.enginePids = [...new Set([...(state.enginePids ?? []), ...after])];
    const call = (await ipc(app, "resume_session")).at(-1);
    return { ui, engineReplaced: after.length > 0 && after.every((pid) => !before.includes(pid)), resume: call ? { ok: call.ok, reload: call.args?.reload ?? null, mcpServers: (call.args?.mcpServers ?? []).map((s) => s.transport) } : null };
  };
  mark = await serverSeq();
  const handed = await reload();
  seen = await serverRequests(mark);
  note("remote", "Reconnect with current connectors (remote in Muse): the engine connects with the bearer",
    handed.resume?.ok && handed.engineReplaced && seen.some((r) => r.from === "engine" && r.rpc === "initialize" && r.auth === "token A" && r.status === 200) ? "effect" : "fail",
    { ...handed, server: seen });

  const forgot = await rowClick("Forget token");
  const told = (await logOf(app, state.sid)).filter((e) => e.role === "system" && /still has its token/.test(String(e.text ?? ""))).map((e) => String(e.text).replace(REMOTE_NAME, "<remote connector>"));
  note("remote", "Forget token, with a conversation holding the bearer (item 3, F2)",
    /Remote credential forgotten/.test(forgot.notice ?? "") && /1 open conversation still has its token/.test(forgot.notice ?? "") && told.length === 1 && !remoteEntryStored() && /^Disconnected/.test(forgot.status ?? "") ? "effect" : "fail",
    { ui: forgot, conversationTold: told, credentialStored: remoteEntryStored() });

  mark = await serverSeq();
  const dropped = await reload();
  await sleep(2_000);
  seen = await serverRequests(mark);
  note("remote", "Reconnect with current connectors after Forget token: the engine no longer has the bearer",
    dropped.resume?.ok && dropped.engineReplaced && dropped.resume.mcpServers.length === 0 && seen.every((r) => r.from !== "engine") ? "effect" : "fail",
    { ...dropped, server: seen });

  const removed = await app.ev(page(`${R}
    const row = remoteRow();
    if (!row) return { error: 'no remote row' };
    click('Remove', row);
    await wait(600);
    return { rowGone: !remoteRow(), statusRows: q('.integration-remote-status').length };
  `));
  const registry = await stored();
  note("remote", "Remove (remote connector)", removed.rowGone && registry.length === 0 && credentialTargets().length === credentialsBefore ? "effect" : "fail",
    { ...removed, registry, credentialsUnderServiceBefore: credentialsBefore, credentialsUnderServiceAfter: credentialTargets().length });
  state.remoteServerLog = (await admin("/admin/log")).length;
}

// ---- library ---------------------------------------------------------------------

async function library(app) {
  await app.ev(page("return nav('Library');"));
  await sleep(800);
  note("library", "capability badges", "observed", await app.ev(page(`
    return q('.capability-badge').map((b) => ({ label: text(b), accessibleName: b.getAttribute('aria-label') }));
  `)));

  const src = join(BASE, `index-src-${ID}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "alpha.md"), "# alpha\nm0needle lives here\n");
  writeFileSync(join(src, "beta.ts"), "export const beta = 1;\n// nothing to see\n");
  const on = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    const toggle = panel.querySelector('.index-toggle input');
    if (!toggle.checked) toggle.click();
    await wait(400);
    return { status: text(panel.querySelector('.index-status')), stored: store('muse-desktop.index.enabled.v1') };
  `));
  note("library", "Index On", on.stored === "1" && /Empty/.test(on.status ?? "") ? "effect" : "fail", on);
  const indexFiles = await setFiles(app, 'section[aria-label="Local file index"] input[type="file"]', [src]);
  const built = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    for (let i = 0; i < 40 && /Empty/.test(text(panel.querySelector('.index-status')) || ''); i += 1) await wait(250);
    setValue(panel.querySelector('input[aria-label="Search indexed files"]'), 'm0needle');
    await wait(500);
    return { status: q('.index-status', panel).map(text), hits: q('.index-hit', panel).map(text) };
  `));
  note("library", "Choose folder (2 files) + search", /2 file\(s\)/.test(built.status.join(" ")) && built.hits.some((h) => /m0needle/.test(h)) ? "effect" : "fail", { filesDelivered: indexFiles, ...built });
  const rescan = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    const before = text(panel.querySelector('.index-status[title="Last build or rescan"]'));
    click('Rescan', panel);
    await wait(800);
    const after = text(panel.querySelector('.index-status[title="Last build or rescan"]'));
    click('Pause', panel);
    await wait(300);
    const paused = { status: text(panel.querySelector('.index-status')), rescanDisabled: button('Rescan', panel)?.disabled === true };
    click('Resume', panel);
    await wait(300);
    return { before, after, paused, resumed: text(panel.querySelector('.index-status')) };
  `));
  note("library", "Rescan / Pause / Resume", rescan.after !== null && /paused/.test(rescan.paused.status ?? "") && rescan.paused.rescanDisabled && !/paused/.test(rescan.resumed ?? "") ? "effect" : "fail", rescan);
  const del = await app.ev(page(`
    const panel = q('section[aria-label="Local file index"]')[0];
    click('Delete Index', panel);
    await wait(400);
    const status = text(panel.querySelector('.index-status'));
    const toggle = panel.querySelector('.index-toggle input');
    if (toggle.checked) toggle.click();
    await wait(300);
    return { status, data: store('muse-desktop.index.data.v1'), enabled: store('muse-desktop.index.enabled.v1') };
  `));
  note("library", "Delete Index / Off", /Empty/.test(del.status ?? "") && del.data === null && del.enabled === null ? "effect" : "fail", del);

  const imp = await app.ev(page(`
    const panel = q('section[aria-label="Import CLI/IDE config"]')[0];
    const paste = (value) => { setValue(panel.querySelector('textarea[aria-label="Config file content"]'), value); };
    paste('this is not a config');
    await wait(200);
    click('Import text', panel);
    await wait(400);
    const unparseable = q('.collab-list li', panel).map(text);
    paste('{"session_id":"m0-13-import","title":"m0-13 import probe"}');
    await wait(200);
    click('Import text', panel);
    await wait(400);
    const rows = q('li.collab-row', panel).map(text);
    const row = q('li.collab-row', panel).find((li) => /m0-13 import probe/.test(text(li)));
    if (row) click('Remove', row);
    await wait(400);
    return { notes: q('.collab-list li', panel).map(text), unparseable, rowsAfterImport: rows.filter((r) => /m0-13/.test(r)), removed: !q('li.collab-row', panel).some((li) => /m0-13 import probe/.test(text(li))) };
  `));
  note("library", "Import text (unparseable)", imp.unparseable.some((n) => /no importable sessions found/.test(n)) ? "refusal" : "fail", { notes: imp.unparseable });
  note("library", "Import text (one session) / Remove", imp.rowsAfterImport.length === 1 && imp.removed ? "effect" : "fail", { rows: imp.rowsAfterImport, removed: imp.removed });

  const file = join(BASE, `import-${ID}.json`);
  writeFileSync(file, JSON.stringify({ session_id: "m0-13-file-import", title: "m0-13 file import" }));
  const fileCount = await setFiles(app, 'section[aria-label="Import CLI/IDE config"] input[type="file"]', [file]);
  const fromFile = await app.ev(page(`
    const panel = q('section[aria-label="Import CLI/IDE config"]')[0];
    await until(() => q('li.collab-row', panel).some((li) => /m0-13 file import/.test(text(li))), 3000);
    const rows = q('li.collab-row', panel).map(text).filter((r) => /m0-13 file import/.test(r));
    const row = q('li.collab-row', panel).find((li) => /m0-13 file import/.test(text(li)));
    if (row) click('Remove', row);
    await wait(300);
    return { rows, removed: !q('li.collab-row', panel).some((li) => /m0-13 file import/.test(text(li))) };
  `));
  note("library", "Choose a file… (one session) / Remove", fromFile.rows.length === 1 && fromFile.removed ? "effect" : "fail", { filesDelivered: fileCount, ...fromFile });
}

// ---- computer use, on this instance's own pipe ----------------------------------------

/**
 * Before any click: the instance's own driver probe, caught on the pipe it must
 * use. A server held there (accepting, never answering) keeps the app's
 * `cua-driver status --socket <pipe>` alive long enough to read its argv and
 * parent. The user's pipe is never connected to.
 */
async function ownPipeCheck(app) {
  const pipe = expectedTestPipe();
  const held = [];
  let closing = false;
  const server = pipeServer((socket) => {
    socket.on("error", () => {});
    if (closing) socket.destroy(); else held.push(socket);
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(pipe, done); });
  try {
    const status = app.ev(`window.__TAURI_INTERNALS__.invoke('computer_status', {}).then((s) => s.grantState, (e) => 'error: ' + e)`);
    // Every driver process seen meanwhile, by the pipe it names: the app's probe on
    // the expected pipe, and none on the user's.
    const seen = new Map();
    let probe = null;
    await waitFor(() => {
      for (const p of cuaProcesses()) if (p.socket) seen.set(p.pid, p);
      probe ??= [...seen.values()].find((p) => p.ppid === appPid && /\sstatus\s/.test(p.cmd)) ?? null;
      return probe !== null && held.length > 0;
    }, 25_000, 200);
    const connectionsHeld = held.length;
    return {
      expectedPipe: "<test pipe>",
      probe: probe ? { argv: probe.cmd.slice(probe.cmd.indexOf("status")).replace(pipe, "<test pipe>"), parentIsApp: probe.ppid === appPid, onExpectedPipe: probe.socket === pipe } : null,
      connectionsHeld,
      userPipeProcessesMeanwhile: [...seen.values()].filter((p) => p.socket.toLowerCase() === USER_PIPE.toLowerCase()).length,
      grantStateAfter: await (async () => {
        closing = true;
        for (const socket of held) socket.destroy();
        server.close();
        return status;
      })(),
    };
  } finally {
    closing = true;
    for (const socket of held) socket.destroy();
    server.close();
  }
}

/** The held-pipe trick: a server on the instance's own pipe that accepts and never answers. */
async function holdTestPipe() {
  const held = [];
  let closing = false;
  const server = pipeServer((socket) => {
    socket.on("error", () => {});
    if (closing) socket.destroy(); else held.push(socket);
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(expectedTestPipe(), done); });
  return {
    connections: () => held.length,
    release: () => { closing = true; for (const socket of held) socket.destroy(); server.close(); },
  };
}

/** grantState of a (bounded, possibly truncated) computer_status or computer_* result. */
const grantOf = (result) => String(result ?? "").match(/"grantState":"(\w+)"/)?.[1] ?? null;

async function computer(app, state) {
  const userPipeBefore = userPipeServes();
  const pidFileBefore = driverPidFile();
  await app.ev(page("return openSettings();"));
  await sleep(1_000);
  const read = () => app.ev(page(`
    const panel = q('section.computer-use')[0];
    if (!panel) return null;
    return {
      state: text(panel.querySelector('.computer-use-state')),
      summary: text(panel.querySelector('.computer-use-summary')),
      levels: q('input[name="computer-use-level"]', panel).map((i) => ({ value: i.value, checked: i.checked })),
      attachChecked: panel.querySelector('.computer-use-attach input')?.checked ?? null,
      actions: q('button', panel).map(text),
      errorBanner: banner(),
    };
  `));
  // The panel is busy while an action and its status re-read run: a click then is lost.
  const idle = () => waitFor(() => app.ev(page(`
    const panel = q('section.computer-use')[0];
    return Boolean(panel) && !panel.querySelector('fieldset.computer-use-levels').disabled && !panel.querySelector('.computer-use-attach input').disabled;
  `)), 90_000, 300);
  await idle();
  const shown = await read();
  const native = await invoke(app, "computer_status", {});
  note("computer", "state shown vs computer_status (comparison, not a click)", "observed", { shown, native: native.ok ? { available: native.value.available, grantState: native.value.grantState, attach: native.value.attach, driverVersion: native.value.driverVersion } : native.error });
  if (!shown || !native.ok || !native.value.available) {
    note("computer", "levels / attach / revoke", "not-exercised", { reason: "cua-driver is not installed on this machine" });
    return;
  }

  const own = await ownPipeCheck(app);
  const verified = own.probe?.onExpectedPipe === true && own.probe.parentIsApp && own.userPipeProcessesMeanwhile === 0;
  // A harness check over IPC (computer_status while the harness holds the pipe), not a click.
  note("computer", "own pipe, before any click (the instance's status probe caught on it)", verified ? "check" : "fail", own);
  if (!verified) {
    note("computer", "levels / attach / revoke", "not-exercised", { reason: "the instance's own pipe was not verified: no Computer use control is clicked" });
    return;
  }

  const ours = () => cuaServes().filter((s) => s.ppid === appPid);
  const manifest = () => { try { return JSON.parse(readFileSync(join(DATA, "computer-use", "computer-manifest.json"), "utf8")); } catch { return null; } };
  const attachFile = () => { try { return JSON.parse(readFileSync(join(DATA, "computer-use", "computer-attach.json"), "utf8")); } catch { return null; } };
  const settle = async (cmd, count) => waitFor(async () => {
    const calls = await ipc(app, cmd);
    return calls.length >= count && calls.at(-1).ok !== undefined ? calls.at(-1) : null;
  }, 90_000);
  const testPipe = expectedTestPipe();
  const daemon = () => ours().map((s) => ({ pid: s.pid, onTestPipe: s.socket === testPipe, argv: s.cmd.slice(s.cmd.indexOf("serve")).replace(testPipe, "<test pipe>") }));
  let pidFileDuring = null;

  try {
    await app.ev("(window.__baselineIpc.calls = [], true)");
    {
      const n = (await ipc(app, "computer_enable")).length + 1;
      await app.ev(page("q('section.computer-use input[name=\"computer-use-level\"]').find((x) => x.value === 'observe').click(); return true;"));
      const call = await settle("computer_enable", n);
      await idle();
      const ui = await read();
      const d = daemon();
      pidFileDuring = driverPidFile();
      const checked = ui.levels.find((l) => l.checked)?.value ?? null;
      note("computer", "Level: Observe only", call?.ok && d.length === 1 && d[0].onTestPipe && /--permission-mode bounded --capability-manifest/.test(d[0].argv) && checked === "observe" && ui.state === "Granted" ? "effect" : call?.ok === false ? "refusal" : "fail",
        { ipc: call ? { ok: call.ok, error: call.ok ? null : call.result } : null, ui: { state: ui.state, checked, errorBanner: ui.errorBanner }, daemon: d, manifestMode: manifest()?.mode ?? null, userPipeDaemons: userPipeServes().length });
    }
    note("computer", "Level: Observe and act", "not-exercised", {
      reason: "Not started in this session: a direct probe of the driver with --dangerously-bypass-approvals was refused by the session's permission classifier, so the unrestricted service was not started through the app either. Its launch is fixed and unit-tested (serve_argv matrix); the click on the pre-fix build is recorded under beforeFix.",
    });

    const refreshBefore = (await ipc(app, "computer_status")).length;
    await app.ev(page("click('Refresh', q('section.computer-use')[0]); return true;"));
    const refreshed = await settle("computer_status", refreshBefore + 1);
    await idle();
    const afterRefresh = await read();
    note("computer", "Refresh", refreshed?.ok && afterRefresh.state === "Granted" ? "effect" : "fail", { statusCalls: (await ipc(app, "computer_status")).length - refreshBefore, stateAfter: afterRefresh.state, grantState: refreshed ? grantOf(refreshed.result) : null });

    for (const attach of [true, false]) {
      const n = (await ipc(app, "computer_set_attach")).length + 1;
      const pidBefore = daemon()[0]?.pid ?? null;
      await app.ev(page("q('section.computer-use .computer-use-attach input')[0].click(); return true;"));
      const call = await settle("computer_set_attach", n);
      await idle();
      const ui = await read();
      const d = daemon();
      const grant = d.length === 1 && d[0].onTestPipe && /--permission-mode standard --grant existing-profile/.test(d[0].argv);
      note("computer", `Attach the user's browser: ${attach ? "on" : "off"}`, call?.ok && ui.attachChecked === attach && grant === attach && d.length === 1 && attachFile() === attach && d[0].pid !== pidBefore ? "effect" : call?.ok === false ? "refusal" : "fail",
        { ipc: call ? { ok: call.ok, error: call.ok ? null : call.result } : null, ui: { checked: ui.attachChecked, state: ui.state }, daemon: d, restarted: d[0]?.pid !== pidBefore, consentOnDisk: attachFile(), userPipeDaemons: userPipeServes().length });
    }

    const n = (await ipc(app, "computer_disable")).length + 1;
    await app.ev(page("click('Turn off and revoke', q('section.computer-use')[0]); return true;"));
    const call = await settle("computer_disable", n);
    await idle();
    const ui = await read();
    note("computer", "Turn off and revoke", call?.ok && ours().length === 0 && manifest() === null && attachFile() === null && ui.state === "Off" ? "effect" : "fail",
      { ipc: call ? { ok: call.ok, grantState: call.ok ? grantOf(call.result) : null } : null, ui: { state: ui.state, levels: ui.levels, actions: ui.actions }, daemonsLeft: daemon(), manifestOnDisk: manifest() !== null, consentOnDisk: attachFile() });

    // A forced failure of a level change: the harness holds the instance's own
    // pipe (accepting, never answering), so the service the app starts cannot
    // answer it. After the failure and after the next action, the panel must
    // show the service as it is, never a stale "Granted" (fix 692952a).
    const level = async () => {
      const n = (await ipc(app, "computer_enable")).length + 1;
      await app.ev(page("q('section.computer-use input[name=\"computer-use-level\"]').find((x) => x.value === 'observe').click(); return true;"));
      const enabled = await settle("computer_enable", n);
      await idle();
      const shown = await read();
      return { ipc: enabled ? { ok: enabled.ok, error: enabled.ok ? null : enabled.result } : null, ui: { state: shown.state, checked: shown.levels.find((l) => l.checked)?.value ?? null, errorBanner: shown.errorBanner, actions: shown.actions } };
    };
    const hold = await holdTestPipe();
    let forced;
    try {
      forced = { ...(await level()), daemonsOnTestPipe: daemon(), connectionsHeld: hold.connections(), consentOnDisk: manifest() !== null };
    } finally {
      hold.release();
    }
    await sleep(1_500);
    const after = await invoke(app, "computer_status", {});
    forced.serviceOnceReleased = { grantState: after.ok ? after.value.grantState : after.error, daemons: daemon() };
    const staleGranted = forced.ui.state === "Granted" && forced.serviceOnceReleased.grantState !== "active";
    note("computer", "Level: Observe only, the instance's pipe held (forced failure)",
      forced.ipc?.ok === false && Boolean(forced.ui.errorBanner) && !staleGranted && forced.ui.state !== "Granted" ? "refusal" : "fail",
      { ...forced, staleGranted });
    // The next action: the same level change once the pipe is free (Refresh if the panel already shows it granted).
    await idle();
    const next = (await read()).levels.find((l) => l.checked)?.value === "observe"
      ? await (async () => { await app.ev(page("click('Refresh', q('section.computer-use')[0]); return true;")); await sleep(2_000); await idle(); const shown = await read(); return { action: "Refresh", ui: { state: shown.state, checked: shown.levels.find((l) => l.checked)?.value ?? null, errorBanner: shown.errorBanner } }; })()
      : { action: "Observe only", ...(await level()) };
    const nextDaemon = daemon();
    const native = await invoke(app, "computer_status", {});
    const nativeState = native.ok ? native.value.grantState : native.error;
    note("computer", "The next action after the forced failure",
      (next.ui.state === "Granted") === (nativeState === "active") && (next.action !== "Observe only" || (next.ipc?.ok && next.ui.errorBanner === null && nextDaemon.length === 1 && nextDaemon[0].onTestPipe)) ? "effect" : "fail",
      { ...next, daemon: nextDaemon, serviceGrantState: nativeState });
    // Off again for the rest of the run (no turn with desktop control on); the
    // control shows only while granted, the cleanup below covers the rest.
    const off = (await ipc(app, "computer_disable")).length + 1;
    if (await app.ev(page("return click('Turn off and revoke', q('section.computer-use')[0]);"))) {
      await settle("computer_disable", off);
      await idle();
    }
  } finally {
    // Never leave a grant behind. A consent still on record would be resumed by the
    // next status read: revoke it in the app (its own control, else its command),
    // then stop whatever this instance still serves, on its own pipe.
    if (manifest() !== null || attachFile() !== null) {
      const viaControl = await app.ev(page("return click('Turn off and revoke', q('section.computer-use')[0] || document);")).catch(() => false);
      if (!viaControl) await invoke(app, "computer_disable", {});
      await waitFor(() => manifest() === null, 30_000);
      state.computerCleanup = { viaControl, consentLeft: manifest() !== null || attachFile() !== null };
    }
    if (ours().length > 0) {
      try { execFileSync(CUA, ["revoke", "--all", "--socket", testPipe], { stdio: "ignore", timeout: 20_000 }); } catch { /* best effort */ }
      try { execFileSync(CUA, ["stop", "--socket", testPipe], { stdio: "ignore", timeout: 20_000 }); } catch { /* best effort */ }
    }
  }
  state.computer = {
    userPipeDaemonsBefore: userPipeBefore.length,
    userPipeDaemonsAfter: userPipeServes().length,
    instanceDaemonsAfter: ours().length,
    cleanupAfterAnError: state.computerCleanup ?? null,
    driverPidFile: { before: pidFileBefore, whileObserveRan: pidFileDuring, after: driverPidFile() },
  };
}

// ---- share -----------------------------------------------------------------------

const snapshot = (app, sid) => app.ev(page(`
  const panel = q('.share-panel')[0];
  const count = () => q('.share-bundles li.share-bundle', panel).length;
  const n0 = count();
  click('Markdown', q('.share-snapshot', panel)[0] || panel);
  await wait(600);
  return {
    before: n0,
    after: count(),
    said: text(q('.share-snapshot [role="status"]', panel)[0]),
    newest: text(q('.share-bundles li.share-bundle .share-bundle-head strong', panel)[0]),
    conversationEntries: (json('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || []).length,
  };
`));

/** Before the turn the conversation is empty: a snapshot must say it created nothing. */
async function shareEmpty(app, state) {
  await openConversation(app, state.sid);
  await app.ev(page("return openSettings();"));
  await sleep(1_000);
  const snap = await snapshot(app, state.sid);
  note("share", "Snapshot (Markdown) of the empty conversation", snap.after === snap.before && snap.said ? "refusal" : snap.after > snap.before ? "fake" : "silent", snap);
}

async function share(app, state) {
  await openConversation(app, state.sid);
  await app.ev(page("return openSettings();"));
  await sleep(1_000);
  const snap = await snapshot(app, state.sid);
  note("share", "Snapshot (Markdown), after the turn", snap.after === snap.before + 1 ? "effect" : snap.said ? "refusal" : "fail", snap);

  const setEndpoint = (url, token) => app.ev(page(`
    const panel = q('.share-panel')[0];
    setValue(panel.querySelector('input[aria-label="Share service URL"]'), ${JSON.stringify(url)});
    setValue(panel.querySelector('input[aria-label="Share service token"]'), ${JSON.stringify(token)});
    await wait(200);
    click('Save service', panel);
    await wait(300);
    return { configured: text(panel.querySelector('.share-endpoint-ok')), error: text(panel.querySelector('.share-endpoint [role="alert"]')), stored: store('muse-desktop.share-endpoint.v1') };
  `));
  const invalid = await setEndpoint("ftp://example.invalid/x", "");
  note("share", "Save service (invalid URL)", invalid.error && !invalid.configured && invalid.stored === null ? "refusal" : "fake", invalid);

  // A port nothing listens on, then the reference server on that same port.
  const port = await new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
  const unreachable = await setEndpoint(`http://127.0.0.1:${port}`, "unused");
  const publish = (untilUrl) => app.ev(page(`
    const panel = q('.share-panel')[0];
    const row = q('.share-bundles li.share-bundle', panel)[0];
    if (!row) return { noBundle: true };
    click('Publish', row);
    for (let i = 0; i < 60 && (${untilUrl} ? !row.querySelector('.share-url') : text(button('Publishing…', row))); i += 1) await wait(250);
    await wait(300);
    return { url: text(row.querySelector('.share-url')), title: text(row.querySelector('.share-bundle-head strong')), alerts: q('[role="alert"]', panel).map(text) };
  `));
  if (snap.after === 0) {
    for (const action of ["Publish (service unreachable)", "Publish (local reference server)", "Revoke"]) {
      note("share", action, "not-exercised", { reason: "no bundle to publish: the conversation has no messages (no turn in this run)" });
    }
  } else {
    const failed = await publish(false);
    note("share", "Publish (service unreachable)", !failed.url && failed.alerts.length > 0 ? "refusal" : failed.url ? "fake" : "silent",
      { configured: unreachable.configured?.replace(/\d+\s*(\(|$)/, "<port> $1"), ...failed });
    const token = randomBytes(12).toString("hex");
    const server = spawn(process.execPath, ["scripts/share-server.mjs", "--port", String(port)], { env: { ...process.env, SHARE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok ?? false, 10_000, 250);
      await setEndpoint(`http://127.0.0.1:${port}`, token);
      const published = await publish(true);
      const read = published.url ? await fetch(published.url).then(async (r) => ({ status: r.status, carriesTitle: published.title !== null && (await r.text()).includes(published.title) })) : null;
      note("share", "Publish (local reference server)", read?.status === 200 && read.carriesTitle ? "effect" : "fail", { urlShape: published.url?.replace(/^http:\/\/127\.0\.0\.1:\d+/, "<server>"), secondClient: read, alerts: published.alerts });
      const revoked = await app.ev(page(`
        const panel = q('.share-panel')[0];
        const row = q('.share-bundles li.share-bundle', panel)[0];
        click('Revoke', row);
        for (let i = 0; i < 40 && !/Revoked/.test(text(row)); i += 1) await wait(250);
        return { text: text(row.querySelector('p')) };
      `));
      const after = published.url ? (await fetch(published.url)).status : null;
      note("share", "Revoke", after === 404 && /Revoked/.test(revoked.text ?? "") ? "effect" : "fail", { ui: revoked, secondClientStatus: after });
    } finally {
      server.kill();
    }
  }
  const forgot = await app.ev(page(`
    const panel = q('.share-panel')[0];
    const clicked = click('Forget', panel);
    await wait(300);
    return { clicked, configured: text(panel.querySelector('.share-endpoint-ok')), stored: store('muse-desktop.share-endpoint.v1') };
  `));
  note("share", "Forget", forgot.clicked && forgot.configured === null && JSON.parse(forgot.stored ?? "null") === null ? "effect" : "fail", forgot);
}

// ---- browser ---------------------------------------------------------------------

async function browser(app, state) {
  const server = await hitServer();
  try {
    await openConversation(app, state.sid);
    const opened = await app.ev(page(`
      const toggle = q('button').find((b) => b.getAttribute('aria-label') === 'Show work panel');
      if (toggle) toggle.click();
      await wait(400);
      click('Browser', q('nav.work-tabs')[0]);
      await wait(600);
      return Boolean(q('section.browser')[0]);
    `));
    if (!opened) { note("browser", "open panel", "fail", { opened }); return; }
    const go = (url) => app.ev(page(`
      const panel = q('section.browser')[0];
      setValue(panel.querySelector('input[aria-label="Address"]'), ${JSON.stringify(url)});
      await wait(150);
      panel.querySelector('form.browser-toolbar').requestSubmit();
      await wait(1200);
      return { notice: text(panel.querySelector('.browser-notice')), iframe: panel.querySelector('iframe')?.getAttribute('src') || null, address: panel.querySelector('input[aria-label="Address"]').value };
    `));
    const shownBefore = await app.ev(page("return q('section.browser iframe')[0]?.getAttribute('src') || null;"));
    const invalid = await go("not a url ::");
    note("browser", "Go (invalid address)", invalid.notice && invalid.iframe === shownBefore ? "refusal" : "fake", { ...invalid, iframeUnchanged: invalid.iframe === shownBefore });
    const hits0 = server.hits.length;
    const first = await go(`${server.url}/page-1`);
    await sleep(800);
    note("browser", "Go (local page)", server.hits.slice(hits0).some((h) => h.path === "/page-1") ? "effect" : "fail", { iframe: first.iframe?.replace(server.url, "<server>"), serverHits: server.hits.slice(hits0).map((h) => h.path) });
    await go(`${server.url}/page-2`);
    await sleep(800);
    const hits1 = server.hits.length;
    const nav = await app.ev(page(`
      const panel = q('section.browser')[0];
      click('Back', panel); await wait(1200);
      const back = panel.querySelector('input[aria-label="Address"]').value;
      click('Forward', panel); await wait(1200);
      const forward = panel.querySelector('input[aria-label="Address"]').value;
      click('Reload', panel); await wait(1200);
      return { back, forward };
    `));
    const navHits = server.hits.slice(hits1).map((h) => h.path);
    note("browser", "Back / Forward / Reload", /page-1$/.test(nav.back) && /page-2$/.test(nav.forward) && navHits.join(",") === "/page-1,/page-2,/page-2" ? "effect" : "fail", { back: nav.back.replace(server.url, "<server>"), forward: nav.forward.replace(server.url, "<server>"), serverHits: navHits });

    const ctx = await app.ev(page(`
      const panel = q('section.browser')[0];
      const field = document.querySelector('textarea[aria-label="Message Muse"]');
      const before = field ? field.value : null;
      click('Add this page to the prompt', panel);
      await wait(600);
      const after = field ? field.value : null;
      if (field) setValue(field, before || '');
      return { before, after };
    `));
    note("browser", "Add this page to the prompt", /\[Browser context\]/.test(ctx.after ?? "") && ctx.after.includes("/page-2") ? "effect" : "fail", { inserted: ctx.after?.replace(server.url, "<server>") ?? null, composerRestored: true });

    // The native window: opened by the panel's button, closed by its own close action.
    const openWindow = async () => {
      const targetsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map((t) => t.id);
      const hits = server.hits.length;
      const n = (await ipc(app, "open_native_browser")).length + 1;
      await app.ev(page("click('Open in a browser window', q('section.browser')[0]); return true;"));
      const call = await waitFor(async () => { const all = await ipc(app, "open_native_browser"); return all.length >= n && all.at(-1).ok !== undefined ? all.at(-1) : null; }, 15_000);
      await sleep(3_000);
      const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => !targetsBefore.includes(t.id));
      return { ipcOk: call?.ok ?? null, ipcResult: call?.result ?? null, newCdpTarget: targets.find((t) => t.type === "page" && t.url.startsWith(server.url))?.url.replace(server.url, "<server>") ?? null, serverHits: server.hits.slice(hits).map((h) => h.path), windows: uiaWindows(appPid).filter((w) => /^Muse Browser/.test(w)).length };
    };
    const w1 = await openWindow();
    note("browser", "Open in a browser window", w1.ipcOk && (w1.newCdpTarget || w1.serverHits.length > 0) && w1.windows === 1 ? "effect" : w1.ipcOk === false ? "refusal" : "fail", w1);
    const closeWindow = async () => {
      const invoked = uiaClose(appPid, "Muse Browser");
      const gone = await waitFor(async () => uiaWindows(appPid).every((w) => !/^Muse Browser/.test(w)), 10_000);
      // Page targets only: the in-app panel keeps its own iframe on the same server.
      const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page" && t.url.startsWith(server.url));
      return { invoked, windowGone: Boolean(gone), cdpPageTargetsLeft: targets.length };
    };
    const c1 = await closeWindow();
    // The app forgot it: the next open builds a new window instead of reusing a dead one.
    const w2 = await openWindow();
    const c2 = await closeWindow();
    note("browser", "Close the browser window (its own close action)", c1.windowGone && c1.cdpPageTargetsLeft === 0 && /"opened"/.test(w2.ipcResult ?? "") && c2.windowGone ? "effect" : "fail",
      { close: c1, reopen: { ipcResult: w2.ipcResult, windows: w2.windows }, closeAgain: c2, inAppControl: "none: the window is closed by its own close action" });

    const tabs = await app.ev(page(`
      const panel = q('section.browser')[0];
      const count = () => q('[role="tab"]', panel).length;
      const n0 = count();
      click('New tab', panel); await wait(300);
      const n1 = count();
      const close = q('button.browser-tab-close', panel).at(-1);
      if (close) close.click();
      await wait(300);
      return { n0, n1, n2: count() };
    `));
    note("browser", "New tab / close tab", tabs.n1 === tabs.n0 + 1 && tabs.n2 === tabs.n0 ? "effect" : "fail", tabs);

    const ann = await app.ev(page(`
      const panel = q('section.browser')[0];
      const key = 'muse-desktop.browser.annotations.v1';
      const count = () => (json(key, '[]') || []).length;
      const n0 = count();
      setValue(panel.querySelector('input[aria-label="Annotation comment"]'), 'm0-13 annotation');
      await wait(200);
      click('Anchor', panel); await wait(400);
      const listed = q('.browser-annotation-comment', panel).map(text);
      const n1 = count();
      const remove = q('button', panel).find((b) => b.getAttribute('aria-label') === 'Remove annotation m0-13 annotation');
      if (remove) remove.click();
      await wait(400);
      return { n0, n1, n2: count(), listed };
    `));
    note("browser", "Anchor / remove annotation", ann.n1 === ann.n0 + 1 && ann.n2 === ann.n0 && ann.listed.includes("m0-13 annotation") ? "effect" : "fail", ann);
    await app.ev(page("click('Close panel', q('nav.work-tabs')[0]); return true;"));
  } finally {
    server.close();
  }
}

// ---- run -------------------------------------------------------------------------

async function main() {
  const report = {
    schema: "muse-desktop.m0-13-click-effect.v3",
    ticket: "M0-13",
    date: new Date().toISOString().slice(0, 10),
    commit: gitHead(),
    productTreeClean: execFileSync("git", ["status", "--porcelain", "--", "src", "src-tauri/src"], { encoding: "utf8" }).trim() === "",
    exeSha256: sha256(EXE),
    platform: "Windows 11 (26200), debug build with embedded frontend, isolated test mode (ADR 0003), WebView2 over CDP",
    harness: "scripts/cdp-m0-13-click-effect.mjs",
    rehearsal: REHEARSE,
    liveTurns: 0,
  };
  let engineVersion = null;
  try { engineVersion = execFileSync(SIDECAR, ["--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(); } catch (error) { engineVersion = `failed: ${String(error.message).slice(0, 120)}`; }
  report.engine = { version: engineVersion, sha256: sha256(SIDECAR), role: "MUSE_DESKTOP_TEST_SIDECAR: every local engine of this instance" };
  report.computerDriver = existsSync(CUA) ? { version: execFileSync(CUA, ["--version"], { encoding: "utf8" }).trim() } : null;

  const state = { sid: null };
  let app = null;
  try {
    // Before the app: the instance learns the server's origin at launch (ADR 0003).
    if (ONLY.has("remote")) {
      await startRemoteServer();
      report.remoteServer = { script: "scripts/mcp-bearer-test-server.mjs", origin: "http://127.0.0.1:<port>", allowedBy: "MUSE_DESKTOP_TEST_REMOTE_MCP (test mode only)" };
    }
    app = await launch(report);
    const boot = await invoke(app, "collect_diagnostics", {});
    report.isolation.testMode = boot.ok ? boot.value.testMode : boot.error;
    const steps = [
      ["readonly", async () => { report.readOnly = await readonlySetup(app, state); }],
      ["connectors", () => connectors(app, state)],
      // Before the remote section: Forget token writes a line into this conversation.
      ["share", () => shareEmpty(app, state)],
      ["remote", () => remoteConnectors(app, state)],
      ["library", () => library(app)],
      ["computer", () => computer(app, state)],
      ["browser", () => browser(app, state)],
      ["readonly", async () => { Object.assign(report.readOnly ?? (report.readOnly = {}), { surfaces: await readonlySurfaces(app, state) }); }],
      ["turn", async () => { report.readOnly.turn = await liveTurn(app, state, report); }],
      // After the turn: the conversation now has something to snapshot and publish.
      ["share", () => share(app, state)],
    ];
    for (const [name, run] of steps) {
      if (!ONLY.has(name)) continue;
      if (state.sid === null && !["readonly", "connectors", "remote", "library", "computer"].includes(name)) {
        note(name, "harness", "not-exercised", { reason: "no conversation: the read-only start failed or was skipped" });
        continue;
      }
      await app.ev(INSTALL_IPC_TRACE);
      if (REHEARSE) await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
      try {
        await run();
      } catch (error) {
        note(name, "harness", "error", { message: String(error?.message ?? error).slice(0, 400) });
      }
    }
    report.staleError = state.staleError ?? null;
    report.computer = state.computer ?? null;
    report.consoleErrors = app.errors.slice(0, 20);
    // Every host replacement of the run is behind, and each resume checked the
    // view against the journal: "unavailable" means a replaced host lost
    // records the view held. (While the host runs, its last records may not be
    // in the journal yet: the full check comes after Close window.)
    if (state.sid) {
      const view = engineView(state.sid);
      note("readonly", "The conversation's engine view after every host replacement", view?.viewStatus === "healthy" ? "check" : "fail", view);
    }
  } finally {
    // The engines seen during the run and those running at Close window. A
    // leftover is one of these pids still held by an engine process: a bare
    // liveness test also counts a pid Windows gave to another process since.
    const atClose = appPid === null ? [] : engines().map((e) => e.pid);
    const enginePids = [...new Set([...(state.enginePids ?? []), ...atClose])];
    report.stop = await stopApp(app);
    await sleep(1_500);
    if (report.stop) {
      const stillEngines = processes(basename(SIDECAR)).map((p) => p.pid);
      report.stop.leftovers = {
        enginesAtClose: atClose.length,
        engines: enginePids.filter((pid) => stillEngines.includes(pid)).length,
        computerDaemonsOnTestPipe: cuaServes().filter((s) => s.socket === expectedTestPipe()).length,
        localMcpFixtures: processes("node.exe").filter((p) => p.cmd.includes("msp-fixture.mjs")).length,
        credentialEntryOfThisRun: remoteServer ? remoteEntryStored() : null,
      };
      // Closing the app stops its hosts: the conversation's host ends it in
      // its journal (session_end) instead of being killed mid-write.
      if (state.sid) {
        const view = engineView(state.sid);
        report.stop.conversationJournal = view;
        note("readonly", "Close window: the conversation's host ends it cleanly (session_end, view kept)", view?.lastRecords.at(-1) === "session_end" && view.viewStatus === "healthy" && view.viewRecordStillInJournal === true ? "check" : "fail", view);
      }
    }
    remoteServer?.child.kill();
  }
  report.audit = audit;
  report.summary = audit.reduce((acc, e) => ({ ...acc, [e.outcome]: (acc[e.outcome] ?? 0) + 1 }), {});
  // The four gaps of the adversarial check, read back from the audit above.
  const outcome = (surface, action) => audit.find((e) => e.surface === surface && e.action.startsWith(action))?.outcome ?? "missing";
  const all = (pairs, wanted) => pairs.every(([surface, action]) => wanted.includes(outcome(surface, action)));
  const host = report.readOnly?.host ?? null;
  report.gaps = {
    "1 stale error residue": {
      verdict: state.staleError?.oldErrorGone === true && outcome("connectors", "Probe (real local stdio MCP)") === "effect" ? "closed" : "open",
      measured: state.staleError ?? null,
    },
    "2 a capability the host refuses": {
      verdict: outcome("readonly", "composer") === "observed" && report.readOnly?.surfaces?.composer?.readOnlyStated === true
        && all([["readonly", "terminal: Run in Muse"], ["turn", "Send"]], ["refusal"]) ? "closed" : "open",
      hostGrants: host?.grantedCapabilities ?? null,
      engineArgv: host?.engineArgv ?? null,
      surfaces: { composer: outcome("readonly", "composer"), runInMuse: outcome("readonly", "terminal: Run in Muse"), liveWrite: outcome("turn", "Send") },
    },
    "3 non-click effects replaced": {
      verdict: all([["browser", "Close the browser window"], ["computer", "Refresh"], ["computer", "Turn off and revoke"]], ["effect"]) && report.stop?.steps?.[0]?.clicked === true ? "closed" : "open",
      replaced: {
        "close the browser window (app command)": `its own close action through UI Automation (no in-app control, no title-bar button exposed): ${outcome("browser", "Close the browser window")}`,
        "state shown vs computer_status": `kept as an observation; the clicks it stood for are Level, Refresh, Attach and Turn off and revoke: ${["Level: Observe only", "Refresh", "Attach the user's browser: on", "Attach the user's browser: off", "Turn off and revoke"].map((a) => outcome("computer", a)).join(", ")}`,
        "closing the instance": `its own Close window button, ${report.stop?.graceful ? "it exited" : "then by PID"}`,
      },
    },
    "4 computer use and share on the isolated profile": {
      verdict: outcome("computer", "own pipe") === "check"
        && all([["computer", "Level: Observe only"], ["computer", "Refresh"], ["computer", "Attach the user's browser: on"], ["computer", "Attach the user's browser: off"], ["computer", "Turn off and revoke"]], ["effect"])
        && all([["share", "Publish (service unreachable)"], ["share", "Save service (invalid URL)"]], ["refusal"])
        && all([["share", "Publish (local reference server)"], ["share", "Revoke"], ["share", "Forget"]], ["effect"])
        ? "closed except Observe and act (not started, see notExercised)" : "open",
      userPipeDaemons: state.computer ? { before: state.computer.userPipeDaemonsBefore, after: state.computer.userPipeDaemonsAfter } : null,
    },
  };
  // The follow-ups of the second adversarial check (06/10/2026), read back from the audit.
  const passed = (surface, action, wanted) => wanted.includes(outcome(surface, action));
  report.followUps = {
    "1 quoted command path (M3-01)": passed("connectors", "Probe (quoted command path", ["effect"]) ? "closed" : "open",
    "2 posture from the running host": all([["readonly", "Project switched to Project while live"], ["readonly", "Project switched to Read only while live"]], ["observed"])
      && all([["readonly", "Restart host (posture note): the host now writable"], ["readonly", "Restart host (posture note): the host now Read only"]], ["effect"]) ? "closed" : "open",
    "3 Forget token with conversations holding the bearer": passed("remote", "Forget token, with a conversation holding the bearer", ["effect"])
      && passed("remote", "Reconnect with current connectors after Forget token", ["effect"]) ? "closed" : "open",
    "4 Use in Muse, Enable/Disable, Refresh tools, the engine's fixture, a forced Computer use failure": all([
      ["connectors", "Use in Muse: on (local connector)"], ["connectors", "Reconnect with current connectors (Use in Muse on)"], ["connectors", "Use in Muse: off (local connector)"],
      ["connectors", "Reconnect with current connectors (Use in Muse off)"], ["connectors", "Disable / Enable (local connector)"], ["connectors", "Refresh tools (local connector)"],
      ["computer", "The next action after the forced failure"]], ["effect"]) && passed("computer", "Level: Observe only, the instance's pipe held", ["refusal"]) ? "closed" : "open",
    "5 labels": outcome("computer", "own pipe") === "check" && outcome("readonly", "composer") === "observed" && outcome("connectors", "Add (curated catalog entry)") === "effect" ? "corrected" : "open",
    "6 a replaced or closed host keeps its conversation's live events (found by the 0d677ea live turn)":
      passed("readonly", "Run in Muse after every host replacement so far", ["effect"])
      && passed("readonly", "The conversation's engine view after every host replacement", ["check"])
      && passed("readonly", "Close window: the conversation's host ends it cleanly", ["check"]) ? "closed" : "open",
    "F1 stored bearer bound to its URL": "unit and wiring tests (test/remoteMcp.test.ts, test/visibleFailures.test.ts); the failed save it needs cannot be forced here: the one trigger that was certain (a bearer over 1,280 characters on Windows) is refused up front (F7)",
    "F2": passed("remote", "Forget token, with a conversation holding the bearer", ["effect"]) ? "closed" : "open",
    "F3": passed("remote", "Reconnect (row) with a token typed for another URL", ["effect"]) ? "closed" : "open",
    "F4": passed("remote", "Connect to a URL that redirects", ["refusal"]) ? "closed" : "open",
    "F5": passed("remote", "Connect to https://localhost./mcp", ["refusal"]) ? "closed" : "open",
    "F6": passed("remote", "Connect to an SSE answer held open", ["refusal"]) ? "closed" : "open",
    "F7": passed("remote", "Connect with a 1,300-character token", ["refusal"]) ? "closed" : "open",
    "F8": passed("remote", "Forget token while a Reconnect runs", ["refusal"]) ? "closed" : "open",
  };
  // Measured earlier, on the build before this branch's fixes (its own rehearsal record, merged as is).
  const beforeFix = argValue("--before-fix", null);
  if (beforeFix) report.beforeFix = JSON.parse(readFileSync(beforeFix, "utf8"));
  report.notExercised = [
    "Computer use 'Observe and act': not started in this session. A direct probe of the driver with --dangerously-bypass-approvals was refused by the session's permission classifier, so the unrestricted service was not started through the app either; the user decides. Its launch defect is fixed and unit-tested (serve_argv matrix); the one click on the pre-fix build is under beforeFix.",
    "Share 'Copy link' and Computer use 'Copy install command': they write the system clipboard, which test mode does not isolate.",
    "A remote connector over public HTTPS: the remote section uses the loopback test origin of ADR 0003 (plain HTTP, no TLS check exercised).",
    "Computer use 'Install cua-driver': the driver is installed; its installer is machine-wide.",
    "A valid MCP Bundle install: covered by the M3-03 proof (scripts/cdp-m3-03-mcpb-install.mjs), not repeated here.",
  ];
  report.disclosedForgeries = [
    "Clicks are DOM clicks on the real control in the real webview (HTMLElement.click()), not OS mouse input; typing sets the value through the native setter and fires input, a select fires change.",
    "The OS folder dialog of 'Choose project folders' is answered by the harness (window.__baselineIpc.dialogQueue, plugin:dialog|open never reaches the OS); so is the OK/Cancel box of the posture note's 'Restart host' (messageQueue, plugin:dialog|message, answered OK).",
    "File inputs (index folder, import file, MCP Bundle) are fed with DOM.setFileInputFiles: the OS file dialog cannot be driven over CDP.",
    "The native browser window has no in-app close control and exposes no title-bar button to UI Automation: it is closed through its own close action in UI Automation (WindowPattern.Close, what Alt+F4 or a screen reader does), not clicked with the mouse.",
    "Own-pipe check: the harness holds a server on the pipe the instance must use (accepting, never answering) and invokes computer_status over IPC, so the instance's status probe lives long enough to read its argv; it then closes that server. The forced failure of a level change holds that pipe the same way while 'Observe only' is clicked.",
    "The remote server is the harness's own loopback bearer server (scripts/mcp-bearer-test-server.mjs), reachable only because test mode names its origin (MUSE_DESKTOP_TEST_REMOTE_MCP); its admin calls (accept a token hash, slow its answers for the Forget token check) are the harness's, never the app's. Its tokens are dummies; the record holds labels for their hashes.",
    "computer_status, collect_diagnostics and read_session_history are also invoked directly over IPC to measure state; no action is performed through IPC.",
  ];
  report.method = "One launch of the debug build in test mode: a fresh data folder and WebView2 profile, started from PowerShell with no WEBVIEW2_* variable, the local engine pinned by MUSE_DESKTOP_TEST_SIDECAR, MUSE_NO_AUTO_UPDATE=1, CDP through the WebView2 options. Isolation is checked before driving (test-mode.pid, --user-data-dir under the test folder), and the computer-use pipe before any Computer use click. Effects are measured outside the click: IPC results traced on window.fetch, localStorage, files under the test folder, Win32_Process argv and parents (engine and its replacements, the local MCP fixture as the engine's child or the app's, app shell, cua-driver daemons and probes), the driver's per-user pid file, Credential Manager entry names (cmdkey, never a value), the share server read by a second client, the bearer test server's own request log (which bearer, as a hash, reached which path, from the webview or the engine), a harness HTTP server's own log, CDP targets, UI Automation windows, the host's own history (session/read). The user's computer-use pipe is never connected to: daemons on it are read from the process table. The instance is closed with its own Close window button, then by PID.";
  const redact = redactor([[DATA, "<appdata>"], [PROJECT_DIR, "<project>"], [BASE, "<proof>"], [REPO, "<repo>"], [dirname(SIDECAR), "<engine-dir>"], [dirname(EXE), "<target>"]]);
  let record = redact(report);
  if (remoteServer) record = JSON.parse(JSON.stringify(record).replaceAll(remoteServer.origin, "http://127.0.0.1:<port>"));
  if (SECRETS.some((token) => JSON.stringify(record).includes(token))) throw new Error("refusing to record: a token reached the record");
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ summary: record.summary, liveTurns: record.liveTurns, out: OUT }, null, 2)}\n`);
  process.exit(0);
}

await main();
