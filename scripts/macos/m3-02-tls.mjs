#!/usr/bin/env node
/**
 * M3-02 native macOS proof, TLS complement of m3-02-remote-mcp.mjs (G6, which
 * ran on loopback HTTP through the test-mode allowance and left TLS out). The
 * model is the TLS part of scripts/cdp-m1-05-m3-02-terminal-mcp.mjs (Windows,
 * 05/10/2026): DEEPWIKI, tlsExpired, tlsSelfSigned, honestFailure.
 *
 * The instance runs WITHOUT MUSE_DESKTOP_TEST_REMOTE_MCP: the app's own
 * public-HTTPS rule applies, and every request goes through WKWebView's
 * network stack and the macOS trust store. No token is ever typed.
 *
 * Phases, in order, in one run (one connector, proof-g9-<id>, single-remote
 * plan: the refusals run first, on an empty registry):
 *   control   Node's own TLS client against the two badssl hosts: the
 *             certificate really is expired / self-signed today (read-only,
 *             no MCP request).
 *   tls       Extensions > Remote MCP form, no token: https://expired.badssl.com/mcp
 *             and https://self-signed.badssl.com/mcp. Each must end in a
 *             bounded, honest failure (notice, no Connected state, no tools),
 *             with the webview's request to that host failing in the network
 *             layer (no HTTP status). WebKit says "Load failed" for a CORS
 *             refusal too, so a no-cors GET from the same webview tells them
 *             apart: it rejects only when the connection itself fails (TLS),
 *             and resolves (opaque) on DeepWiki, the valid-certificate control.
 *   real      https://mcp.deepwiki.com/mcp: connected by a real exchange
 *             (initialize, notifications/initialized, tools/list), tools
 *             listed; a real tools/call (read_wiki_structure on a public repo)
 *             from the panel; Disconnect (only Disconnected and Reconnect left);
 *             Reconnect by exchange; Remove.
 *   cleanup   the registry empty, no Keychain entry under this run's account
 *             (checked with security find-generic-password, never -w), the app
 *             closed, the store deleted, ~/.config/muse fingerprint unchanged.
 *
 *   node scripts/macos/m3-02-tls.mjs [--exe ~/muse-proofs/app/df57377/muse-desktop] [--port 9490]
 *     [--base $TMPDIR/muse-proofs-g9/m3-02-tls] [--out docs/evidence/2026-10-13-macos-closure/m3-02-tls-macos.json]
 *
 * No live turn. Outbound traffic: mcp.deepwiki.com (read-only, no token) and
 * the two badssl.com hosts; nothing else.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { INSTALL_IPC_TRACE, argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  J, compareStamps, openExtensions, page, platform, processesMentioning, redactorFor, sleep, userEngineStamp, waitFor, writeRecord,
} from "./m3-g6-common.mjs";

const COMMIT = "df57377";
const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", COMMIT, "muse-desktop")));
const PORT = Number(argValue("--port", "9490"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g9", "m3-02-tls"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-02-tls-macos.json");
const DATA = join(BASE, "data");
const SERVICE = "com.muse.desktop.mcp";
const NAME = `proof-g9-${ID}`;
const ACCOUNT = `remote-mcp-remote-${NAME}`;
const DEEPWIKI = "https://mcp.deepwiki.com/mcp";
const TLS_CASES = [
  ["tlsExpired", "https://expired.badssl.com/mcp"],
  ["tlsSelfSigned", "https://self-signed.badssl.com/mcp"],
];
const ALLOWED_HOSTS = new Set(["mcp.deepwiki.com", "expired.badssl.com", "self-signed.badssl.com"]);
const redact = redactorFor(BASE);

mkdirSync(DATA, { recursive: true });

function keychainHas(account = ACCOUNT) {
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
  return { present: r.status === 0, exit: r.status };
}

/** Node's TLS client, default trust store: what the certificate is today (handshake only, no request). */
function tlsControl(host) {
  return new Promise((done) => {
    const t0 = Date.now();
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      done({ host, authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null, ms: Date.now() - t0 });
      socket.end();
    });
    socket.once("error", (error) => done({ host, authorized: false, error: error.code ?? String(error.message), ms: Date.now() - t0 }));
    socket.once("timeout", () => { socket.destroy(); done({ host, authorized: false, error: "timeout", ms: Date.now() - t0 }); });
  });
}

