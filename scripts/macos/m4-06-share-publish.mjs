#!/usr/bin/env node
/**
 * M4-06 native macOS proof: share by URL and revoke, in the real app against
 * the real reference server. The model is scripts/cdp-m4-06-publish-proof.mjs
 * (Windows, 30/09/2026) and the share rows of the isolated click-effect audit
 * (cdp-m0-13-click-effect.mjs, 06/10/2026), replayed on the isolated macOS
 * test instance (scripts/macos/test-instance.mjs).
 *
 * The reference server is scripts/share-server.mjs, unchanged, started with
 * node --import scripts/macos/m4-06-loopback.mjs so it binds 127.0.0.1 only
 * (it listens on 0.0.0.0 by design); the bind is read back with lsof.
 *
 * Steps, in one run:
 *   turn       a project conversation and one live turn (a snapshot needs
 *              messages): the model replies a nonce.
 *   snapshot   Settings > Share conversations > Markdown: one bundle.
 *   refusals   no URL before a real 201: the service unreachable (a port of the
 *              range nothing listens on), then the real service with a wrong
 *              token (403). Each: an alert, no URL shown, nothing published.
 *   publish    the right token, 24 h: the webview's PUT answered 201, then the
 *              URL shown, equal to the server's; a second client (curl, no
 *              token) reads the bundle with the nonce; expiry about 24 h.
 *   revoke     Revoke: DELETE 204, the UI says Revoked; curl without and with
 *              the token: 404 for both.
 *   forget     Forget clears the configured service.
 *   cleanup    app closed, server stopped (port free), no process left,
 *              ~/.config/muse fingerprint unchanged.
 *
 *   node scripts/macos/m4-06-share-publish.mjs [--exe ~/muse-proofs/app/df57377/muse-desktop]
 *     [--port 9491] [--server-port 9493] [--dead-port 9494] [--base $TMPDIR/muse-proofs-g9/m4-06]
 *     [--out docs/evidence/2026-10-13-macos-closure/m4-06-share-publish-macos.json]
 *
 * One live turn. Nothing leaves the machine.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import {
  J, compareStamps, page, platform, processesMentioning, redactorFor, sleep, userEngineStamp, waitFor, writeRecord,
} from "./m3-g6-common.mjs";

const COMMIT = "df57377";
const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", COMMIT, "muse-desktop")));
const PORT = Number(argValue("--port", "9491"));
const SERVER_PORT = Number(argValue("--server-port", "9493"));
const DEAD_PORT = Number(argValue("--dead-port", "9494"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g9", "m4-06"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-06-share-publish-macos.json");
const DATA = join(BASE, "data");
const PROJECT = join(BASE, "project");
const SERVER_SCRIPT = fileURLToPath(new URL("../share-server.mjs", import.meta.url));
const LOOPBACK = fileURLToPath(new URL("./m4-06-loopback.mjs", import.meta.url));
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const TOKEN = `g9-share-${randomBytes(16).toString("hex")}`;
const WRONG = `g9-wrong-${randomBytes(16).toString("hex")}`;
const NONCE = `SHARE-G9-${randomBytes(3).toString("hex").toUpperCase()}`;
const redact = redactorFor(BASE);

mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, "README.md"), "M4-06 macOS proof project: nothing to change here.\n");

// ---- the reference server ---------------------------------------------------------------------
let server = null;
async function startServer() {
  const outFile = join(BASE, "share-server-out.txt");
  const fd = openSync(outFile, "w");
  const child = spawn(process.execPath, ["--import", LOOPBACK, SERVER_SCRIPT, "--port", String(SERVER_PORT), "--state", join(BASE, "share-state.json")], {
    detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, SHARE_TOKEN: TOKEN },
  });
  child.unref();
  closeSync(fd);
  const up = await waitFor(async () => (await fetch(`${ORIGIN}/health`).catch(() => null))?.ok ?? false, 10_000, 200);
  if (!up) throw new Error(`the share server did not start: ${readFileSync(outFile, "utf8").slice(0, 300)}`);
  server = { pid: child.pid, banner: readFileSync(outFile, "utf8").trim().split("\n")[0] };
  return server;
}
function listeners(port) {
  try { return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)); }
  catch { return []; }
}
async function stopServer() {
  if (!server) return null;
  try { process.kill(server.pid, "SIGINT"); } catch { /* gone */ }
  const gone = await waitFor(() => { try { process.kill(server.pid, 0); return false; } catch { return true; } }, 5_000, 100);
  if (!gone) { try { process.kill(server.pid, "SIGKILL"); } catch { /* gone */ } }
  return { stoppedBy: gone ? "SIGINT" : "SIGKILL", listenersAfter: listeners(SERVER_PORT) };
}
/** A second client: curl, a separate program, no cookie, no token unless given. */
function curl(url, token = null) {
  const args = ["-s", "-o", "-", "-w", "\n%{http_code}", "--max-time", "10"];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  const out = execFileSync("curl", [...args, url], { encoding: "utf8" });
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
}

