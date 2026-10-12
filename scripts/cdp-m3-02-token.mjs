#!/usr/bin/env node

/**
 * M3-02 native acceptance, the Windows criteria left open on 05/10/2026: an
 * expired token and the bearer kept in Windows Credential Manager. A local
 * bearer-protected MCP server (scripts/mcp-bearer-test-server.mjs) on
 * 127.0.0.1 and the debug build in its isolated test mode (ADR 0003).
 *
 * The app refuses a loopback remote URL (public HTTPS only, src/lib/connectors.ts)
 * and has no TLS trust path of its own: the test instance names the server's
 * exact origin through MUSE_DESKTOP_TEST_REMOTE_MCP, its one test-mode
 * allowance (test_mode.rs). TLS is not exercised here.
 *
 * Phases, in order, on one app instance this harness started (state under
 * --base\<build>):
 *   start     the test server, then the app with a fresh data folder; the
 *             app's credential entries listed by name (cmdkey), never a value.
 *   add       (1) the remote connector added through the form with dummy
 *             token A; the server's hash of the bearer; the entry in
 *             Credential Manager; one tool call through the panel.
 *   relaunch  (2) the data folder scanned for token A with the app closed;
 *             relaunch on the same folder; Reconnect with the token field
 *             empty: the bearer re-read from Credential Manager.
 *   expire    (3) the server expires token A; a tool call from the panel,
 *             then Reconnect: the state the app shows, the time it takes,
 *             every request the server saw.
 *   renew     (4) dummy token B through the form; Disconnect then Reconnect
 *             (field empty) shows which token the store now holds.
 *   checks    a probe under the same name to another path with the token
 *             field empty (whose bearer goes there?); the server ends every
 *             MCP session, then a tool call (one re-handshake?).
 *   turn      (5) one live turn: "Use in Muse" on, a new conversation whose
 *             first message the page refuses (the engine's MCP connection is
 *             read before any turn), then the prompt through the composer asks
 *             the model to call echo_nonce; the server's answer must be in the
 *             reply. Resumable, never a second turn.
 *   forget    (6) Forget token: the entry gone from Credential Manager, then
 *             Reconnect: no bearer sent, what the connector says.
 *   cleanup   the connector removed, the app closed, the credential entries
 *             listed again, the server stopped, the tokens dropped from the
 *             state file, then the whole run folder searched for both tokens
 *             (the search checked on a canary).
 *   verdict   no app: the per-criterion verdicts of every run in --out.
 *
 * Tokens are dummies drawn here; the server only ever holds their sha256 and
 * logs `bearer:<sha256/12>`; the page tap hashes every secret it sees. The
 * record holds hashes, never a token. A stored bearer is never sent anywhere
 * but the test server: the connector name is unique per run.
 *
 * Usage:
 *   node scripts/cdp-m3-02-token.mjs <phase> --build <pre-fix|fixed>
 *     [--base G:\muse-proofs\m3-02] [--exe <muse-desktop.exe>] [--engine <muse exe>]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m3-02-remote-mcp-token.json]
 * CDP on MUSE_CDP_PORT (9334). MUSE_NO_AUTO_UPDATE=1 for every process.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, relative, resolve } from "node:path";

process.env.MUSE_CDP_PORT ??= "9334";
process.env.MUSE_NO_AUTO_UPDATE = "1";
const { PORT, argValue, gitHead, openPage, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const PHASE = process.argv[2];
const BUILD = argValue("--build", "fixed");
const ROOT = argValue("--base", "G:\\muse-proofs\\m3-02");
const BASE = join(ROOT, BUILD);
const EXE = resolve(argValue("--exe", join("src-tauri", "target", "debug", "muse-desktop.exe")));
const ENGINE = resolve(argValue("--engine", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m3-02-remote-mcp-token.json");
const STATE = join(BASE, "harness-state.json");
const PROJECT = join(BASE, "project");
const SERVICE = "com.muse.desktop.mcp";
const J = JSON.stringify;

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
/** Every token this process has held: the record refuses all of them. */
const secrets = new Set();
const state = () => {
  const s = readJson(STATE, {});
  for (const token of [s.tokenA, s.tokenB]) if (token) secrets.add(token);
  return s;
};
const saveState = (patch) => { mkdirSync(BASE, { recursive: true }); writeFileSync(STATE, J({ ...state(), ...patch }, null, 2)); };
const sha12 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const bearerOf = (token) => `bearer:${sha12(token)}`;

// ---- record ---------------------------------------------------------------------