// ---- page side ---------------------------------------------------------------------------
/** A tap on the webview's own outbound requests (host, JSON-RPC method, status or network error) and on the Keychain IPC. */
const TAP = `(() => {
  if (window.__g9 && window.__g9.installed) return 'present';
  const tap = window.__g9 = { installed: true, calls: [], net: [], t0: Date.now() };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/([^/?#]+)/);
    const cmd = match ? decodeURIComponent(match[1]) : null;
    if (!cmd) {
      let parsed = null;
      try { parsed = new URL(url); } catch { parsed = null; }
      const headers = init && init.headers ? Object.keys(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers) : [];
      const row = { atMs: Date.now() - tap.t0, host: parsed ? parsed.host : null, path: parsed ? parsed.pathname : null, method: init && init.method || 'GET',
        authorizationHeader: headers.some((h) => /^authorization$/i.test(h)) };
      try { const body = JSON.parse(init && init.body); row.rpc = body && body.method || null; if (body && body.params && body.params.name) row.tool = body.params.name; } catch { row.rpc = null; }
      tap.net.push(row);
      const t = Date.now();
      try {
        const response = await original(input, init);
        row.status = response.status; row.ms = Date.now() - t;
        return response;
      } catch (error) {
        row.error = String(error && error.message || error).slice(0, 300); row.ms = Date.now() - t;
        throw error;
      }
    }
    if (/^secure_store_/.test(cmd)) {
      let args = null;
      try { args = typeof (init && init.body) === 'string' ? JSON.parse(init.body) : null; } catch { args = null; }
      tap.calls.push({ atMs: Date.now() - tap.t0, cmd, key: args && args.key || null });
    }
    return original(input, init);
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
    return {
      notice: [...(panel?.querySelectorAll('p.integration-notice') || [])].map((n) => text(n)).filter((t) => !/^Connected to /.test(t)),
      banners: banners(),
      connectedBlock: text(block?.querySelector('p')),
      tools: block ? [...block.querySelectorAll('select option')].map((o) => o.value) : [],
      callOutput: text(block?.querySelector('pre.local-mcp-output')),
      statusRows: statusRows(),
      registry: remotes.map((e) => ({ name: e.name, status: e.status, url: e.url, tools: (e.tools || []).map((t) => t.name), useInMuse: e.useInMuse === true })),
    };
  };
`;
const rpage = (body) => page(`${R} ${body}`);
const netCount = (app) => app.ev("window.__g9.net.length");
const netSince = (app, since) => app.ev(`window.__g9.net.slice(${since}).filter((r) => r.host && !/localhost$/.test(r.host))`);

async function connectThroughForm(app, { name, url }) {
  await openExtensions(app);
  const n0 = await netCount(app);
  const clicked = await app.ev(rpage(`
    setValue(field('Remote connector name'), ${J(name)});
    setValue(field('Public HTTPS connector URL'), ${J(url)});
    setValue(field('Remote MCP bearer token'), '');
    await pause(200);
    const b = submit();
    if (!b || b.disabled) return { clicked: false };
    window.__g9.clickAt = Date.now();
    b.click();
    return { clicked: true };
  `));
  if (!clicked.clicked) return { url, clicked: false };
  const settledMs = await waitFor(() => app.ev(rpage(`
    const b = submit();
    return b && !b.disabled && /^Connect and list tools$/.test(b.textContent.trim()) ? Date.now() - window.__g9.clickAt : null;
  `)), 75_000, 150);
  await sleep(300);
  return { url, clicked: true, settledMs, ...(await app.ev(rpage("return facts();"))), webviewRequests: await netSince(app, n0) };
}

async function statusAction(app, label, until, timeoutMs = 45_000) {
  await openExtensions(app);
  const n0 = await netCount(app);
  const clicked = await app.ev(rpage(`const b = statusButton(${J(label)}); if (!b || b.disabled) return false; window.__g9.clickAt = Date.now(); b.click(); return true;`));
  if (!clicked) return { clicked: false, ...(await app.ev(rpage("return facts();"))) };
  const settledMs = await waitFor(() => app.ev(rpage(`return (${until}) ? Date.now() - window.__g9.clickAt : null;`)), timeoutMs, 150);
  await sleep(300);
  return { clicked: true, settledMs, ...(await app.ev(rpage("return facts();"))), webviewRequests: await netSince(app, n0) };
}