// ---- page side ---------------------------------------------------------------------------------
/** A tap on the webview's requests to the share service (method, path, status or error, and when the response came). */
const TAP = `(() => {
  if (window.__g9s && window.__g9s.installed) return 'present';
  const tap = window.__g9s = { installed: true, net: [], t0: Date.now() };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!/^https?:\\/\\/127\\.0\\.0\\.1:/.test(url)) return original(input, init);
    const parsed = new URL(url);
    const headers = init && init.headers ? Object.keys(init.headers) : [];
    const row = { atMs: Date.now() - tap.t0, port: Number(parsed.port), path: parsed.pathname, method: (init && init.method) || 'GET', authorization: headers.some((h) => /^authorization$/i.test(h)) };
    tap.net.push(row);
    try {
      const response = await original(input, init);
      row.status = response.status; row.answeredAtMs = Date.now() - tap.t0;
      return response;
    } catch (error) {
      row.error = String(error && error.message || error).slice(0, 200); row.answeredAtMs = Date.now() - tap.t0;
      throw error;
    }
  };
  return 'installed';
})()`;
const S = `
  const panel = q('.share-panel')[0];
  const rows = () => q('.share-bundles li.share-bundle', panel);
  const alerts = () => q('[role="alert"]', panel).map(text);
  const state = () => ({
    configured: text(panel.querySelector('.share-endpoint-ok')),
    stored: localStorage.getItem('muse-desktop.share-endpoint.v1'),
    bundles: rows().map((li) => ({ title: text(li.querySelector('.share-bundle-head strong')), meta: text(li.querySelector('.share-bundle-head .share-bundle-meta')),
      url: text(li.querySelector('.share-url')), notes: [...li.querySelectorAll('p')].map(text), buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) })),
    alerts: alerts(),
  });
  const clickIn = (label, root) => { const b = [...root.querySelectorAll('button')].find((n) => n.textContent.trim() === label && !n.disabled); if (b) b.click(); return Boolean(b); };
`;
const spage = (body) => page(`${S} ${body}`);

async function openSettings(app) {
  const ok = await app.ev(page(`
    document.querySelector('.primary-nav button[aria-label="Settings"], .sidebar-footer button[aria-label="Settings"]')?.click();
    for (let i = 0; i < 40 && !q('.share-panel')[0]; i++) await pause(100);
    return Boolean(q('.share-panel')[0]);
  `));
  if (!ok) throw new Error("the share panel was not reached");
}
const shareState = (app) => app.ev(spage("return state();"));
async function setEndpoint(app, url, token) {
  return app.ev(spage(`
    setValue(panel.querySelector('input[aria-label="Share service URL"]'), ${J(url)});
    setValue(panel.querySelector('input[aria-label="Share service token"]'), ${J(token)});
    await pause(200);
    clickIn('Save service', panel);
    await pause(400);
    return state();
  `));
}
/** Publish on the first bundle; the moment the URL appears is taken in the page. */
async function publish(app, expectUrl) {
  const n0 = await app.ev("window.__g9s.net.length");
  const result = await app.ev(spage(`
    const row = rows()[0];
    if (!row) return { clicked: false, reason: 'no bundle' };
    const duration = row.querySelector('select')?.value ?? null;
    const t0 = Date.now() - window.__g9s.t0;
    if (!clickIn('Publish', row)) return { clicked: false, reason: 'no Publish button' };
    let urlAtMs = null;
    for (let i = 0; i < 120; i++) {
      if (row.querySelector('.share-url') && urlAtMs === null) urlAtMs = Date.now() - window.__g9s.t0;
      if (${J(expectUrl)} ? urlAtMs !== null : !q('button', row).some((b) => b.textContent.trim() === 'Publishing…') && i > 2) break;
      await pause(100);
    }
    await pause(300);
    const { stored, ...shown } = state();
    return { clicked: true, durationHours: Number(duration), clickedAtMs: t0, urlAtMs, ...shown };
  `));
  result.requests = await app.ev(`window.__g9s.net.slice(${n0})`);
  return result;
}