function engineVersion() {
  try {
    return execFileSync(ENGINE, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}
const exeSha256 = () => createHash("sha256").update(readFileSync(EXE)).digest("hex");
/** No uncommitted change outside the harnesses and the docs: the exe can be rebuilt from `commit`. */
const productTreeClean = () => execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude)scripts", ":(exclude)docs"], { encoding: "utf8" }).trim() === "";

/** Paths and the user profile out of anything recorded; a token there stops the run. */
function scrub(value) {
  state();
  let text = J(value);
  for (const [path, label] of [[BASE, "<run>"], [ROOT, "<proof>"]]) {
    for (const form of new Set([path, path.replaceAll("\\", "/"), path.replaceAll("\\", "\\\\")])) text = text.split(form).join(label);
  }
  text = text.replace(/[A-Za-z]:(\\\\|\/)Users(\\\\|\/)[^"\\/]+/g, "<home>");
  for (const token of secrets) {
    if (text.includes(token)) throw new Error("refusing to record: a token reached the record");
  }
  return JSON.parse(text);
}

function merge(result) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m3-02-remote-mcp-token.v1",
    ticket: "M3-02",
    criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-02 (expired token) and docs/ROADMAP.md §M3-02 (Windows Credential Manager storage, Forget token)",
    runs: {},
  });
  record.date = new Date().toISOString().slice(0, 10);
  record.platform = `win32 ${release()}, debug build in its isolated test mode (ADR 0003), WebView2 over CDP`;
  record.runs[BUILD] ??= { phases: {} };
  const run = record.runs[BUILD];
  run.commit = gitHead();
  run.productTreeClean = productTreeClean();
  run.exeSha256 = exeSha256();
  run.engine = engineVersion();
  run.phases[PHASE] = scrub(result);
  run.liveTurns = Object.values(run.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  record.liveTurns = Object.values(record.runs).reduce((n, r) => n + (r.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${J(record, null, 2)}\n`);
  return run.phases[PHASE];
}

// ---- credential manager, names only ---------------------------------------------

/** Every Credential Manager target under the app's keyring service (keyring 3: `<key>.<service>`). Names only. */
function credentialTargets() {
  const out = execFileSync("cmdkey", ["/list"], { encoding: "latin1" });
  return [...out.matchAll(/target=(\S+)/gi)].map((m) => m[1]).filter((name) => name.endsWith(`.${SERVICE}`)).sort();
}
const credentialKey = (name) => `remote-mcp-remote-${name}`;
const credentialTarget = (name) => `${credentialKey(name)}.${SERVICE}`;
/** For the record: the test entry by name, any other entry under the service only counted. */
const credentialView = (targets, name) => ({ underService: targets.length, testEntry: targets.includes(credentialTarget(name)), others: targets.filter((t) => t !== credentialTarget(name)).length });

// ---- the test server ------------------------------------------------------------

async function startServer() {
  const s = state();
  if (s.server && (await serverAlive(s.server))) return s.server;
  mkdirSync(BASE, { recursive: true });
  const adminKey = randomBytes(24).toString("hex");
  const outFile = join(BASE, "server-out.txt");
  const logFile = join(BASE, "server-log.jsonl");
  const fd = openSync(outFile, "w");
  const child = spawn(process.execPath, ["scripts/mcp-bearer-test-server.mjs", "--port", "0", "--log", logFile], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, MCP_TEST_ADMIN_KEY: adminKey, MUSE_NO_AUTO_UPDATE: "1" },
  });
  child.unref();
  closeSync(fd);
  const line = await waitFor(() => { try { return readFileSync(outFile, "utf8").split("\n").find((l) => l.startsWith("{")) ?? null; } catch { return null; } }, 10_000, 100);
  if (!line) throw new Error("the test server did not start");
  const { url, pid } = JSON.parse(line);
  const server = { url, pid, adminKey, origin: new URL(url).origin };
  saveState({ server });
  return server;
}

async function serverAlive(server) {
  try { return (await fetch(new URL("/admin/log", server.url), { headers: { "x-admin-key": server.adminKey }, signal: AbortSignal.timeout(3_000) })).ok; } catch { return false; }
}

async function admin(path, body) {
  const { server } = state();
  const response = await fetch(new URL(path, server.url), {
    method: path === "/admin/log" ? "GET" : "POST",
    headers: { "x-admin-key": server.adminKey, "content-type": "application/json" },
    body: body === undefined ? undefined : J(body),
  });
  return response.json();
}
const serverLog = async (since = 0) => (await admin("/admin/log")).filter((row) => row.seq > since);
const lastSeq = async () => (await admin("/admin/log")).at(-1)?.seq ?? 0;
/** What one stretch of the server log says, without timestamps. */
const requestsOf = (rows) => rows.filter((r) => r.kind === "mcp").map((r) => ({
  from: r.origin ? "webview" : "engine", path: r.path, http: r.http, rpc: r.rpc, auth: r.auth, token: r.token, session: r.session ?? null, status: r.status,
  ...(r.origin ? {} : { ua: r.ua }),
  ...(r.tool ? { tool: r.tool, nonce: r.nonce, proof: r.proof } : {}),
}));

// ---- app lifecycle -------------------------------------------------------------

function appPids() {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"], { encoding: "utf8" })
      .split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}
const alive = (pid) => appPids().includes(Number(pid));
const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };

/** The isolated test mode, started from PowerShell with no WEBVIEW2_* variable (ADR 0003). */
async function launchApp({ restart = false } = {}) {
  if (!readFileSync(EXE).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  const s = state();
  const launches = (s.launches ?? 0) + (restart ? 0 : 1);
  const data = restart ? s.data : join(BASE, `appdata-${launches}`);
  if (!restart && existsSync(data)) throw new Error(`${data} exists: every launch takes a fresh data folder`);
  mkdirSync(data, { recursive: true });
  const pid = Number(execFileSync("powershell", ["-NoProfile", "-Command", [
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${data}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${J([ENGINE.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    `$env:MUSE_DESKTOP_TEST_REMOTE_MCP = '${s.server.origin}'`,
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${EXE}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")], { encoding: "utf8" }).trim());
  saveState({ pid, data, launches, dataDirs: [...new Set([...(s.dataDirs ?? []), data])] });
  const entered = await waitFor(() => { try { return readFileSync(join(data, "test-mode.pid"), "utf8").trim() === String(pid); } catch { return false; } }, 10_000, 100);
  if (!entered) {
    forceKill(pid);
    saveState({ pid: null });
    throw new Error("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  }
  return pid;
}

/** CDP on this harness's instance only: its WebView2 profile must lie under its data folder. */
async function attach() {
  const { data, pid } = state();
  if (!pid || !alive(pid)) throw new Error("no app instance of this harness is running: run start");
  let app = null;
  await waitFor(async () => { try { app = await openPage(); return true; } catch { return false; } }, 120_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  if (!data || !under(webviewProfile(), data)) {
    app.close();
    forceKill(pid);
    saveState({ pid: null });
    throw new Error("the WebView2 browser is not on the test profile: stopped before driving the app");
  }
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  await app.ev(TAP);
  return app;
}

/** Window close (WM_CLOSE) first; force only if the app is still there after 20 s. */
async function closeApp(app) {
  app?.close();
  const pid = state().pid;
  if (!pid) return { closed: false, reason: "no pid" };
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await waitFor(() => !alive(pid), 20_000, 1_000));
  if (!graceful) {
    forceKill(pid);
    await waitFor(() => !alive(pid), 10_000, 1_000);
  }
  saveState({ pid: null });
  return { graceful, exited: !alive(pid) };
}

// ---- page side --------------------------------------------------------------------

/**
 * IPC tap on window.fetch (the Tauri transport), for the few commands this
 * proof reads. Every secret is hashed in the page (sha256/12) before it is
 * kept: the bearer given to secure_store_set, the one secure_store_get
 * returns, the Authorization header of start_session's MCP servers. Answers
 * the folder dialog from a queue (CDP cannot drive the OS dialog).
 */
const TAP = `(() => {
  if (window.__m302 && window.__m302.installed) return 'present';
  const tap = window.__m302 = { installed: true, calls: [], dialogQueue: [], t0: Date.now() };
  const original = window.fetch.bind(window);
  const hash = async (text) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  };
  const kept = new Set(['secure_store_set', 'secure_store_get', 'secure_store_remove', 'start_session', 'send_input', 'test_remote_mcp_origin', 'plugin:dialog|open']);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
    const cmd = match ? decodeURIComponent(match[1]) : null;
    if (!cmd || !kept.has(cmd)) return original(input, init);
    let args = null;
    try { args = typeof (init && init.body) === 'string' ? JSON.parse(init.body) : null; } catch { args = null; }
    const entry = { atMs: Date.now() - tap.t0, cmd };
    if (cmd === 'secure_store_set') entry.args = { key: args && args.key, secretSha12: args && args.secret ? await hash(args.secret) : null };
    else if (cmd.startsWith('secure_store_')) entry.args = { key: args && args.key };
    else if (cmd === 'send_input') entry.args = { sessionId: args && args.sessionId };
    else if (cmd === 'start_session') {
      const servers = (args && args.mcpServers) || [];
      entry.args = { authorizationMode: args && args.authorizationMode, mcpServers: await Promise.all(servers.map(async (s) => ({
        transport: s.transport, url: s.url || null, mode: s.mode || null, headerNames: Object.keys(s.headers || {}),
        authorizationSha12: s.headers && s.headers.Authorization ? await hash(String(s.headers.Authorization).replace(/^Bearer /, '')) : null,
      }))) };
    }
    tap.calls.push(entry);
    // A command in tap.block is refused before the backend (no turn can leave).
    if ((tap.block || []).includes(cmd)) {
      entry.blockedByHarness = true;
      entry.ok = false;
      return new Response(JSON.stringify('blocked by the test harness'), { status: 200, headers: { 'Tauri-Response': 'error', 'Content-Type': 'application/json' } });
    }
    if (cmd === 'plugin:dialog|open' && tap.dialogQueue.length > 0) {
      entry.answeredByHarness = true;
      entry.ok = true;
      return new Response(JSON.stringify(tap.dialogQueue.shift()), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
    }
    const response = await original(input, init);
    entry.ok = response.headers.get('Tauri-Response') === 'ok';
    let text = null;
    try { text = await response.clone().text(); } catch { text = null; }
    if (cmd === 'secure_store_get') {
      let value = null;
      try { value = JSON.parse(text); } catch { value = undefined; }
      entry.result = !entry.ok ? 'error' : value === null ? null : typeof value === 'string' ? { sha12: await hash(value) } : 'other';
    } else if (cmd === 'start_session') {
      let meta = null;
      try { meta = JSON.parse(text); } catch { meta = null; }
      entry.result = entry.ok ? { sessionId: meta && meta.session_id } : String(text).slice(0, 300);
    } else if (cmd === 'test_remote_mcp_origin') {
      entry.result = text;
    } else if (!entry.ok) {
      entry.result = String(text).slice(0, 300);
    }
    return response;
  };
  return 'installed';
})()`;

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const panel = document.querySelector('[aria-label="Connectors"]');
  const field = (label) => panel?.querySelector('input[aria-label="' + label + '"]') || null;
  const submit = () => [...(panel?.querySelectorAll('form.integration-form button[type=submit]') || [])].find((b) => /connect/i.test(b.textContent)) || null;
  const statusRows = () => [...(panel?.querySelectorAll('.integration-remote-status') || [])]
    .map((r) => ({ text: text(r.querySelector('span')), buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
  const statusButton = (label) => [...(panel?.querySelectorAll('.integration-remote-status button') || [])].find((b) => b.textContent.trim() === label) || null;
  const remoteHeading = () => [...(panel?.querySelectorAll('h4') || [])].find((n) => /^Remote MCP connector/.test(n.textContent.trim())) || null;
  const facts = () => {
    const block = panel?.querySelector('[aria-label="Remote MCP connection result"]');
    const heading = remoteHeading();
    const row = (store('muse-desktop.connectors.v1', '[]') || []).filter((e) => e && e.kind === 'remote');
    const useInMuse = [...(panel?.querySelectorAll('li.integration-row') || [])].map((li) => {
      const box = [...li.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(l.textContent))?.querySelector('input');
      return box ? { name: text(li.querySelector('strong')), checked: box.checked, disabled: box.disabled } : null;
    }).filter(Boolean);
    return {
      copy: text(heading?.nextElementSibling),
      tokenFieldEmpty: (field('Remote MCP bearer token')?.value || '') === '',
      notice: [...(panel?.querySelectorAll('p.integration-notice') || [])].map((n) => text(n)).filter((t) => !/^Connected to /.test(t)),
      connectedBlock: text(block?.querySelector('p')),
      tools: block ? [...block.querySelectorAll('select option')].map((o) => o.value) : [],
      callOutput: text(block?.querySelector('pre.local-mcp-output')),
      statusRows: statusRows(),
      useInMuse,
      registry: row.map((e) => ({ id: e.id, name: e.name, status: e.status, url: e.url, tools: (e.tools || []).map((t) => t.name), useInMuse: e.useInMuse === true, guardMessage: e.guardMessage || null })),
    };
  };
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const tapCalls = (app, since = 0) => app.ev(`window.__m302.calls.slice(${since})`);
const tapCount = (app) => app.ev("window.__m302.calls.length");

async function openExtensions(app) {
  const ok = await app.ev(page(`
    document.querySelector('button[aria-label="Extensions"]')?.click();
    for (let i = 0; i < 40 && !document.querySelector('[aria-label="Connectors"]'); i++) await pause(100);
    return Boolean(document.querySelector('[aria-label="Connectors"]'));
  `));
  if (!ok) throw new Error("Extensions page not reached");
}

/** Fill the remote form and connect; timed from the click to the end of the busy state. */
async function connectThroughForm(app, { name, url, token }) {
  await openExtensions(app);
  const clicked = await app.ev(page(`
    setValue(field('Remote connector name'), ${J(name)});
    setValue(field('Public HTTPS connector URL'), ${J(url)});
    setValue(field('Remote MCP bearer token'), '');
    await pause(200);
    const b = submit();
    if (!b || b.disabled) return { clicked: false };
    return { clicked: true };
  `));
  if (!clicked.clicked) return { clicked: false };
  if (token) {
    // Typed like a user: CDP key input into the focused password field.
    await app.ev(page("field('Remote MCP bearer token').focus(); return true;"));
    await app.send("Input.insertText", { text: token });
  }
  const typed = await app.ev(page("return (field('Remote MCP bearer token')?.value || '').length;"));
  await app.ev(page("window.__m302.clickAt = Date.now(); submit().click(); return true;"));
  const settledMs = await waitFor(() => app.ev(page(`
    const b = submit();
    return b && !b.disabled && /^Connect and list tools$/.test(b.textContent.trim()) ? Date.now() - window.__m302.clickAt : null;
  `)), 75_000, 150);
  await sleep(300);
  return { clicked: true, tokenCharsTyped: typed, settledMs, ...(await app.ev(page("return facts();"))) };
}

/**
 * A status-row button (Reconnect, Disconnect, Forget token); waits for `until`
 * (a page predicate) or the bound. The token field is emptied first: Reconnect
 * sends what the field holds, and only an empty field makes it read the store.
 */
async function statusAction(app, label, until, timeoutMs = 45_000) {
  await openExtensions(app);
  await app.ev(page("const f = field('Remote MCP bearer token'); if (f && f.value) setValue(f, ''); await pause(150); return true;"));
  const clicked = await app.ev(page(`const b = statusButton(${J(label)}); if (!b || b.disabled) return false; window.__m302.clickAt = Date.now(); b.click(); return true;`));
  if (!clicked) return { clicked: false, ...(await app.ev(page("return facts();"))) };
  const settledMs = await waitFor(() => app.ev(page(`return (${until}) ? Date.now() - window.__m302.clickAt : null;`)), timeoutMs, 150);
  await sleep(300);
  return { clicked: true, settledMs, ...(await app.ev(page("return facts();"))) };
}

/** Call echo_nonce from the panel (through the one-time approval when the posture asks). */
async function callFromPanel(app, nonce) {
  await openExtensions(app);
  const clicked = await app.ev(page(`
    const block = panel.querySelector('[aria-label="Remote MCP connection result"]');
    const area = block?.querySelector('textarea');
    if (!area) return { clicked: false, reason: 'no connected result block' };
    setValue(area, ${J(J({ nonce }))});
    await pause(200);
    const b = [...block.querySelectorAll('button')].find((n) => /call/i.test(n.textContent));
    if (!b || b.disabled) return { clicked: false, reason: 'no enabled call button' };
    const label = b.textContent.trim();
    window.__m302.clickAt = Date.now();
    b.click();
    await pause(300);
    const allow = [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.textContent.trim() === 'Allow once');
    if (allow) { window.__m302.clickAt = Date.now(); allow.click(); }
    return { clicked: true, label, approvedOnce: Boolean(allow) };
  `));
  if (!clicked.clicked) return clicked;
  const settledMs = await waitFor(() => app.ev(page(`
    const busy = [...panel.querySelectorAll('button')].some((n) => n.textContent.trim() === 'Calling…');
    return busy ? null : Date.now() - window.__m302.clickAt;
  `)), 75_000, 150);
  await sleep(400);
  return { ...clicked, settledMs, ...(await app.ev(page("return facts();"))) };
}

// ---- disk scan ---------------------------------------------------------------------

/** Every file under the given folders, read whole, searched for each token as UTF-8 and UTF-16LE. */
function scan(dirs, tokens) {
  const needles = tokens.flatMap(([label, token]) => [[label, "utf8", Buffer.from(token, "utf8")], [label, "utf16le", Buffer.from(token, "utf16le")]]);
  const out = { files: 0, bytes: 0, unreadable: 0, hits: [] };
  const walk = (dir, root) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { out.unreadable += 1; return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, root); continue; }
      let data;
      try { data = readFileSync(full); } catch { out.unreadable += 1; continue; }
      out.files += 1;
      out.bytes += data.length;
      for (const [label, encoding, needle] of needles) {
        if (data.includes(needle)) out.hits.push({ file: relative(root, full).replaceAll("\\", "/"), token: label, encoding });
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir, dir);
  return out;
}

// ---- phases --------------------------------------------------------------------------

async function phaseStart() {
  if (state().pid && alive(state().pid)) throw new Error("this run already has an app instance: run cleanup first");
  const name = state().name ?? `m302-${randomBytes(3).toString("hex")}`;
  const before = credentialTargets();
  if (before.includes(credentialTarget(name))) throw new Error("the test connector's credential name already exists: refusing");
  saveState({ name, credentialTargetsBefore: before });
  const server = await startServer();
  await launchApp();
  const app = await attach();
  try {
    const origin = await app.ev("window.__TAURI_INTERNALS__.invoke('test_remote_mcp_origin')");
    await openExtensions(app);
    const profile = await app.ev(page(`return { remotes: (store('muse-desktop.connectors.v1', '[]') || []).filter((e) => e && e.kind === 'remote').length,
      posture: localStorage.getItem('muse-desktop.authorization-mode.v1') };`));
    const result = {
      isolation: { testModeMarker: true, webviewProfileUnderTestFolder: true, cdpPort: PORT },
      server: { url: server.url },
      connectorName: name,
      credentialTarget: credentialTarget(name),
      credentialsBefore: credentialView(before, name),
      appLoopbackAllowance: origin,
      profile,
    };
    result.verdict = { allowanceIsServerOrigin: origin === server.origin, emptyRemoteRegistry: profile.remotes === 0, nameUnused: !before.includes(credentialTarget(name)) };
    return result;
  } finally {
    app.close();
  }
}

async function phaseAdd() {
  const s = state();
  const tokenA = s.tokenA ?? `dummy-m302-A-${randomBytes(18).toString("base64url")}`;
  saveState({ tokenA });
  await admin("/admin/accept", { sha256: createHash("sha256").update(tokenA).digest("hex") });
  const app = await attach();
  try {
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const connect = await connectThroughForm(app, { name: s.name, url: s.server.url, token: tokenA });
    const requests = requestsOf(await serverLog(mark));
    const credentials = credentialTargets();
    const ipc = await tapCalls(app, tapMark);
    const callMark = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const callRequests = requestsOf(await serverLog(callMark));
    const result = { tokenA: { sha12: sha12(tokenA) }, connect, requests, ipc, credentials: credentialView(credentials, s.name), call: { nonce, ...call, requests: callRequests } };
    const expected = bearerOf(tokenA);
    const stored = ipc.find((c) => c.cmd === "secure_store_set");
    result.verdict = {
      connected: /^Connected/.test(connect.statusRows[0]?.text ?? "") && /^Connected to m3-02-bearer-test 1\.0\.0 · 1 tool\(s\)/.test(connect.connectedBlock ?? ""),
      toolListed: connect.tools.includes("echo_nonce"),
      serverGotTokenA: requests.length > 0 && requests.every((r) => r.auth === expected && r.status < 300),
      storedUnderTestKey: stored?.args?.key === credentialKey(s.name) && stored?.args?.secretSha12 === sha12(tokenA) && stored?.ok === true,
      credentialManagerEntry: credentials.includes(credentialTarget(s.name)),
      onlyTestEntryAdded: credentials.filter((t) => !(state().credentialTargetsBefore ?? []).includes(t)).every((t) => t === credentialTarget(s.name)),
      authenticatedCall: callRequests.some((r) => r.rpc === "tools/call" && r.auth === expected && r.status === 200 && r.nonce === nonce)
        && (call.callOutput ?? "").includes(`nonce=${nonce}`),
    };
    return result;
  } finally {
    app.close();
  }
}

async function phaseRelaunch() {
  const s = state();
  let app = await attach();
  const closed = await closeApp(app);
  const scanClosed = scan([s.data], [["A", s.tokenA]]);
  await launchApp({ restart: true });
  app = await attach();
  try {
    await openExtensions(app);
    const afterRelaunch = await app.ev(page("return facts();"));
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '') || (submit() && !submit().disabled && statusRows()[0] && !/^Connected/.test(statusRows()[0].text) && window.__m302.calls.some((c) => c.cmd === 'secure_store_get' && c.result !== undefined))");
    const requests = requestsOf(await serverLog(mark));
    const ipc = await tapCalls(app, tapMark);
    const read = ipc.find((c) => c.cmd === "secure_store_get");
    const result = { closed, scanWithAppClosed: scanClosed, afterRelaunch, reconnect, requests, ipc, credentials: credentialView(credentialTargets(), s.name) };
    result.verdict = {
      relaunchedDisconnected: /^Disconnected/.test(afterRelaunch.statusRows[0]?.text ?? "") && afterRelaunch.tokenFieldEmpty,
      reconnectedWithoutTyping: reconnect.tokenFieldEmpty && /^Connected/.test(reconnect.statusRows[0]?.text ?? ""),
      bearerReadFromCredentialManager: read?.args?.key === credentialKey(s.name) && read?.result?.sha12 === sha12(s.tokenA),
      serverGotTokenA: requests.length > 0 && requests.every((r) => r.auth === bearerOf(s.tokenA) && r.status < 300),
      tokenNotInAppStorage: scanClosed.hits.length === 0 && scanClosed.files > 0,
    };
    return result;
  } finally {
    app.close();
  }
}

async function phaseExpire() {
  const s = state();
  const app = await attach();
  try {
    await openExtensions(app);
    const before = await app.ev(page("return facts();"));
    if (!/^Connected/.test(before.statusRows[0]?.text ?? "")) throw new Error("the connector is not connected: run relaunch first");
    const expired = await admin("/admin/expire", {});
    const mark = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const statusAfterMs = call.settledMs;
    await sleep(10_000); // anything after the failure: a retry loop would show here
    const callRequests = requestsOf(await serverLog(mark));
    const quiet = await app.ev(page("return facts();"));
    const mark2 = await lastSeq();
    const tapMark = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", "submit() && !submit().disabled && window.__m302.calls.slice(" + (await tapCount(app)) + ").some((c) => c.cmd === 'secure_store_get')");
    await sleep(3_000);
    const reconnectRequests = requestsOf(await serverLog(mark2));
    const result = { serverExpired: expired, before, call: { nonce, ...call, requests: callRequests }, afterTenSeconds: quiet,
      reconnect: { ...reconnect, requests: reconnectRequests, ipc: await tapCalls(app, tapMark) } };
    const expectedA = bearerOf(s.tokenA);
    result.verdict = {
      callFailedHonestly: quiet.notice.some((n) => /authentication was rejected or expired/.test(n)) && /^Disconnected/.test(quiet.statusRows[0]?.text ?? "")
        && quiet.connectedBlock === null && quiet.registry[0]?.status === "error",
      bounded: statusAfterMs !== null && statusAfterMs < 5_000,
      oneRehandshakeOnly: J(callRequests.map((r) => `${r.rpc}:${r.status}`)) === J(["tools/call:401", "initialize:401"])
        && callRequests.every((r) => r.auth === expectedA && r.token === "expired"),
      noFakeConnected: !/^Connected/.test(quiet.statusRows[0]?.text ?? "") && quiet.useInMuse.every((u) => u.disabled),
      reconnectRefusedHonestly: reconnectRequests.length === 1 && reconnectRequests[0].rpc === "initialize" && reconnectRequests[0].status === 401
        && reconnectRequests[0].auth === expectedA && /^Disconnected/.test(reconnect.statusRows[0]?.text ?? "")
        && reconnect.notice.some((n) => /authentication was rejected or expired/.test(n)),
    };
    return result;
  } finally {
    app.close();
  }
}

async function phaseRenew() {
  const s = state();
  const tokenB = s.tokenB ?? `dummy-m302-B-${randomBytes(18).toString("base64url")}`;
  saveState({ tokenB });
  await admin("/admin/accept", { sha256: createHash("sha256").update(tokenB).digest("hex") });
  const app = await attach();
  try {
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const connect = await connectThroughForm(app, { name: s.name, url: s.server.url, token: tokenB });
    const requests = requestsOf(await serverLog(mark));
    const ipc = await tapCalls(app, tapMark);
    const disconnect = await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000);
    const mark2 = await lastSeq();
    const tapMark2 = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '') || (submit() && !submit().disabled && window.__m302.calls.slice(" + tapMark2 + ").some((c) => c.cmd === 'secure_store_get' && c.result !== undefined))");
    const reconnectRequests = requestsOf(await serverLog(mark2));
    const read = (await tapCalls(app, tapMark2)).find((c) => c.cmd === "secure_store_get");
    const credentials = credentialTargets();
    const result = { tokenB: { sha12: sha12(tokenB) }, connect, requests, ipc, disconnect, reconnect: { ...reconnect, requests: reconnectRequests, read }, credentials: credentialView(credentials, s.name) };
    const stored = ipc.find((c) => c.cmd === "secure_store_set");
    result.verdict = {
      connected: /^Connected/.test(connect.statusRows[0]?.text ?? "") && connect.tools.includes("echo_nonce"),
      serverGotTokenB: requests.length > 0 && requests.every((r) => r.auth === bearerOf(tokenB) && r.status < 300),
      storeNowHoldsB: stored?.args?.secretSha12 === sha12(tokenB) && read?.result?.sha12 === sha12(tokenB)
        && reconnectRequests.length > 0 && reconnectRequests.every((r) => r.auth === bearerOf(tokenB) && r.status < 300),
      oneEntry: credentials.filter((t) => t === credentialTarget(s.name)).length === 1,
    };
    return result;
  } finally {
    app.close();
  }
}

async function phaseChecks() {
  const s = state();
  const app = await attach();
  try {
    await openExtensions(app);
    const before = await app.ev(page("return facts();"));
    if (!/^Connected/.test(before.statusRows[0]?.text ?? "")) throw new Error("the connector is not connected: run renew first");
    const current = s.tokenB ?? s.tokenA;
    // 1. Same name, another path on the same origin, token field empty.
    const elsewhere = new URL("/elsewhere/mcp", s.server.url).href;
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const otherUrl = await connectThroughForm(app, { name: s.name, url: elsewhere, token: "" });
    const otherRequests = requestsOf(await serverLog(mark));
    const otherIpc = await tapCalls(app, tapMark);
    // Back to the registered endpoint: Disconnect, then Reconnect (it re-reads
    // the stored bearer). A failed probe leaves the old session in memory
    // but hides its call block, so the reconnect is needed either way.
    if (/^Connected/.test(otherUrl.statusRows[0]?.text ?? "")) {
      await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000);
    }
    await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '')");
    const restored = await app.ev(page("return facts();"));
    // 2. The server ends every MCP session; the next call carries a dead session id.
    const dropped = await admin("/admin/drop-sessions", {});
    const mark2 = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const callRequests = requestsOf(await serverLog(mark2));
    const result = { otherPath: { url: elsewhere, ...otherUrl, requests: otherRequests, ipc: otherIpc, restored }, sessionEnded: { dropped, nonce, ...call, requests: callRequests } };
    result.verdict = {
      storedBearerStaysWithItsUrl: otherRequests.some((r) => r.path === "/elsewhere/mcp") && otherRequests.every((r) => r.path !== "/elsewhere/mcp" || r.auth === "none"),
      registryKeptItsUrl: restored.registry[0]?.url === s.server.url,
      sessionEndRecovered: /^Connected/.test(call.statusRows?.[0]?.text ?? "") && (call.callOutput ?? "").includes(`nonce=${nonce}`)
        && callRequests.filter((r) => r.rpc === "initialize").length === 1 && callRequests.every((r) => r.auth === bearerOf(current)),
    };
    return result;
  } finally {
    app.close();
  }
}

/**
 * Resumable: the conversation start (first message refused, engine connection
 * read) is kept in the state, and `turnSent` is set right before the one
 * click that sends the turn, so a rerun never sends a second one.
 */
async function phaseTurn() {
  let s = state();
  if (s.turnSent) throw new Error("this run already sent its live turn");
  mkdirSync(PROJECT, { recursive: true });
  if (!existsSync(join(PROJECT, "README.md"))) writeFileSync(join(PROJECT, "README.md"), "M3-02 proof project: nothing to change here.\n");
  const app = await attach();
  try {
    if (!s.turnStart) await startTurnConversation(app, s);
    s = state();
    const { sid, nonce, prompt, mark, tapMark } = s.turnStart;
    if ((await app.ev(page("return activeSid();"))) !== sid) {
      await app.ev(page(`row(${J(sid)})?.querySelector('button.session-select')?.click(); await pause(800); return true;`));
    }
    if ((await app.ev(page("return activeSid();"))) !== sid) throw new Error("refusing: the test conversation is not the active one");
    // The one live turn, through the composer.
    const ready = await app.ev(page(`
      const box = document.querySelector('textarea[aria-label="Message Muse"]');
      const send = document.querySelector('button.send');
      if (!box) return { ready: false, reason: 'no composer' };
      setValue(box, ${J(prompt)});
      await pause(300);
      return send && !send.disabled ? { ready: true } : { ready: false, reason: 'send disabled' };
    `));
    if (!ready.ready) throw new Error(`turn not sent: ${ready.reason}`);
    saveState({ turnSent: true });
    await app.ev(page("document.querySelector('button.send').click(); return true;"));
    const turn = await waitTurn(app, sid);
    const requests = requestsOf(await serverLog(mark));
    const engineCalls = requests.filter((r) => r.from === "engine");
    const answer = engineCalls.find((r) => r.tool === "echo_nonce" && r.nonce === nonce && r.status === 200);
    const reply = turn.entries.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
    const sends = (await tapCalls(app, tapMark)).filter((c) => c.cmd === "send_input").map((c) => ({ blockedByHarness: c.blockedByHarness === true, ok: c.ok ?? null }));
    const { startSession } = s.turnStart;
    const result = { liveTurns: 1, ...s.turnStart, sends, turn, requests };
    delete result.mark;
    delete result.tapMark;
    const server = startSession.mcpServers.find((m) => m.transport === "streamableHttp");
    result.verdict = {
      turnFinished: turn.finished,
      remoteInjectedWithBearer: server?.url === s.server.url && server?.authorizationSha12 === sha12(s.tokenB ?? s.tokenA),
      engineAuthenticated: engineCalls.length > 0 && engineCalls.every((r) => r.auth === bearerOf(s.tokenB ?? s.tokenA)),
      modelCalledEchoNonce: Boolean(answer),
      replyHasServerAnswer: Boolean(answer) && reply.includes(answer.proof) && reply.includes(nonce),
      oneTurnSent: sends.filter((x) => !x.blockedByHarness).length === 1,
    };
    return result;
  } finally {
    app.close();
  }
}

/** "Use in Muse" on, then a new conversation whose first message the page refuses (no turn). */
async function startTurnConversation(app, s) {
  await openExtensions(app);
  const before = await app.ev(page("return facts();"));
  if (!/^Connected/.test(before.statusRows[0]?.text ?? "")) throw new Error("the connector is not connected");
  const opted = await app.ev(page(`
    const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(s.name)}));
    const box = li && [...li.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(l.textContent))?.querySelector('input');
    if (!box || box.disabled) return { ok: false };
    if (!box.checked) box.click();
    await pause(400);
    return { ok: true, checked: box.checked };
  `));
  if (!opted.ok) throw new Error("Use in Muse is not available on the connector");
  const nonce = `N302-${randomBytes(4).toString("hex").toUpperCase()}`;
  const prompt = `Call the echo_nonce tool of the connected MCP server with nonce "${nonce}", then reply with the tool's text output exactly, nothing else.`;
  const mark = await lastSeq();
  const tapMark = await tapCount(app);
  // The conversation starts with its first message refused in the page (no
  // turn): the engine's own MCP connection is read before any turn is spent.
  await app.ev("(window.__m302.block = ['send_input'], true)");
  const started = await app.ev(page(`
    q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
    let picker = null;
    for (let i = 0; i < 50 && !picker; i++) { picker = document.querySelector('details.project-picker-control'); if (!picker) await pause(100); }
    if (!picker) return { started: false, reason: 'no project picker' };
    picker.open = true;
    await pause(300);
    // The proof folder, already a project or added now (the folder dialog answered by the harness).
    const known = [...document.querySelectorAll('.project-option')].find((b) => text(b.querySelector('strong')) === 'project');
    if (known) known.click();
    else {
      const add = document.querySelector('.project-option-new');
      if (!add) return { started: false, reason: 'no new-project option' };
      window.__m302.dialogQueue.push(${J(PROJECT)});
      add.click();
    }
    let note = '';
    for (let i = 0; i < 80; i++) { note = text(document.querySelector('.welcome-project-note')) || ''; if (note.startsWith('Runs in project')) break; await pause(100); }
    if (!note.startsWith('Runs in project')) return { started: false, reason: 'project not selected: ' + note };
    setValue(document.querySelector('textarea[aria-label="Your first message"]'), 'M3-02 setup: this message is refused by the test harness.');
    await pause(300);
    const start = document.querySelector('button.welcome-send');
    if (!start || start.disabled) return { started: false, reason: 'start disabled', note };
    start.click();
    return { started: true, note };
  `));
  if (!started.started) throw new Error(`could not start the conversation: ${started.reason}`);
  const startCall = await waitFor(async () => (await tapCalls(app, tapMark)).find((c) => c.cmd === "start_session" && c.result !== undefined) ?? null, 90_000, 400);
  const sid = startCall?.result?.sessionId;
  if (!sid) throw new Error(`start_session failed: ${J(startCall)}`);
  saveState({ sid });
  const engineAtStart = await waitFor(async () => {
    const rows = requestsOf(await serverLog(mark)).filter((r) => r.from === "engine");
    return rows.some((r) => r.rpc === "tools/list") ? rows : null;
  }, 20_000, 500) ?? requestsOf(await serverLog(mark)).filter((r) => r.from === "engine");
  const firstMessage = (await tapCalls(app, tapMark)).filter((c) => c.cmd === "send_input").map((c) => ({ blockedByHarness: c.blockedByHarness === true }));
  await app.ev("(window.__m302.block = [], true)");
  saveState({ turnStart: { sid, nonce, prompt, mark, tapMark, useInMuse: opted, startSession: startCall.args, firstMessage, engineAtStart } });
}