async function callFromPanel(app, tool, args) {
  await openExtensions(app);
  const n0 = await netCount(app);
  const clicked = await app.ev(rpage(`
    const block = panel.querySelector('[aria-label="Remote MCP connection result"]');
    const select = block?.querySelector('select');
    const area = block?.querySelector('textarea');
    if (!select || !area) return { clicked: false, reason: 'no connected result block' };
    if ([...select.options].some((o) => o.value === ${J(tool)})) setValue(select, ${J(tool)});
    await pause(200);
    setValue(area, ${J(J(args))});
    await pause(200);
    const b = [...block.querySelectorAll('button')].find((n) => /call/i.test(n.textContent));
    if (!b || b.disabled) return { clicked: false, reason: 'no enabled call button' };
    const label = b.textContent.trim();
    window.__g9.clickAt = Date.now();
    b.click();
    await pause(300);
    const allow = [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.textContent.trim() === 'Allow once');
    if (allow) { window.__g9.clickAt = Date.now(); allow.click(); }
    return { clicked: true, label, selected: select.value, approvedOnce: Boolean(allow) };
  `));
  if (!clicked.clicked) return clicked;
  const settledMs = await waitFor(() => app.ev(rpage(`
    const busy = [...panel.querySelectorAll('button')].some((n) => n.textContent.trim() === 'Calling…');
    return busy ? null : Date.now() - window.__g9.clickAt;
  `)), 75_000, 150);
  await sleep(400);
  const facts = await app.ev(rpage("return facts();"));
  return { ...clicked, settledMs, ...facts, callOutput: facts.callOutput ? facts.callOutput.slice(0, 600) : null, callOutputChars: facts.callOutput ? facts.callOutput.length : 0, webviewRequests: await netSince(app, n0) };
}

const honestFailure = (x) => Boolean(x) && x.clicked && x.settledMs !== null && x.settledMs <= 31_000 && (x.notice.length > 0 || x.banners.length > 0)
  && x.connectedBlock === null && x.tools.length === 0 && !x.statusRows.some((r) => /^Connected/.test(r.text))
  && !x.registry.some((e) => e.status === "installed" && e.url === x.url);
/** The webview reached the host and the network layer refused it: an error, never an HTTP status (no 404/CORS answer read). */
const stoppedByTls = (x) => x.webviewRequests.length > 0 && x.webviewRequests.every((r) => r.host === new URL(x.url).host && r.error && r.status === undefined);
const okRpc = (rows, rpc) => rows.some((r) => r.host === "mcp.deepwiki.com" && r.rpc === rpc && r.status >= 200 && r.status < 300);

// ---- run ---------------------------------------------------------------------------------------
const record = {
  schema: "muse-desktop.macos-m3-02-tls.v1",
  ticket: "M3-02",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform().replace("08b291d", COMMIT),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-02-tls.mjs on scripts/macos/test-instance.mjs (G9 ports 9490-9499)",
  criteria: "docs/ROADMAP.md §M3-02: the TLS half proved on Windows (27/09 real public endpoint mcp.deepwiki.com; 05/10 invalid TLS refused honestly, docs/evidence/2026-10-05-roadmap-closure/m1-05-m3-02-terminal-mcp.json), here on macOS. The loopback criteria (expired token, Keychain, network refusals, disconnection with the server down, live turn) are in m3-02-remote-mcp.json (G6).",
  complements: "docs/evidence/2026-10-13-macos-closure/m3-02-remote-mcp.json",
  isolation: null,
  endpoint: {
    choice: "Public HTTPS endpoints only, with the app's own URL rule: the instance runs without MUSE_DESKTOP_TEST_REMOTE_MCP, so no test-mode allowance is in force.",
    outbound: [...ALLOWED_HOSTS],
    token: "none: no bearer typed, none stored, none sent (the tap records whether an Authorization header left).",
  },
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment): fresh data folder, its own WKWebView store, the pinned engine with MUSE_NO_AUTO_UPDATE=1, CDP through the test bridge.",
    "A page tap on window.fetch records each outbound request of the webview: host, path, JSON-RPC method, HTTP status or network error, time; and the secure_store_* IPC calls (key only).",
    "A Node TLS handshake (no HTTP request) against each badssl host first, as a control that the certificate is invalid today.",
    `The Keychain is read with security find-generic-password -s ${SERVICE} -a <this run's account>: presence only, never -w. The connector name is unique per run (proof-g9-<id>).`,
    "Fingerprint (size, mtime) of ~/.config/muse and ~/.local/share/muse/{plugins,skills} before and after.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
