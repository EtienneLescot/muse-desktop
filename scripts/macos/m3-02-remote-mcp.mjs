#!/usr/bin/env node
/**
 * M3-02 native macOS proof: connect a remote MCP server, the bearer kept in
 * the macOS Keychain. The model of scripts/cdp-m3-02-token.mjs (Windows,
 * 05-06/10/2026), on the isolated test instance (scripts/macos/test-instance.mjs)
 * and the local bearer-protected server scripts/mcp-bearer-test-server.mjs.
 *
 * The app refuses a loopback remote URL (public HTTPS only); the test instance
 * names the server's exact origin through MUSE_DESKTOP_TEST_REMOTE_MCP, its one
 * test-mode allowance. Nothing leaves the machine: TLS is not exercised here.
 *
 * Phases, in order, in one run:
 *   start     the server (port --server-port), then the app; the Keychain
 *             entry of this run's connector checked absent (by its account
 *             name, never a value). The connector is named proof-g6-<id>.
 *   refusals  network refusals, no token typed: a private address (refused
 *             before any request), the server's origin with nothing listening
 *             (connection refused), a non-MCP path (404), a redirect (not
 *             followed), a stream held open (bounded by the client timeout).
 *   add       dummy token A typed in the form: connected, tools listed, the
 *             server saw A's hash, the Keychain entry appears; a panel call.
 *   relaunch  the app closed (store kept), the data folder and the WKWebView
 *             store searched for A; relaunch on the same folder; Reconnect
 *             with the field empty: the bearer read back from the Keychain.
 *   expire    the server expires A; a panel call: honest, bounded, one
 *             re-handshake; Reconnect refused the same way.
 *   renew     dummy token B: connected; Disconnect then Reconnect (field
 *             empty) sends B: the Keychain now holds B, one entry.
 *   checks    the same name with another path and no token (whose bearer
 *             goes there?); the server ends every MCP session, then a call
 *             (one re-handshake).
 *   down      disconnection: the server stops; a panel call ends on
 *             Disconnected; the server comes back on the same port; Reconnect
 *             (field empty) connects by a real exchange.
 *   turn      one live turn: Use in Muse on, a conversation started with its
 *             first message refused (the engine connects with the bearer
 *             before any turn), the model asked to call echo_nonce; the
 *             server's proof must be in the reply.
 *   forget    Forget token: the Keychain entry gone; Reconnect sends no bearer
 *             and says no token is stored.
 *   cleanup   Remove; the app closed; the store and the run folder searched
 *             for both tokens (the search checked on a UTF-16LE canary); the
 *             store deleted; the server stopped.
 *
 *   node scripts/macos/m3-02-remote-mcp.mjs [--exe <muse-desktop>] [--port 9462] [--server-port 9463]
 *     [--base $TMPDIR/muse-proofs-g6/m3-02] [--out docs/evidence/2026-10-13-macos-closure/m3-02-remote-mcp.json]
 *
 * One live turn. Tokens are dummies drawn here; the page tap hashes every
 * secret before keeping it; the record refuses any token.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, J, compareStamps, openExtensions, page, platform, processesMentioning, redactorFor,
  sendInConversation, sha12, sleep, startConversationNoTurn, userEngineStamp, waitFor, waitTurn, writeRecord,
} from "./m3-g6-common.mjs";
import { INSTALL_IPC_TRACE } from "../cdp-harness.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9462"));
const SERVER_PORT = Number(argValue("--server-port", "9463"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-02"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-02-remote-mcp.json");
const DATA = join(BASE, "data");
const PROJECT = join(BASE, "project");
const SERVICE = "com.muse.desktop.mcp";
const NAME = `proof-g6-${ID}`;
const ACCOUNT = `remote-mcp-remote-${NAME}`;
const SERVER_SCRIPT = fileURLToPath(new URL("../mcp-bearer-test-server.mjs", import.meta.url));
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const URL_MCP = `${ORIGIN}/mcp`;
const redact = redactorFor(BASE);
const tokenA = `dummy-g6-A-${randomBytes(18).toString("base64url")}`;
const tokenB = `dummy-g6-B-${randomBytes(18).toString("base64url")}`;
const secrets = [tokenA, tokenB];
const bearerOf = (token) => `bearer:${sha12(token)}`;
/** What the app stores in the Keychain: the bearer bound to its URL (remoteMcp.ts encodeStoredBearer). */
const storedOf = (token) => sha12(J({ url: URL_MCP, token }));
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, "README.md"), "M3-02 macOS proof project: nothing to change here.\n");

// ---- Keychain: this run's account only, presence only (never -w) ----------------
function keychainHas(account = ACCOUNT) {
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
  return { present: r.status === 0, exit: r.status };
}