/** Until the turn of `sid` ends, answering approval cards with the narrowest allow. */
async function waitTurn(app, sid) {
  const t0 = Date.now();
  const approvals = [];
  let sawRunning = false;
  const done = await waitFor(async () => {
    const v = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
      return { running: running(${J(sid)}), cards: q('.approvals .approval').length, open: log.some((e) => e.open),
        assistant: log.some((e) => e.role === 'assistant' && String(e.text || '').trim()) };
    `));
    if (v.running === "true") sawRunning = true;
    if (v.cards > 0) {
      const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${J(sid)} })`);
      const choices = ((Array.isArray(res?.approvals) ? res.approvals : [])[0]?.choices ?? []).map((c) => ({ label: c.label ?? null, decision: c.decision?.kind ?? c.decision, scope: c.scope ?? null }));
      const allow = choices.filter((c) => !/^(abort|denied)/.test(String(c.decision)));
      const pick = allow.find((c) => /once|turn/i.test(`${c.scope} ${c.label}`)) ?? allow[0];
      const card = await app.ev(page("return text(q('.approvals .approval')[0])?.slice(0, 300) ?? null;"));
      if (pick) {
        const clicked = await app.ev(page(`const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === ${J(pick.label)}); if (b) b.click(); return !!b;`));
        approvals.push({ card, choices: choices.map((c) => `${c.label} [${c.decision}${c.scope ? `/${c.scope}` : ""}]`), clicked: pick.label, ok: clicked });
        await sleep(2_000);
      }
      return null;
    }
    return (sawRunning || Date.now() - t0 > 15_000) && v.running === "false" && !v.open && v.assistant ? v : null;
  }, 300_000, 1_000);
  const entries = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').slice(0, 1500) }));`));
  return { finished: Boolean(done), ms: Date.now() - t0, approvals, entries };
}