// ---- run ---------------------------------------------------------------------------------------
const record = {
  schema: "muse-desktop.macos-m4-06-share-publish.v1",
  ticket: "M4-06",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform().replace("08b291d", COMMIT),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m4-06-share-publish.mjs on scripts/macos/test-instance.mjs, with the reference server scripts/share-server.mjs (unchanged) bound to 127.0.0.1 by scripts/macos/m4-06-loopback.mjs (G9 ports 9490-9499)",
  criteria: "docs/ROADMAP.md §M4-06 (Windows ◐, 30/09/2026, docs/evidence/2026-09-27-m4-closure/m4-06-publish-proof.json): endpoint configured, snapshot, publish with a bounded duration, the URL shown only after the server's real 201, a second client reads it without any token, Revoke, then 404 for every client; honest error copy (403 token, service unreachable). Remaining by design: a real LAN/VPS host and a second device.",
  isolation: null,
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment): fresh data folder, its own WKWebView store, the pinned engine with MUSE_NO_AUTO_UPDATE=1, CDP through the test bridge.",
    "The reference server runs as the user would run it (SHARE_TOKEN, --port, --state), its listen moved to 127.0.0.1 by a preload; lsof reads the bind back. The publish token and the wrong token are drawn here and never recorded.",
    "A page tap on window.fetch records the webview's requests to the service (method, path, whether an Authorization header left, status or error, answer time); the page records when the URL appears, so 'URL after the 201' is an order of measured times.",
    "The second client is curl (a separate program, no cookie, no token); the revoked link is read without and with the token.",
    "Fingerprint (size, mtime) of ~/.config/muse and ~/.local/share/muse/{plugins,skills} before and after.",
  ],
  steps: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
const v = (o) => Object.values(o).every((x) => x === true);