// ---- the test server ---------------------------------------------------------------
let server = null;
async function startServer() {
  const adminKey = randomBytes(24).toString("hex");
  const outFile = join(BASE, `server-out-${Date.now()}.txt`);
  const fd = openSync(outFile, "w");
  const child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(SERVER_PORT), "--log", join(BASE, "server-log.jsonl")], {
    detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, MCP_TEST_ADMIN_KEY: adminKey },
  });
  child.unref();
  closeSync(fd);
  const line = await waitFor(() => { try { return readFileSync(outFile, "utf8").split("\n").find((l) => l.startsWith("{")) ?? null; } catch { return null; } }, 10_000, 100);
  if (!line) throw new Error(`the test server did not start: ${readFileSync(outFile, "utf8").slice(0, 300)}`);
  server = { pid: child.pid, adminKey, seqBase: server ? server.seqBase + (server.lastSeq ?? 0) : 0, lastSeq: 0 };
  return JSON.parse(line).url;
}
async function admin(path, body) {
  const response = await fetch(new URL(path, ORIGIN), {
    method: path === "/admin/log" ? "GET" : "POST",
    headers: { "x-admin-key": server.adminKey, "content-type": "application/json" },
    body: body === undefined ? undefined : J(body),
  });
  return response.json();
}
const serverLog = async (since = 0) => (await admin("/admin/log")).filter((row) => row.seq > since);
const lastSeq = async () => (await admin("/admin/log")).at(-1)?.seq ?? 0;
const requestsOf = (rows) => rows.filter((r) => r.kind === "mcp").map((r) => ({
  from: r.origin ? "webview" : "engine", path: r.path, http: r.http, rpc: r.rpc, auth: r.auth, token: r.token, session: r.session ?? null, status: r.status,
  ...(r.held ? { held: true } : {}), ...(r.tool ? { tool: r.tool, nonce: r.nonce, proof: r.proof } : {}),
}));
async function stopServer() {
  if (!server) return;
  await admin("/admin/stop", {}).catch(() => null);
  await waitFor(() => { try { process.kill(server.pid, 0); return false; } catch { return true; } }, 5_000, 100);
}