async function phaseForget() {
  const s = state();
  const app = await attach();
  try {
    await openExtensions(app);
    const before = await app.ev(page("return facts();"));
    const credentialsBefore = credentialTargets();
    const tapMark = await tapCount(app);
    const forget = await statusAction(app, "Forget token", "window.__m302.calls.slice(" + tapMark + ").some((c) => c.cmd === 'secure_store_remove' && c.ok !== undefined)", 10_000);
    forget.ipc = await tapCalls(app, tapMark);
    const credentialsAfter = credentialTargets();
    const mark = await lastSeq();
    const tapMark2 = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", "submit() && !submit().disabled && window.__m302.calls.slice(" + tapMark2 + ").some((c) => c.cmd === 'secure_store_get' && c.result !== undefined)");
    await sleep(1_500);
    const reconnectRequests = requestsOf(await serverLog(mark));
    const after = await app.ev(page("return facts();"));
    const result = { before, credentialsBefore: credentialView(credentialsBefore, s.name), forget,
      credentialsAfter: credentialView(credentialsAfter, s.name), reconnect: { ...reconnect, requests: reconnectRequests, ipc: await tapCalls(app, tapMark2) }, after };
    const read = result.reconnect.ipc.find((c) => c.cmd === "secure_store_get");
    result.verdict = {
      entryGone: credentialsBefore.includes(credentialTarget(s.name)) && !credentialsAfter.includes(credentialTarget(s.name)),
      removedThroughApp: result.forget.ipc.some((c) => c.cmd === "secure_store_remove" && c.args?.key === credentialKey(s.name) && c.ok === true),
      forgetNotice: forget.notice.some((n) => /forgotten/i.test(n)),
      disconnected: /^Disconnected/.test(forget.statusRows[0]?.text ?? ""),
      reconnectSendsNoBearer: read?.result === null && reconnectRequests.length > 0 && reconnectRequests.every((r) => r.auth === "none"),
      reconnectSaysNoTokenStored: after.notice.some((n) => /no token/i.test(n)),
    };
    return result;
  } finally {
    app.close();
  }
}