try {
  if (listeners(SERVER_PORT).length || listeners(DEAD_PORT).length) throw new Error("a port of the proof is already taken: refusing");
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  const app = inst.app;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;

  // ---- turn -----------------------------------------------------------------------------------
  const ready = await newProjectConversation(app, PROJECT);
  if (ready !== "ready") throw new Error(`no conversation: ${ready}`);
  const sid = await sendFirstMessage(app, `Reply with exactly ${NONCE} and nothing else.`);
  record.liveTurns = 1;
  const replied = await waitFor(async () => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(NONCE)), 180_000, 1_000);
  await waitFor(() => app.ev(`document.querySelector('li.session-item[data-session-id="${sid}"] .dot')?.getAttribute('data-running') === 'false'`), 30_000, 500);
  record.steps.turn = { replied: Boolean(replied), entries: (await transcript(app, sid)).map((e) => ({ role: e.role, chars: String(e.text ?? "").length })) };
  await app.ev(TAP);

  // ---- snapshot ----------------------------------------------------------------------------------
  await openSettings(app);
  const before = await shareState(app);
  const snap = await app.ev(spage(`
    const n0 = rows().length;
    clickIn('Markdown', q('.share-snapshot', panel)[0]);
    for (let i = 0; i < 30 && rows().length === n0; i++) await pause(100);
    return { before: n0, after: rows().length, said: text(q('.share-snapshot [role="status"]', panel)[0]) };
  `));
  const afterSnap = await shareState(app);
  record.steps.snapshot = { endpointBefore: before.configured, ...snap, bundle: afterSnap.bundles[0] ?? null };
  record.steps.snapshot.verdict = {
    noServiceAtStart: before.configured === null && before.stored === null,
    oneBundle: snap.after === snap.before + 1,
    notPublishedYet: afterSnap.bundles[0]?.url === null,
  };

  // ---- refusals: no URL before a real 201 ----------------------------------------------------------
  const unreachableSet = await setEndpoint(app, `http://127.0.0.1:${DEAD_PORT}`, TOKEN);
  const unreachable = await publish(app, false);
  await startServer();
  const bind = listeners(SERVER_PORT);
  const wrongSet = await setEndpoint(app, ORIGIN, WRONG);
  const wrong = await publish(app, false);
  const idFromPut = (wrong.requests.find((r) => r.method === "PUT")?.path ?? "").split("/").pop();
  const readAfterWrong = idFromPut ? curl(`${ORIGIN}/muse-share/${idFromPut}`) : null;
  record.steps.server = { banner: server.banner, listening: bind };
  record.steps.refusals = {
    unreachable: { configured: unreachableSet.configured, ...unreachable },
    wrongToken: { configured: wrongSet.configured, ...wrong, secondClientAfter: readAfterWrong && { status: readAfterWrong.status } },
  };
  record.steps.refusals.verdict = {
    serverOnLoopbackOnly: bind.length > 0 && bind.every((a) => a.startsWith("127.0.0.1:")),
    unreachableHonest: unreachable.clicked && unreachable.urlAtMs === null && unreachable.bundles[0]?.url === null
      && unreachable.alerts.some((a) => /did not answer/i.test(a)) && unreachable.requests.some((r) => r.method === "PUT" && r.error),
    wrongTokenHonest: wrong.clicked && wrong.urlAtMs === null && wrong.bundles[0]?.url === null
      && wrong.alerts.some((a) => /refused the token \(403\)/.test(a)) && wrong.requests.some((r) => r.method === "PUT" && r.status === 403 && r.authorization),
    nothingPublished: readAfterWrong?.status === 404,
  };

  // ---- publish -------------------------------------------------------------------------------------
  const rightSet = await setEndpoint(app, ORIGIN, TOKEN);
  const published = await publish(app, true);
  const put = published.requests.find((r) => r.method === "PUT" && r.status === 201) ?? null;
  const url = published.bundles[0]?.url ?? null;
  const read = url ? curl(url) : null;
  let body = null;
  try { body = read ? JSON.parse(read.body) : null; } catch { body = null; }
  const expiresInHours = body?.expiresAt ? (body.expiresAt - Date.now()) / 3_600_000 : null;
  record.steps.publish = {
    configured: rightSet.configured,
    storedEndpointHasToken: typeof rightSet.stored === "string" && rightSet.stored.includes(TOKEN),
    durationHours: published.durationHours, clickedAtMs: published.clickedAtMs, urlAtMs: published.urlAtMs, put,
    url: url?.replace(ORIGIN, "<server>"), alerts: published.alerts, buttons: published.bundles[0]?.buttons,
    secondClient: read && { client: "curl, no token", status: read.status, carriesNonce: read.body.includes(NONCE), format: body?.bundle?.format ?? null,
      title: body?.bundle?.title ?? null, bodyChars: body?.bundle?.body?.length ?? null, redacted: body?.bundle?.redacted ?? null, expiresInHours: expiresInHours && Math.round(expiresInHours * 100) / 100 },
  };
  record.steps.publish.verdict = {
    configured: /^Configured: http:\/\/127\.0\.0\.1:\d+ \(token set\)$/.test(rightSet.configured ?? ""),
    putAnswered201: Boolean(put) && put.authorization && put.path.startsWith("/muse-share/share-"),
    urlShownAfterThe201: Boolean(put) && published.urlAtMs !== null && published.urlAtMs >= put.answeredAtMs,
    urlIsTheServers: Boolean(url) && url === `${ORIGIN}${put?.path}`,
    secondClientReadsWithoutToken: read?.status === 200 && read.body.includes(NONCE),
    boundedDuration: published.durationHours === 24 && expiresInHours !== null && expiresInHours > 23.9 && expiresInHours <= 24,
  };

  // ---- revoke --------------------------------------------------------------------------------------
  const n0 = await app.ev("window.__g9s.net.length");
  const revoked = await app.ev(spage(`
    const row = rows()[0];
    if (!clickIn('Revoke', row)) return { clicked: false };
    for (let i = 0; i < 40 && !/Revoked/.test(text(row)); i++) await pause(100);
    await pause(200);
    return { clicked: true, ...state() };
  `));
  revoked.requests = await app.ev(`window.__g9s.net.slice(${n0})`);
  const afterNoToken = url ? curl(url) : null;
  const afterWithToken = url ? curl(url, TOKEN) : null;
  record.steps.revoke = {
    clicked: revoked.clicked, notes: revoked.bundles?.[0]?.notes, urlStillShown: revoked.bundles?.[0]?.url ?? null, buttons: revoked.bundles?.[0]?.buttons, alerts: revoked.alerts, requests: revoked.requests,
    secondClientAfter: { withoutToken: afterNoToken?.status ?? null, withToken: afterWithToken?.status ?? null },
  };
  record.steps.revoke.verdict = {
    deleteAnswered204: revoked.requests.some((r) => r.method === "DELETE" && r.status === 204 && r.authorization),
    uiSaysRevoked: (revoked.bundles?.[0]?.notes ?? []).some((n) => /^Revoked/.test(n)) && revoked.bundles?.[0]?.url === null,
    noRepublishOffered: !(revoked.bundles?.[0]?.buttons ?? []).includes("Publish"),
    secondClient404: afterNoToken?.status === 404,
    evenWithToken404: afterWithToken?.status === 404,
  };

  // ---- forget --------------------------------------------------------------------------------------
  const forgot = await app.ev(spage(`
    const clicked = clickIn('Forget', panel);
    await pause(400);
    return { clicked, ...state() };
  `));
  record.steps.forget = { clicked: forgot.clicked, configured: forgot.configured, stored: forgot.stored };
  record.steps.forget.verdict = { cleared: forgot.clicked && forgot.configured === null && JSON.parse(forgot.stored ?? "null") === null };
  record.consoleErrors = app.errors.slice(0, 12);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
  record.serverStop = await stopServer().catch((e) => ({ error: String(e.message ?? e) }));
}