// ---- page side ------------------------------------------------------------------------
/** IPC tap for the secret-carrying commands (every secret hashed in the page) and a tap on the webview's own requests to the server. */
const TAP = `(() => {
  if (window.__g6 && window.__g6.installed) return 'present';
  const tap = window.__g6 = { installed: true, calls: [], net: [], t0: Date.now() };
  const original = window.fetch.bind(window);
  const hash = async (text) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  };
  const kept = new Set(['secure_store_set', 'secure_store_get', 'secure_store_remove', 'start_session', 'send_input', 'test_remote_mcp_origin']);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/([^/?#]+)/);
    const cmd = match ? decodeURIComponent(match[1]) : null;
    if (!cmd) {
      let parsed = null;
      try { parsed = new URL(url); } catch { parsed = null; }
      const row = { atMs: Date.now() - tap.t0, origin: parsed ? parsed.origin : null, path: parsed ? parsed.pathname : null, redirect: init && init.redirect || null };
      try { const body = JSON.parse(init && init.body); row.rpc = body && body.method || null; } catch { row.rpc = null; }
      tap.net.push(row);
      const t = Date.now();
      try {
        const response = await original(input, init);
        row.status = response.status; row.type = response.type; row.ms = Date.now() - t;
        return response;
      } catch (error) {
        row.error = String(error && error.message || error).slice(0, 160); row.ms = Date.now() - t;
        throw error;
      }
    }
    if (!kept.has(cmd)) return original(input, init);
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

const R = `
  const panel = document.querySelector('[aria-label="Connectors"]');
  const field = (label) => panel?.querySelector('input[aria-label="' + label + '"]') || null;
  const submit = () => [...(panel?.querySelectorAll('form.integration-form button[type=submit]') || [])].find((b) => /connect/i.test(b.textContent)) || null;
  const statusRows = () => [...(panel?.querySelectorAll('.integration-remote-status') || [])]
    .map((r) => ({ text: text(r.querySelector('span')), buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
  const statusButton = (label) => [...(panel?.querySelectorAll('.integration-remote-status button') || [])].find((b) => b.textContent.trim() === label) || null;
  const facts = () => {
    const block = panel?.querySelector('[aria-label="Remote MCP connection result"]');
    const remotes = connectors().filter((e) => e && e.kind === 'remote');
    const useInMuse = [...(panel?.querySelectorAll('li.integration-row') || [])].map((li) => {
      const box = [...li.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(l.textContent))?.querySelector('input');
      return box ? { checked: box.checked, disabled: box.disabled } : null;
    }).filter(Boolean);
    return {
      tokenFieldEmpty: (field('Remote MCP bearer token')?.value || '') === '',
      notice: [...(panel?.querySelectorAll('p.integration-notice') || [])].map((n) => text(n)).filter((t) => !/^Connected to /.test(t)),
      banners: banners(),
      connectedBlock: text(block?.querySelector('p')),
      tools: block ? [...block.querySelectorAll('select option')].map((o) => o.value) : [],
      callOutput: text(block?.querySelector('pre.local-mcp-output')),
      statusRows: statusRows(),
      useInMuse,
      registry: remotes.map((e) => ({ id: e.id, name: e.name, status: e.status, url: e.url, tools: (e.tools || []).map((t) => t.name), useInMuse: e.useInMuse === true })),
    };
  };
`;
const rpage = (body) => page(`${R} ${body}`);
const tapCalls = (app, since = 0) => app.ev(`window.__g6.calls.slice(${since})`);
const tapCount = (app) => app.ev("window.__g6.calls.length");
const netSince = (app, since) => app.ev(`window.__g6.net.slice(${since}).filter((r) => r.origin === ${J(ORIGIN)} || !String(r.origin).startsWith('tauri'))`);
const netCount = (app) => app.ev("window.__g6.net.length");

async function install(app) {
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(TAP);
  await openExtensions(app);
}

/** Fill the remote form and connect; timed from the click to the end of the busy state. */
async function connectThroughForm(app, { name, url, token }) {
  await openExtensions(app);
  const clicked = await app.ev(rpage(`
    setValue(field('Remote connector name'), ${J(name)});
    setValue(field('Public HTTPS connector URL'), ${J(url)});
    setValue(field('Remote MCP bearer token'), '');
    await pause(200);
    const b = submit();
    return { clicked: Boolean(b && !b.disabled) };
  `));
  if (!clicked.clicked) return { clicked: false };
  if (token) {
    await app.ev(rpage("field('Remote MCP bearer token').focus(); return true;"));
    await app.send("Input.insertText", { text: token });
  }
  const typed = await app.ev(rpage("return (field('Remote MCP bearer token')?.value || '').length;"));
  await app.ev(rpage("window.__g6.clickAt = Date.now(); submit().click(); return true;"));
  const settledMs = await waitFor(() => app.ev(rpage(`
    const b = submit();
    return b && !b.disabled && /^Connect and list tools$/.test(b.textContent.trim()) ? Date.now() - window.__g6.clickAt : null;
  `)), 75_000, 150);
  await sleep(300);
  return { clicked: true, tokenCharsTyped: typed, settledMs, ...(await app.ev(rpage("return facts();"))) };
}

async function statusAction(app, label, until, timeoutMs = 45_000) {
  await openExtensions(app);
  await app.ev(rpage("const f = field('Remote MCP bearer token'); if (f && f.value) setValue(f, ''); await pause(150); return true;"));
  const clicked = await app.ev(rpage(`const b = statusButton(${J(label)}); if (!b || b.disabled) return false; window.__g6.clickAt = Date.now(); b.click(); return true;`));
  if (!clicked) return { clicked: false, ...(await app.ev(rpage("return facts();"))) };
  const settledMs = await waitFor(() => app.ev(rpage(`return (${until}) ? Date.now() - window.__g6.clickAt : null;`)), timeoutMs, 150);
  await sleep(300);
  return { clicked: true, settledMs, ...(await app.ev(rpage("return facts();"))) };
}

async function callFromPanel(app, nonce) {
  await openExtensions(app);
  const clicked = await app.ev(rpage(`
    const block = panel.querySelector('[aria-label="Remote MCP connection result"]');
    const area = block?.querySelector('textarea');
    if (!area) return { clicked: false, reason: 'no connected result block' };
    setValue(area, ${J(J({ nonce }))});
    await pause(200);
    const b = [...block.querySelectorAll('button')].find((n) => /call/i.test(n.textContent));
    if (!b || b.disabled) return { clicked: false, reason: 'no enabled call button' };
    const label = b.textContent.trim();
    window.__g6.clickAt = Date.now();
    b.click();
    await pause(300);
    const allow = [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.textContent.trim() === 'Allow once');
    if (allow) { window.__g6.clickAt = Date.now(); allow.click(); }
    return { clicked: true, label, approvedOnce: Boolean(allow) };
  `));
  if (!clicked.clicked) return clicked;
  const settledMs = await waitFor(() => app.ev(rpage(`
    const busy = [...panel.querySelectorAll('button')].some((n) => n.textContent.trim() === 'Calling…');
    return busy ? null : Date.now() - window.__g6.clickAt;
  `)), 75_000, 150);
  await sleep(400);
  return { ...clicked, settledMs, ...(await app.ev(rpage("return facts();"))) };
}

// ---- disk scan ----------------------------------------------------------------------------
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
      for (const [label, encoding, needle] of needles) if (data.includes(needle)) out.hits.push({ file: relative(root, full), token: label, encoding });
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir, dir);
  return out;
}

const honestFailure = (x) => Boolean(x) && x.settledMs !== null && (x.notice.length > 0 || x.banners.length > 0) && x.connectedBlock === null
  && !x.statusRows.some((r) => /^Connected/.test(r.text));

// ---- run ----------------------------------------------------------------------------------
const record = {
  schema: "muse-desktop.macos-m3-02-remote-mcp.v1",
  ticket: "M3-02",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-02-remote-mcp.mjs on scripts/macos/test-instance.mjs, with the local server scripts/mcp-bearer-test-server.mjs (port in the proof's range)",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-02 (a real test server, an expired token, a network refusal and a disconnection; the UI status confirmed by an actual exchange) and docs/ROADMAP.md §M3-02 (bearer in the native credential store, here the macOS Keychain; Forget token; remote networking outside Windows)",
  isolation: null,
  endpoint: {
    choice: "The local bearer-protected server on 127.0.0.1, named to the test instance through MUSE_DESKTOP_TEST_REMOTE_MCP (its one test-mode allowance; every other URL keeps the public-HTTPS rule). Nothing leaves the machine.",
    notCovered: "TLS on macOS (WKWebView's network stack and the macOS trust store) is not exercised: no external endpoint in this proof.",
  },
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment): fresh data folder, its own WKWebView store, the pinned engine with MUSE_NO_AUTO_UPDATE=1, CDP through the test bridge. The relaunch reuses the same data folder and store.",
    "Tokens are dummies drawn by the harness. The server holds only the sha256 of the token it accepts and logs every request with the Authorization header as bearer:<sha256/12>; a request with the webview's Origin header is the app's, one without is the engine's.",
    "The page tap hashes every secret before keeping it (secure_store_set's value, secure_store_get's result, the Authorization header in start_session's MCP servers); the Keychain value is the bearer bound to its URL, {url, token} (remoteMcp.ts encodeStoredBearer), so its hash is compared with that envelope's and records the webview's own requests to the server (path, JSON-RPC method, status or error, time).",
    `The Keychain is read with security find-generic-password -s ${SERVICE} -a <this run's account>: presence only, never a value (no -w). The connector name is unique per run (proof-g6-<id>), so no other entry can be read, overwritten or removed.`,
    "The token is typed into the password field with CDP Input.insertText. Every Reconnect is clicked with the token field empty, so the bearer can only come from the Keychain.",
    "Fingerprint (size, mtime) of ~/.config/muse and ~/.local/share/muse/{plugins,skills} before and after.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
let storePath = null;
const launchApp = async () => {
  inst = await launch({ exe: EXE, port: PORT, data: DATA, env: { MUSE_DESKTOP_TEST_REMOTE_MCP: ORIGIN } });
  storePath = inst.store;
  await install(inst.app);
  return inst.app;
};
const v = (o) => Object.values(o).every((x) => x === true);

try {
  // ---- start ------------------------------------------------------------------------------
  const before = keychainHas();
  if (before.present) throw new Error("this run's Keychain account already exists: refusing");
  await startServer();
  let app = await launchApp();
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const origin = await app.ev("window.__TAURI_INTERNALS__.invoke('test_remote_mcp_origin')");
  const profile = await app.ev(rpage("return { remotes: connectors().filter((e) => e && e.kind === 'remote').length, posture: localStorage.getItem('muse-desktop.authorization-mode.v1') };"));
  record.phases.start = { connectorName: "proof-g6-<id>", keychainAccount: "remote-mcp-remote-proof-g6-<id>", keychainBefore: before, appLoopbackAllowance: origin, profile };
  record.phases.start.verdict = { allowanceIsServerOrigin: origin === ORIGIN, emptyRemoteRegistry: profile.remotes === 0, accountUnused: !before.present };

  // ---- refusals (no token) -----------------------------------------------------------------------
  const refusals = {};
  const refusalName = `${NAME}-refusal`;
  const probeRefusal = async (label, url, expectRequest) => {
    const n0 = await netCount(app);
    const s0 = await lastSeq().catch(() => null);
    const result = await connectThroughForm(app, { name: refusalName, url, token: "" });
    result.webviewRequests = await netSince(app, n0);
    result.serverSaw = s0 === null ? "server down" : requestsOf(await serverLog(s0));
    result.expectRequest = expectRequest;
    refusals[label] = result;
    return result;
  };
  await probeRefusal("privateAddress", "https://10.0.0.1/mcp", false);
  await probeRefusal("notMcpPath", `${ORIGIN}/elsewhere/mcp`, true);
  await probeRefusal("redirect", `${ORIGIN}/redirect`, true);
  await probeRefusal("heldStream", `${ORIGIN}/hold`, true);
  await stopServer();
  await probeRefusal("connectionRefused", URL_MCP, true);
  await startServer();
  const leftover = await app.ev(rpage("return connectors().filter((e) => e && e.kind === 'remote').map((e) => ({ name: e.name, status: e.status }));"));
  // A refused probe leaves an entry in error state: removed before the real connector is added.
  const removedRefusal = await app.ev(rpage(`
    const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(refusalName)}));
    const b = li && [...li.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove');
    if (b) { b.click(); await pause(800); }
    return { removed: Boolean(b), remotesAfter: connectors().filter((e) => e && e.kind === 'remote').length };
  `));
  record.phases.refusals = { scenarios: refusals, registryAfter: leftover, removedRefusal };
  const followed = (refusals.redirect.serverSaw || []).some((r) => r.path === "/mcp");
  record.phases.refusals.verdict = {
    privateRefusedBeforeAnyRequest: honestFailure(refusals.privateAddress) && refusals.privateAddress.webviewRequests.length === 0,
    notMcpPathHonest: honestFailure(refusals.notMcpPath) && refusals.notMcpPath.serverSaw.some((r) => r.path === "/elsewhere/mcp" && r.status === 404 && r.auth === "none"),
    redirectNotFollowed: honestFailure(refusals.redirect) && !followed && refusals.redirect.serverSaw.some((r) => r.path === "/redirect" && r.status === 307),
    heldStreamBounded: honestFailure(refusals.heldStream) && refusals.heldStream.settledMs < 40_000,
    connectionRefusedHonest: honestFailure(refusals.connectionRefused) && refusals.connectionRefused.settledMs < 10_000,
    noRefusalLeftConnected: leftover.every((e) => e.status !== "installed"),
  };

  // ---- add (token A) -----------------------------------------------------------------------------------
  await admin("/admin/accept", { sha256: sha256(tokenA) });
  {
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const connect = await connectThroughForm(app, { name: NAME, url: URL_MCP, token: tokenA });
    const requests = requestsOf(await serverLog(mark));
    const ipc = await tapCalls(app, tapMark);
    const keychain = keychainHas();
    const callMark = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const callRequests = requestsOf(await serverLog(callMark));
    const stored = ipc.find((c) => c.cmd === "secure_store_set");
    record.phases.add = { tokenA: { sha12: sha12(tokenA), storedSha12: storedOf(tokenA) }, connect, requests, ipc, keychain, call: { nonce, ...call, requests: callRequests } };
    record.phases.add.verdict = {
      connected: /^Connected/.test(connect.statusRows[0]?.text ?? "") && /^Connected to m3-02-bearer-test 1\.0\.0 · 1 tool\(s\)/.test(connect.connectedBlock ?? ""),
      toolListed: connect.tools.includes("echo_nonce"),
      serverGotTokenA: requests.length > 0 && requests.every((r) => r.auth === bearerOf(tokenA) && r.status < 300 && r.from === "webview"),
      storedUnderTestKey: stored?.args?.key === ACCOUNT && stored?.args?.secretSha12 === storedOf(tokenA) && stored?.ok === true,
      keychainEntry: keychain.present,
      authenticatedCall: callRequests.some((r) => r.rpc === "tools/call" && r.auth === bearerOf(tokenA) && r.status === 200 && r.nonce === nonce)
        && (call.callOutput ?? "").includes(`nonce=${nonce}`),
    };
  }

  // ---- relaunch -------------------------------------------------------------------------------------------
  {
    const closed = await inst.stop({ keepStore: true });
    const scanClosed = scan([DATA, storePath], [["A", tokenA]]);
    scanClosed.storeFolderScanned = existsSync(storePath);
    app = await launchApp();
    const afterRelaunch = await app.ev(rpage("return facts();"));
    const keychainAfterRelaunch = keychainHas();
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '') || (submit() && !submit().disabled && statusRows()[0] && !/^Connected/.test(statusRows()[0].text) && window.__g6.calls.some((c) => c.cmd === 'secure_store_get' && c.result !== undefined))");
    const requests = requestsOf(await serverLog(mark));
    const ipc = await tapCalls(app, tapMark);
    const read = ipc.find((c) => c.cmd === "secure_store_get");
    record.phases.relaunch = { closed: { quitBy: closed.quitBy, leftAfterQuit: closed.leftAfterQuit }, scanWithAppClosed: scanClosed, afterRelaunch, keychainAfterRelaunch, reconnect, requests, ipc };
    record.phases.relaunch.verdict = {
      closedCleanly: closed.quitBy === "window closed" && closed.leftAfterQuit.length === 0,
      relaunchedDisconnected: /^Disconnected/.test(afterRelaunch.statusRows[0]?.text ?? "") && afterRelaunch.tokenFieldEmpty,
      reconnectedWithoutTyping: reconnect.tokenFieldEmpty && /^Connected/.test(reconnect.statusRows[0]?.text ?? ""),
      bearerReadFromKeychain: keychainAfterRelaunch.present && read?.args?.key === ACCOUNT && read?.result?.sha12 === storedOf(tokenA),
      serverGotTokenA: requests.length > 0 && requests.every((r) => r.auth === bearerOf(tokenA) && r.status < 300),
      tokenNotInAppStorage: scanClosed.hits.length === 0 && scanClosed.files > 0 && scanClosed.storeFolderScanned,
    };
  }

  // ---- expire -------------------------------------------------------------------------------------------------
  {
    const before2 = await app.ev(rpage("return facts();"));
    const expired = await admin("/admin/expire", {});
    const mark = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    await sleep(10_000);
    const callRequests = requestsOf(await serverLog(mark));
    const quiet = await app.ev(rpage("return facts();"));
    const mark2 = await lastSeq();
    const tapMark = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", `submit() && !submit().disabled && window.__g6.calls.slice(${tapMark}).some((c) => c.cmd === 'secure_store_get')`);
    await sleep(3_000);
    const reconnectRequests = requestsOf(await serverLog(mark2));
    record.phases.expire = { serverExpired: expired, before: before2.statusRows, call: { nonce, ...call, requests: callRequests }, afterTenSeconds: quiet, reconnect: { ...reconnect, requests: reconnectRequests } };
    const expectedA = bearerOf(tokenA);
    record.phases.expire.verdict = {
      callFailedHonestly: quiet.notice.some((n) => /authentication was rejected or expired/.test(n)) && /^Disconnected/.test(quiet.statusRows[0]?.text ?? "")
        && quiet.connectedBlock === null && quiet.registry[0]?.status === "error",
      bounded: call.settledMs !== null && call.settledMs < 5_000,
      oneRehandshakeOnly: J(callRequests.map((r) => `${r.rpc}:${r.status}`)) === J(["tools/call:401", "initialize:401"]) && callRequests.every((r) => r.auth === expectedA && r.token === "expired"),
      noFakeConnected: !/^Connected/.test(quiet.statusRows[0]?.text ?? "") && quiet.useInMuse.every((u) => u.disabled),
      reconnectRefusedHonestly: reconnectRequests.length === 1 && reconnectRequests[0].rpc === "initialize" && reconnectRequests[0].status === 401
        && reconnectRequests[0].auth === expectedA && /^Disconnected/.test(reconnect.statusRows[0]?.text ?? "") && reconnect.notice.some((n) => /authentication was rejected or expired/.test(n)),
    };
  }

  // ---- renew (token B) -----------------------------------------------------------------------------------------
  await admin("/admin/accept", { sha256: sha256(tokenB) });
  {
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const connect = await connectThroughForm(app, { name: NAME, url: URL_MCP, token: tokenB });
    const requests = requestsOf(await serverLog(mark));
    const ipc = await tapCalls(app, tapMark);
    const disconnect = await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000);
    const mark2 = await lastSeq();
    const tapMark2 = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", `/^Connected/.test(statusRows()[0]?.text || '') || (submit() && !submit().disabled && window.__g6.calls.slice(${tapMark2}).some((c) => c.cmd === 'secure_store_get' && c.result !== undefined))`);
    const reconnectRequests = requestsOf(await serverLog(mark2));
    const read = (await tapCalls(app, tapMark2)).find((c) => c.cmd === "secure_store_get");
    const stored = ipc.find((c) => c.cmd === "secure_store_set");
    record.phases.renew = { tokenB: { sha12: sha12(tokenB), storedSha12: storedOf(tokenB) }, connect, requests, ipc, disconnect: disconnect.statusRows, reconnect: { ...reconnect, requests: reconnectRequests, read }, keychain: keychainHas() };
    record.phases.renew.verdict = {
      connected: /^Connected/.test(connect.statusRows[0]?.text ?? "") && connect.tools.includes("echo_nonce"),
      serverGotTokenB: requests.length > 0 && requests.every((r) => r.auth === bearerOf(tokenB) && r.status < 300),
      keychainNowHoldsB: stored?.args?.secretSha12 === storedOf(tokenB) && read?.result?.sha12 === storedOf(tokenB)
        && reconnectRequests.length > 0 && reconnectRequests.every((r) => r.auth === bearerOf(tokenB) && r.status < 300),
      oneEntry: record.phases.renew.keychain.present && connect.registry.length === 1,
    };
  }

  // ---- checks: stored bearer stays with its URL; an ended MCP session ------------------------------------------
  {
    const elsewhere = `${ORIGIN}/elsewhere/mcp`;
    const mark = await lastSeq();
    const otherUrl = await connectThroughForm(app, { name: NAME, url: elsewhere, token: "" });
    const otherRequests = requestsOf(await serverLog(mark));
    if (/^Connected/.test(otherUrl.statusRows[0]?.text ?? "")) await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000);
    await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '')");
    const restored = await app.ev(rpage("return facts();"));
    const dropped = await admin("/admin/drop-sessions", {});
    const mark2 = await lastSeq();
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const callRequests = requestsOf(await serverLog(mark2));
    record.phases.checks = { otherPath: { requests: otherRequests, statusRows: otherUrl.statusRows, notice: otherUrl.notice, restored: restored.registry }, sessionEnded: { dropped, nonce, statusRows: call.statusRows, callOutput: call.callOutput, requests: callRequests } };
    record.phases.checks.verdict = {
      storedBearerStaysWithItsUrl: otherRequests.some((r) => r.path === "/elsewhere/mcp") && otherRequests.every((r) => r.path !== "/elsewhere/mcp" || r.auth === "none"),
      registryKeptItsUrl: restored.registry[0]?.url === URL_MCP,
      sessionEndRecovered: /^Connected/.test(call.statusRows?.[0]?.text ?? "") && (call.callOutput ?? "").includes(`nonce=${nonce}`)
        && callRequests.filter((r) => r.rpc === "initialize").length === 1 && callRequests.every((r) => r.auth === bearerOf(tokenB)),
    };
  }

  // ---- down: the server goes away mid-session, then comes back ---------------------------------------------------
  {
    const before3 = await app.ev(rpage("return facts();"));
    await stopServer();
    const n0 = await netCount(app);
    const nonce = `n-${randomBytes(3).toString("hex")}`;
    const call = await callFromPanel(app, nonce);
    const webview = await netSince(app, n0);
    await startServer();
    await admin("/admin/accept", { sha256: sha256(tokenB) });
    const mark = await lastSeq();
    const reconnect = await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '')");
    const requests = requestsOf(await serverLog(mark));
    const nonce2 = `n-${randomBytes(3).toString("hex")}`;
    const mark2 = await lastSeq();
    const call2 = await callFromPanel(app, nonce2);
    const call2Requests = requestsOf(await serverLog(mark2));
    record.phases.down = { connectedBefore: /^Connected/.test(before3.statusRows[0]?.text ?? ""), call: { statusRows: call.statusRows, notice: call.notice, banners: call.banners, connectedBlock: call.connectedBlock, settledMs: call.settledMs, webview },
      reconnect: { settledMs: reconnect.settledMs, statusRows: reconnect.statusRows, requests }, callAfter: { nonce: nonce2, callOutput: call2.callOutput, requests: call2Requests } };
    record.phases.down.verdict = {
      disconnectionDetected: /^Disconnected/.test(call.statusRows[0]?.text ?? "") && call.connectedBlock === null && (call.notice.length > 0 || call.banners.length > 0)
        && webview.some((r) => r.rpc === "tools/call" && r.error),
      bounded: call.settledMs !== null && call.settledMs < 10_000,
      reconnectByExchange: /^Connected/.test(reconnect.statusRows[0]?.text ?? "") && ["initialize", "tools/list"].every((m) => requests.some((r) => r.rpc === m && r.status === 200 && r.auth === bearerOf(tokenB))),
      callAfterReconnect: (call2.callOutput ?? "").includes(`nonce=${nonce2}`) && call2Requests.some((r) => r.rpc === "tools/call" && r.status === 200),
    };
  }

  // ---- turn (one live turn) -----------------------------------------------------------------------------------------
  {
    await openExtensions(app);
    const opted = await app.ev(rpage(`
      const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(NAME)}));
      const box = li && [...li.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(l.textContent))?.querySelector('input');
      if (!box || box.disabled) return { ok: false };
      if (!box.checked) box.click();
      await pause(400);
      return { ok: true, checked: box.checked };
    `));
    if (!opted.ok) throw new Error("Use in Muse is not available on the connector");
    const mark = await lastSeq();
    const tapMark = await tapCount(app);
    const conv = await startConversationNoTurn(app, PROJECT);
    const startCall = (await tapCalls(app, tapMark)).filter((c) => c.cmd === "start_session").at(-1);
    const engineAtStart = await waitFor(async () => {
      const rows = requestsOf(await serverLog(mark)).filter((r) => r.from === "engine");
      return rows.some((r) => r.rpc === "tools/list") ? rows : null;
    }, 20_000, 500) ?? requestsOf(await serverLog(mark)).filter((r) => r.from === "engine");
    const nonce = `N302-${randomBytes(4).toString("hex").toUpperCase()}`;
    const prompt = `Call the echo_nonce tool of the connected MCP server with nonce "${nonce}", then reply with the tool's text output exactly, nothing else.`;
    await sendInConversation(app, conv.sid, prompt);
    record.liveTurns = 1;
    const turn = await waitTurn(app, conv.sid);
    const requests = requestsOf(await serverLog(mark));
    const engineCalls = requests.filter((r) => r.from === "engine");
    const answer = engineCalls.find((r) => r.tool === "echo_nonce" && r.nonce === nonce && r.status === 200);
    const reply = turn.entries.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
    const remote = (startCall?.args?.mcpServers ?? []).find((m) => m.transport === "streamableHttp");
    record.phases.turn = { useInMuse: opted, startSession: startCall?.args ?? null, firstMessageRefused: conv.firstMessageSends, engineAtStart, nonce, turn, engineRequests: engineCalls };
    record.phases.turn.verdict = {
      turnFinished: turn.finished,
      remoteInjectedWithBearer: remote?.url === URL_MCP && remote?.authorizationSha12 === sha12(tokenB),
      engineAuthenticated: engineCalls.length > 0 && engineCalls.every((r) => r.auth === bearerOf(tokenB)),
      modelCalledEchoNonce: Boolean(answer),
      replyHasServerAnswer: Boolean(answer) && reply.includes(answer.proof) && reply.includes(nonce),
    };
  }

  // ---- forget ----------------------------------------------------------------------------------------------------------
  {
    const keychainBefore = keychainHas();
    const tapMark = await tapCount(app);
    const forget = await statusAction(app, "Forget token", `window.__g6.calls.slice(${tapMark}).some((c) => c.cmd === 'secure_store_remove' && c.ok !== undefined)`, 10_000);
    const forgetIpc = await tapCalls(app, tapMark);
    const keychainAfter = keychainHas();
    const mark = await lastSeq();
    const tapMark2 = await tapCount(app);
    const reconnect = await statusAction(app, "Reconnect", `submit() && !submit().disabled && window.__g6.calls.slice(${tapMark2}).some((c) => c.cmd === 'secure_store_get' && c.result !== undefined)`);
    await sleep(1_500);
    const reconnectRequests = requestsOf(await serverLog(mark));
    const after = await app.ev(rpage("return facts();"));
    const read = (await tapCalls(app, tapMark2)).find((c) => c.cmd === "secure_store_get");
    record.phases.forget = { keychainBefore, forget: { statusRows: forget.statusRows, notice: forget.notice, ipc: forgetIpc }, keychainAfter, reconnect: { requests: reconnectRequests, read }, after: { statusRows: after.statusRows, notice: after.notice } };
    record.phases.forget.verdict = {
      entryGone: keychainBefore.present && !keychainAfter.present,
      removedThroughApp: forgetIpc.some((c) => c.cmd === "secure_store_remove" && c.args?.key === ACCOUNT && c.ok === true),
      forgetNotice: forget.notice.some((n) => /forgotten/i.test(n)),
      disconnected: /^Disconnected/.test(forget.statusRows[0]?.text ?? ""),
      reconnectSendsNoBearer: read?.result === null && reconnectRequests.length > 0 && reconnectRequests.every((r) => r.auth === "none"),
      reconnectSaysNoTokenStored: after.notice.some((n) => /no token/i.test(n)),
    };
  }

  // ---- cleanup (in app) -----------------------------------------------------------------------------------------------
  record.phases.cleanup = {
    remove: await app.ev(rpage(`
      const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(NAME)}));
      const b = li && [...li.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove');
      if (b) { b.click(); await pause(1000); }
      return { removed: Boolean(b), remotesAfter: connectors().filter((e) => e && e.kind === 'remote').length };
    `)),
  };
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop({ keepStore: true });
  await stopServer().catch(() => null);
}