async function phaseCleanup() {
  const s = state();
  const result = {};
  if (s.pid && alive(s.pid)) {
    const app = await attach();
    try {
      await openExtensions(app);
      const tapMark = await tapCount(app);
      result.remove = await app.ev(page(`
        const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(s.name)}));
        const b = li && [...li.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove');
        if (b) { b.click(); await pause(1000); }
        return { removed: Boolean(b), remotesAfter: (store('muse-desktop.connectors.v1', '[]') || []).filter((e) => e && e.kind === 'remote').length };
      `));
      result.removeIpc = await tapCalls(app, tapMark);
    } finally {
      result.close = await closeApp(app);
    }
  }
  const credentialsAfter = credentialTargets();
  result.credentialsAfter = credentialView(credentialsAfter, s.name);
  if (s.server && (await serverAlive(s.server))) {
    result.serverLog = requestsOf(await serverLog(0));
    await admin("/admin/stop", {}).catch(() => null);
  }
  // The tokens leave the state file (their hashes stay), then the whole run
  // folder is searched: data folders, project, server log and output, state.
  const tokens = [["A", s.tokenA], ["B", s.tokenB]].filter(([, t]) => t);
  saveState({ tokenA: null, tokenB: null, tokenHashes: { A: s.tokenA ? sha12(s.tokenA) : null, B: s.tokenB ? sha12(s.tokenB) : null }, server: s.server ? { ...s.server, adminKey: null } : null });
  await sleep(2_000);
  result.scan = { dataFolders: (s.dataDirs ?? []).length, tokens: tokens.map(([label]) => label), ...scan([BASE], tokens) };
  // The scanner's own check: a canary written in UTF-16LE (as the WebView2
  // stores do) is found, then deleted.
  const canaryDir = join(ROOT, "scan-canary");
  const canary = `canary-${randomBytes(12).toString("base64url")}`;
  mkdirSync(canaryDir, { recursive: true });
  writeFileSync(join(canaryDir, "canary.bin"), Buffer.concat([randomBytes(64), Buffer.from(canary, "utf16le"), randomBytes(64)]));
  result.scanSelfCheck = scan([canaryDir], [["canary", canary]]).hits.map((h) => h.encoding);
  rmSync(canaryDir, { recursive: true, force: true });
  result.verdict = {
    noTestEntryLeft: !credentialsAfter.includes(credentialTarget(s.name)),
    credentialListAsBefore: J(credentialsAfter) === J(s.credentialTargetsBefore ?? null),
    tokensNeverOnDisk: tokens.length > 0 && result.scan.files > 0 && result.scan.hits.length === 0 && J(result.scanSelfCheck) === J(["utf16le"]),
  };
  return result;
}