const v = (o) => Object.values(o).every((x) => x === true);

try {
  const keychainBefore = keychainHas();
  if (keychainBefore.present) throw new Error("this run's Keychain account already exists: refusing");

  // ---- control ------------------------------------------------------------------------------
  const control = {};
  for (const [label, url] of TLS_CASES) control[label] = await tlsControl(new URL(url).host);
  control.deepwiki = await tlsControl("mcp.deepwiki.com");
  record.phases.control = control;
  record.phases.control.verdict = {
    expiredIsInvalid: !control.tlsExpired.authorized && /EXPIRED/i.test(control.tlsExpired.error ?? ""),
    selfSignedIsInvalid: !control.tlsSelfSigned.authorized && /SELF_SIGNED|self.signed/i.test(control.tlsSelfSigned.error ?? ""),
    deepwikiIsValid: control.deepwiki.authorized === true,
  };

  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  const app = inst.app;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(TAP);
  await openExtensions(app);
  const allowance = await app.ev("window.__TAURI_INTERNALS__.invoke('test_remote_mcp_origin')").catch((e) => `error: ${String(e.message ?? e).slice(0, 120)}`);
  const profile = await app.ev(rpage("return { remotes: connectors().filter((e) => e && e.kind === 'remote').length, posture: localStorage.getItem('muse-desktop.authorization-mode.v1') };"));
  record.phases.start = { connectorName: "proof-g9-<id>", keychainAccount: "remote-mcp-remote-proof-g9-<id>", keychainBefore, testRemoteMcpAllowance: allowance, profile };
  record.phases.start.verdict = { noLoopbackAllowance: allowance === null, emptyRemoteRegistry: profile.remotes === 0, accountUnused: !keychainBefore.present };

  // ---- tls -----------------------------------------------------------------------------------
  const tls = {};
  for (const [label, url] of TLS_CASES) {
    tls[label] = await connectThroughForm(app, { name: NAME, url });
    tls[label].keychain = keychainHas();
    process.stdout.write(`- ${label}: ${tls[label].settledMs} ms ${J(tls[label].notice)} ${J(tls[label].webviewRequests.map((r) => r.error ?? r.status))}\n`);
  }
  // WebKit names every network failure "Load failed", a CORS refusal included.
  // The discriminator, in the same WKWebView: a no-cors GET needs no CORS
  // answer, so it resolves (opaque) once TLS is accepted and rejects only when
  // the connection itself fails. DeepWiki is the valid-certificate control.
  const noCors = await app.ev(`(async () => {
    const probe = async (url) => { const t = Date.now(); try { const r = await fetch(url, { mode: 'no-cors', method: 'GET', cache: 'no-store' }); return { url, resolved: true, type: r.type, ms: Date.now() - t }; }
      catch (e) { return { url, resolved: false, error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t }; } };
    return { tlsExpired: await probe(${J(TLS_CASES[0][1])}), tlsSelfSigned: await probe(${J(TLS_CASES[1][1])}), validControl: await probe(${J(DEEPWIKI)}) };
  })()`);
  tls.webkitNoCorsDiscriminator = noCors;
  tls.consoleErrorsSoFar = app.errors.slice(0, 10);
  record.phases.tls = tls;
  record.phases.tls.verdict = {
    expiredHonest: honestFailure(tls.tlsExpired),
    expiredStoppedInNetworkLayer: stoppedByTls(tls.tlsExpired),
    selfSignedHonest: honestFailure(tls.tlsSelfSigned),
    selfSignedStoppedInNetworkLayer: stoppedByTls(tls.tlsSelfSigned),
    webkitRefusesBothCertificates: noCors.tlsExpired.resolved === false && noCors.tlsSelfSigned.resolved === false,
    webkitAcceptsValidControl: noCors.validControl.resolved === true && noCors.validControl.type === "opaque",
    noBearerSent: [...tls.tlsExpired.webviewRequests, ...tls.tlsSelfSigned.webviewRequests].every((r) => !r.authorizationHeader),
    noKeychainEntry: !tls.tlsExpired.keychain.present && !tls.tlsSelfSigned.keychain.present,
  };

  // ---- real -----------------------------------------------------------------------------------
  {
    const connect = await connectThroughForm(app, { name: NAME, url: DEEPWIKI });
    const call = await callFromPanel(app, "read_wiki_structure", { repoName: "modelcontextprotocol/servers" });
    const disconnect = await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000);
    const reconnect = await statusAction(app, "Reconnect", "/^Connected/.test(statusRows()[0]?.text || '')", 60_000);
    const keychain = keychainHas();
    const secureStoreCalls = await app.ev("window.__g9.calls");
    const allRequests = await netSince(app, 0);
    record.phases.real = { connect, call, disconnect, reconnect, keychain, secureStoreCalls };
    record.phases.real.verdict = {
      connectedByExchange: /^Connected to /.test(connect.connectedBlock ?? "") && /^Connected/.test(connect.statusRows[0]?.text ?? "")
        && ["initialize", "notifications/initialized", "tools/list"].every((m) => okRpc(connect.webviewRequests, m)),
      toolsListed: connect.tools.length > 0 && connect.registry.some((e) => e.url === DEEPWIKI && e.status === "installed" && e.tools.length === connect.tools.length),
      realToolsCall: call.clicked === true && call.callOutputChars > 0 && call.webviewRequests.some((r) => r.rpc === "tools/call" && r.tool === "read_wiki_structure" && r.status === 200),
      disconnectLeavesOnlyDisconnected: disconnect.clicked && /^Disconnected/.test(disconnect.statusRows[0]?.text ?? "") && disconnect.connectedBlock === null
        && disconnect.statusRows[0].buttons.includes("Reconnect") && !disconnect.statusRows[0].buttons.includes("Disconnect"),
      reconnectByExchange: reconnect.clicked && /^Connected/.test(reconnect.statusRows[0]?.text ?? "") && ["initialize", "tools/list"].every((m) => okRpc(reconnect.webviewRequests, m)),
      noBearerSent: allRequests.every((r) => !r.authorizationHeader),
      onlyAllowedHosts: allRequests.every((r) => ALLOWED_HOSTS.has(r.host)),
      noKeychainEntry: !keychain.present,
    };
  }

  // ---- cleanup (in app) -----------------------------------------------------------------------
  await statusAction(app, "Disconnect", "/^Disconnected/.test(statusRows()[0]?.text || '')", 10_000).catch(() => null);
  record.phases.cleanup = {
    remove: await app.ev(rpage(`
      const li = [...panel.querySelectorAll('li.integration-row')].find((n) => text(n.querySelector('strong'))?.startsWith(${J(NAME)}));
      const b = li && [...li.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove');
      if (b) { b.click(); await pause(1000); }
      return { removed: Boolean(b), remotesAfter: connectors().filter((e) => e && e.kind === 'remote').length };
    `)),
  };
  record.webviewHosts = [...new Set((await netSince(app, 0)).map((r) => r.host))];
  record.consoleErrors = app.errors.slice(0, 12);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
}