// ---- cleanup (disk, Keychain) ---------------------------------------------------------------------------------------------
await sleep(1_500);
const keychainEnd = keychainHas();
const scanEnd = scan([BASE, storePath].filter(Boolean), [["A", tokenA], ["B", tokenB]]);
scanEnd.appOutputHits = (inst?.output ?? []).filter((line) => line.includes(tokenA) || line.includes(tokenB)).length;
if (storePath) rmSync(storePath, { recursive: true, force: true });
const canaryDir = join(BASE, "scan-canary");
const canary = `canary-${randomBytes(12).toString("base64url")}`;
mkdirSync(canaryDir, { recursive: true });
writeFileSync(join(canaryDir, "canary.bin"), Buffer.concat([randomBytes(64), Buffer.from(canary, "utf16le"), randomBytes(64)]));
const selfCheck = scan([canaryDir], [["canary", canary]]).hits.map((h) => h.encoding);
rmSync(canaryDir, { recursive: true, force: true });
record.phases.cleanup = { ...(record.phases.cleanup ?? {}), keychainEnd, scan: { ...scanEnd, folders: ["<proof>", "the instance's WKWebView store"] }, scanSelfCheck: selfCheck, storeDeleted: storePath ? !existsSync(storePath) : null };
record.phases.cleanup.verdict = {
  removedInApp: record.phases.cleanup.remove?.removed === true && record.phases.cleanup.remove?.remotesAfter === 0,
  noKeychainEntryLeft: !keychainEnd.present,
  tokensNeverOnDisk: scanEnd.files > 0 && scanEnd.hits.length === 0 && scanEnd.appOutputHits === 0 && J(selfCheck) === J(["utf16le"]),
};
record.leftoverProcesses = processesMentioning(BASE).concat(processesMentioning(`--port ${SERVER_PORT}`));
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;