function phaseVerdict() {
  const record = readJson(OUT, null);
  if (!record) throw new Error(`no record at ${OUT}`);
  const summary = {};
  for (const [build, run] of Object.entries(record.runs)) {
    const v = (phase) => run.phases[phase]?.verdict ?? null;
    const all = (o) => (o ? Object.values(o).every((x) => x === true) : null);
    summary[build] = {
      "(1) add with a bearer, Credential Manager entry": all(v("add")),
      "(2) relaunch: re-read without typing, token not in app storage": all(v("relaunch")),
      "(3) expired token: honest, bounded, one re-handshake": all(v("expire")),
      "(4) new token: connected, tools listed": all(v("renew")),
      "(5) live turn: the model calls echo_nonce": all(v("turn")),
      "(6) Forget token: entry gone, no token reported": all(v("forget")),
      "stored bearer stays with its URL": v("checks")?.storedBearerStaysWithItsUrl ?? null,
      "ended MCP session recovered by one re-handshake": v("checks")?.sessionEndRecovered ?? null,
      "cleanup: no entry, no token on disk": all(v("cleanup")),
    };
  }
  record.verdicts = summary;
  writeFileSync(OUT, `${J(record, null, 2)}\n`);
  return summary;
}

const PHASES = { start: phaseStart, add: phaseAdd, relaunch: phaseRelaunch, expire: phaseExpire, renew: phaseRenew, checks: phaseChecks, turn: phaseTurn, forget: phaseForget, cleanup: phaseCleanup };

if (PHASE === "verdict") {
  console.log(J(phaseVerdict(), null, 2));
} else if (PHASES[PHASE]) {
  if (!["pre-fix", "fixed"].includes(BUILD)) throw new Error("--build is pre-fix or fixed");
  const result = await PHASES[PHASE]();
  const recorded = merge(result);
  console.log(J({ phase: PHASE, build: BUILD, verdict: recorded.verdict ?? null }, null, 2));
} else {
  console.error(`unknown phase ${PHASE}: ${Object.keys(PHASES).join(", ")}, verdict`);
  process.exit(2);
}