await sleep(1_000);
const keychainEnd = keychainHas();
record.phases.cleanup = { ...(record.phases.cleanup ?? {}), keychainEnd };
record.phases.cleanup.verdict = {
  removedInApp: record.phases.cleanup.remove?.removed === true && record.phases.cleanup.remove?.remotesAfter === 0,
  noKeychainEntryLeft: !keychainEnd.present,
};
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;

const all = (phase) => (record.phases[phase]?.verdict ? v(record.phases[phase].verdict) : null);
record.verdicts = {
  "control: badssl certificates invalid today, DeepWiki's valid (Node TLS)": all("control"),
  "no test-mode allowance: the app's public-HTTPS rule in force": all("start"),
  "invalid TLS (expired, self-signed): honest, bounded failure, stopped by TLS": all("tls"),
  "real public HTTPS endpoint: connected by exchange, tools listed, real tools/call, Disconnect, Reconnect": all("real"),
  "cleanup: connector removed, no Keychain entry": all("cleanup"),
  "clean exit, no process left": Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0,
  "user engine settings untouched": record.userEngineConfig.unchanged,
};
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "The server cut (disconnection with the server gone mid-session) is not repeated against DeepWiki: the bridge has no Network.setBlockedURLs, and the cut is proved on loopback in m3-02-remote-mcp.json (phase down). Here Disconnect is the user's own button.",
  "The panel exercises the webview's transport (WKWebView, macOS trust store). The engine's own connection to a public HTTPS server (Use in Muse, a live turn) is not repeated here; G6 proved the engine path on loopback.",
  "No token: the bearer and Keychain path over TLS is not exercised (DeepWiki is tokenless); the Keychain path is in m3-02-remote-mcp.json.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