const all = (phase) => (record.phases[phase]?.verdict ? v(record.phases[phase].verdict) : null);
record.verdicts = {
  "real test server, UI status by exchange (add)": all("add"),
  "Keychain: re-read after relaunch, token not in app storage": all("relaunch"),
  "expired token: honest, bounded, one re-handshake": all("expire"),
  "new token: connected, Keychain holds it": all("renew"),
  "network refusal (private address, refused connection, non-MCP, redirect, held stream)": all("refusals"),
  "disconnection: server down detected, Reconnect by exchange": all("down"),
  "stored bearer stays with its URL; ended MCP session recovered": all("checks"),
  "live turn: the engine calls echo_nonce with the bearer": all("turn"),
  "Forget token: Keychain entry gone, no bearer sent": all("forget"),
  "cleanup: no Keychain entry, no token on disk": all("cleanup"),
  "clean exit, no process left": Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0,
  "user engine settings untouched": record.userEngineConfig.unchanged,
};
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "TLS is not exercised on macOS: the endpoint is loopback HTTP through the test-mode allowance (Windows proved TLS against a public endpoint on 27/09 and the invalid-TLS refusals on 05/10).",
  "The Keychain is the login keychain of this Mac, shared with the user (ADR 0003): the proof touches only its own account, checked absent before and after. A Keychain access prompt never appeared; whether the installed, signed app prompts is a release-build question.",
  "The engine's session store is shared with the user (ADR 0003): the proof conversation stays there.",
);
const out = redact(record, secrets);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