await sleep(1_000);
record.leftoverProcesses = processesMentioning(BASE).concat(processesMentioning(SERVER_SCRIPT));
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;

const all = (step) => (record.steps[step]?.verdict ? v(record.steps[step].verdict) : null);
record.verdicts = {
  "live turn: a conversation with messages": record.steps.turn?.replied === true,
  "snapshot: one local bundle, not published": all("snapshot"),
  "no URL before a real 201 (service unreachable, wrong token 403)": all("refusals"),
  "publish: 201, then the server's URL shown; a second client reads it without token; 24 h expiry": all("publish"),
  "revoke: 204, UI says Revoked, 404 for every client": all("revoke"),
  "forget clears the service": all("forget"),
  "clean exit, server stopped, no process left": Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd
    && record.serverStop?.listenersAfter?.length === 0 && record.leftoverProcesses.length === 0,
  "user engine settings untouched": record.userEngineConfig.unchanged,
};
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "Loopback only (rule of this proof): the service runs on this Mac at 127.0.0.1. A real LAN/VPS host and a second device (Étienne's phone) stay to be done, as on Windows.",
  "The publish runs from WKWebView in the debug executable, which has no app bundle: whether App Transport Security lets the installed, bundled app publish over plain HTTP to a LAN address or a named host is not exercised here.",
  "The engine's session store is shared with the user (ADR 0003): the proof conversation stays there.",
);
const out = redact(record, [TOKEN, WRONG]);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
