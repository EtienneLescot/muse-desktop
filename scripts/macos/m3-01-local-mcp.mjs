#!/usr/bin/env node
/**
 * M3-01 native macOS proof: connect a local stdio MCP server.
 *
 * Plan acceptance (docs/plans/2026-09-15-agent-implementation-plan.md §M3-01):
 * a fixture server exposes then runs a tool, restarts, changes its list and
 * fails; the call is observed in a Muse session. The Windows ☑ (27/09) rests
 * on the handshake and tools/list through the app's Rust client; this proof
 * covers that and the rest of the plan line, on one isolated instance
 * (scripts/macos/test-instance.mjs) and the pinned engine:
 *
 *   probe     the Local MCP server form (Probe): initialize ->
 *             notifications/initialized -> tools/list, read on the panel and
 *             in the server's own log (Content-Length frames from the app).
 *   call      a one-shot tools/call from the panel, through the posture's
 *             one-time approval; the answer carries an HMAC only that server
 *             process can compute.
 *   persist   Save connector, Start server (one persistent process), the
 *             catalogue changed on disk -> notifications/tools/list_changed ->
 *             the registry lists the new tool, same process, no click.
 *   fail      g6_crash: the process exits without answering -> an honest
 *             error, the row back to "Start server", no process left; a
 *             non-MCP command probed -> refused, nothing registered.
 *   restart   Start server again: a new process, the changed list.
 *   stop      Stop server: the process gone.
 *   session   Use in Muse on; a new conversation in the proof project: the
 *             start carries the stdio server; one live turn asks the model to
 *             call g6_echo; the call is read in the server log (process spawned
 *             by the engine) and the reply quotes the proof.
 *   cleanup   Remove; the app closed by its window; no fixture process left.
 *
 *   node scripts/macos/m3-01-local-mcp.mjs [--exe <muse-desktop>] [--port 9461]
 *     [--base $TMPDIR/muse-proofs-g6/m3-01] [--out docs/evidence/2026-10-13-macos-closure/m3-01-local-mcp.json]
 *
 * One live turn.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, J, compareStamps, installTrace, ipcCalls, openExtensions, page, pickDefaultFolder, platform,
  processesMentioning, redactorFor, sendInConversation, sleep, startConversationNoTurn, userEngineStamp, waitFor, waitTurn, writeRecord,
} from "./m3-g6-common.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9461"));
const ID = Date.now().toString(36);
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-01")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-01-local-mcp.json");
const FX = join(BASE, "fx");
const STATE = join(FX, "state");
const PROJECT = join(BASE, "project");
const SERVER = join(FX, "server.mjs");
const NAME = `g6 local ${ID}`;
const COMMAND = `node ${SERVER} --state ${STATE}`;
const redact = redactorFor(BASE);

mkdirSync(STATE, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, "README.md"), "M3-01 macOS proof project: nothing to change here.\n");
// The fixture runs from the proof folder, never from the repository (under ~/Documents, TCC).
copyFileSync(fileURLToPath(new URL("./m3-01-mcp-fixture-server.mjs", import.meta.url)), SERVER);
// A program that is not an MCP server: prints a line and exits.
writeFileSync(join(FX, "not-mcp.mjs"), "process.stdout.write('hello, not an MCP server\\n');\n");

const serverLog = () => {
  try { return readFileSync(join(STATE, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const keyOf = (pid) => { try { return Buffer.from(readFileSync(join(STATE, "keys", String(pid)), "utf8").trim(), "hex"); } catch { return null; } };
const proofOf = (pid, nonce) => { const key = keyOf(pid); return key ? createHmac("sha256", key).update(nonce).digest("hex").slice(0, 10) : null; };
/** ps state of a pid: null when gone, "Z" for a zombie (exited, not reaped by its parent). */
const stateOf = (pid) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() || null; } catch { return null; } };
const alive = (pid) => { const s = stateOf(pid); return s !== null && !s.startsWith("Z"); };
const zombie = (pid) => (stateOf(pid) ?? "").startsWith("Z");
const logSince = (n) => serverLog().slice(n).map((e) => ({ pid: e.pid, parent: e.parent, event: e.event, method: e.method ?? undefined, tool: e.tool ?? undefined, framing: e.framing ?? undefined, nonce: e.nonce ?? undefined, proof: e.proof ?? undefined }));

const record = {
  schema: "muse-desktop.macos-m3-01-local-mcp.v1",
  ticket: "M3-01",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-01-local-mcp.mjs on scripts/macos/test-instance.mjs; fixture scripts/macos/m3-01-mcp-fixture-server.mjs copied into the proof folder",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-01 (a fixture server exposes then runs a tool, restarts, changes its list and fails; the call is observed in a Muse session) and docs/ROADMAP.md §M3-01 (stdio handshake, Start/Stop server, Refresh tools, hot reload on tools/list_changed, Use in Muse injection, posture-bound authorization)",
  isolation: null,
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment, test-instance.mjs): fresh data folder, its own WKWebView store, the pinned engine with MUSE_NO_AUTO_UPDATE=1, CDP through the test bridge.",
    "Every action goes through the Extensions page (form fields set, buttons clicked); the folder dialogs are answered by the IPC trace. Posture: the fresh profile's default, Ask for approval.",
    "The fixture logs every request with its pid and its parent's command: muse-desktop for the app's probe and persistent process, the engine for the session's own process. A tool answer carries an HMAC under a key only that process holds, recomputed here.",
    "Fingerprint (size, mtime) of ~/.config/muse and ~/.local/share/muse/{plugins,skills} before and after.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
try {
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  const { app } = inst;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await installTrace(app);
  record.phases.setup = { defaultFolder: await pickDefaultFolder(app, PROJECT) };
  await openExtensions(app);

  // ---- probe -------------------------------------------------------------------
  let mark = serverLog().length;
  const probe = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    setValue(P.querySelector('input[aria-label="Local MCP server name"]'), ${J(NAME)});
    setValue(P.querySelector('input[aria-label="Local MCP command"]'), ${J(COMMAND)});
    await pause(300);
    const t0 = Date.now();
    P.querySelector('button[type=submit]').click();
    for (let i = 0; i < 100 && !/Connected to/.test(P.innerText); i++) await pause(100);
    return { ms: Date.now() - t0, notice: text(P.querySelector('.integration-notice')), tools: [...P.querySelectorAll('select option')].map((o) => o.value), banners: banners() };
  `));
  const probeLog = logSince(mark);
  record.phases.probe = { ...probe, serverLog: probeLog };
  record.verdicts.probeHandshake = /^Connected to g6-fixture 1\.0\.0 · 3 tool\(s\)/.test(probe.notice ?? "")
    && J(probeLog.filter((e) => e.event !== "start").map((e) => e.method)) === J(["initialize", "notifications/initialized", "tools/list"])
    && probeLog.every((e) => e.parent === "muse-desktop");

  // ---- one-shot call through the posture's approval --------------------------------
  mark = serverLog().length;
  const nonce1 = `n1-${randomBytes(3).toString("hex")}`;
  const call1 = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    setValue(P.querySelector('select'), 'g6_echo');
    setValue(P.querySelector('textarea'), ${J(J({ nonce: nonce1 }))});
    await pause(200);
    const b = [...P.querySelectorAll('button')].find((n) => /call/i.test(n.innerText));
    const label = b?.innerText.trim();
    b?.click();
    await pause(300);
    const dialog = text(document.querySelector('[aria-label="Connector call authorization"]'));
    const allow = [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.innerText.trim() === 'Allow once');
    allow?.click();
    for (let i = 0; i < 60 && !P.querySelector('pre.local-mcp-output'); i++) await pause(100);
    return { label, dialog, approved: Boolean(allow), output: P.querySelector('pre.local-mcp-output')?.innerText ?? null };
  `));
  const call1Log = logSince(mark);
  const call1Pid = call1Log.find((e) => e.event === "call")?.pid;
  record.phases.call = { nonce: nonce1, ...call1, serverLog: call1Log };
  record.verdicts.panelCallThroughApproval = call1.label === "Review and call" && /Ask for approval/.test(call1.dialog ?? "") && call1.approved
    && (call1.output ?? "").includes(`nonce=${nonce1} proof=${proofOf(call1Pid, nonce1)}`);

  // ---- persistent process + hot reload ---------------------------------------------
  const saved = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    button('Save connector', P)?.click();
    await pause(500);
    const e = connectors().find((c) => c.name === ${J(NAME)});
    return e ? { id: e.id, kind: e.kind, status: e.status, tools: e.tools.map((t) => t.name), serverVersion: e.serverVersion ?? null, commandStored: e.command === ${J(COMMAND)} } : null;
  `));
  mark = serverLog().length;
  const started = await app.ev(page(`
    const li = connectorRow(${J(NAME)});
    button('Start server', li)?.click();
    for (let i = 0; i < 80 && !/Persistent server running/.test(connectorRow(${J(NAME)})?.innerText || ''); i++) await pause(100);
    const row = connectorRow(${J(NAME)});
    return { feedback: text(row?.querySelector('.integration-refresh-feedback')), buttons: [...row.querySelectorAll('button')].map((b) => b.innerText.trim()) };
  `));
  const persistentPid = logSince(mark).find((e) => e.event === "start")?.pid ?? null;
  writeFileSync(join(STATE, "tools-v2"), "the catalogue changed\n");
  const changedAt = Date.now();
  const reloaded = await waitFor(() => app.ev(page(`
    const e = connectors().find((c) => c.name === ${J(NAME)});
    return e && e.tools.some((t) => t.name === 'g6_added') ? { tools: e.tools.map((t) => t.name), row: text(connectorRow(${J(NAME)})?.querySelector('small.muted')) } : null;
  `)), 20_000, 250);
  const reloadMs = Date.now() - changedAt;
  const reloadLog = logSince(mark).filter((e) => e.pid === persistentPid);
  // A call through the persistent process (the probe block now routes to it).
  const nonce2 = `n2-${randomBytes(3).toString("hex")}`;
  const call2 = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    setValue(P.querySelector('select'), 'g6_echo');
    setValue(P.querySelector('textarea'), ${J(J({ nonce: nonce2 }))});
    await pause(200);
    [...P.querySelectorAll('button')].find((n) => /call/i.test(n.innerText))?.click();
    await pause(300);
    [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.innerText.trim() === 'Allow once')?.click();
    for (let i = 0; i < 60 && !(P.querySelector('pre.local-mcp-output')?.innerText || '').includes(${J(nonce2)}); i++) await pause(100);
    return { output: P.querySelector('pre.local-mcp-output')?.innerText ?? null };
  `));
  record.phases.persist = { saved, started, persistentPid: persistentPid ? "recorded" : null, persistentAlive: persistentPid ? alive(persistentPid) : false,
    reload: { ms: reloadMs, ...reloaded }, reloadLog: reloadLog.map(({ pid, ...rest }) => rest), call2: { nonce: nonce2, ...call2 },
    ipc: (await ipcCalls(app)).filter((c) => /^mcp_local_(start|poll|call_persistent)$/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, changed: c.cmd === "mcp_local_poll" ? c.result !== "null" : undefined })).filter((c, i, all) => c.cmd !== "mcp_local_poll" || c.changed || i === all.length - 1) };
  record.verdicts.savedAndStarted = saved?.status === "installed" && saved.commandStored && J(saved.tools) === J(["g6_echo", "g6_slow", "g6_crash"])
    && /^Persistent server running · 3 tools/.test(started.feedback ?? "") && started.buttons.includes("Stop server") && Boolean(persistentPid) && alive(persistentPid);
  record.verdicts.hotReloadOnListChanged = Boolean(reloaded) && reloaded.tools.includes("g6_added") && reloadLog.some((e) => e.event === "list_changed-sent")
    && reloadLog.filter((e) => e.method === "tools/list").length >= 2 && reloadLog.filter((e) => e.event === "start").length <= 1 && alive(persistentPid);
  record.verdicts.callThroughPersistentProcess = (call2.output ?? "").includes(`nonce=${nonce2} proof=${proofOf(persistentPid, nonce2)} pid=${persistentPid}`);

  // ---- failure -----------------------------------------------------------------------
  const crash = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    setValue(P.querySelector('select'), 'g6_crash');
    setValue(P.querySelector('textarea'), '{}');
    await pause(200);
    const t0 = Date.now();
    [...P.querySelectorAll('button')].find((n) => /call/i.test(n.innerText))?.click();
    await pause(300);
    [...document.querySelectorAll('[aria-label="Connector call authorization"] button')].find((n) => n.innerText.trim() === 'Allow once')?.click();
    for (let i = 0; i < 100 && !banners().some((b) => /MCP/.test(b)); i++) await pause(100);
    await pause(500);
    const row = connectorRow(${J(NAME)});
    return { ms: Date.now() - t0, banners: banners(), buttons: [...row.querySelectorAll('button')].map((b) => b.innerText.trim()), registryStatus: connectors().find((c) => c.name === ${J(NAME)})?.status ?? null };
  `));
  await sleep(500);
  const crashGone = !alive(persistentPid);
  mark = serverLog().length;
  const notMcp = await app.ev(page(`
    const P = document.querySelector('[aria-label="Local MCP server"]');
    setValue(P.querySelector('input[aria-label="Local MCP server name"]'), 'g6 not mcp');
    setValue(P.querySelector('input[aria-label="Local MCP command"]'), ${J(`node ${join(FX, "not-mcp.mjs")}`)});
    await pause(300);
    const before = banners().length;
    P.querySelector('button[type=submit]').click();
    for (let i = 0; i < 150 && /Probing/.test(P.querySelector('button[type=submit]').innerText); i++) await pause(100);
    await pause(300);
    return { banners: banners(), saveOffered: Boolean(button('Save connector', P)), registered: connectors().some((c) => c.name === 'g6 not mcp') };
  `));
  record.phases.fail = { crash, crashedProcessGone: crashGone, notMcp };
  record.verdicts.serverFailureHonest = crash.banners.some((b) => /local MCP/i.test(b) && /closed stdout before a response/.test(b))
    && crash.buttons.includes("Start server") && crashGone && crash.registryStatus === "installed";
  record.verdicts.nonMcpRefused = notMcp.banners.some((b) => /local MCP probe failed|could not be completed/i.test(b)) && !notMcp.saveOffered && !notMcp.registered;

  // ---- restart, refresh, stop ----------------------------------------------------------
  mark = serverLog().length;
  const restarted = await app.ev(page(`
    button('Start server', connectorRow(${J(NAME)}))?.click();
    // The row's last feedback still reads the first start's line: wait for the button to turn into Stop server.
    for (let i = 0; i < 100 && !button('Stop server', connectorRow(${J(NAME)})); i++) await pause(100);
    const row = connectorRow(${J(NAME)});
    return { feedback: text(row?.querySelector('.integration-refresh-feedback')), buttons: [...row.querySelectorAll('button')].map((b) => b.innerText.trim()) };
  `));
  const restartPid = logSince(mark).find((e) => e.event === "start")?.pid ?? null;
  const refreshed = await app.ev(page(`
    for (let i = 0; i < 50 && !button('Refresh tools', connectorRow(${J(NAME)})); i++) await pause(100);
    button('Refresh tools', connectorRow(${J(NAME)}))?.click();
    for (let i = 0; i < 80 && !/Tools refreshed/.test(connectorRow(${J(NAME)})?.innerText || ''); i++) await pause(100);
    return { feedback: text(connectorRow(${J(NAME)})?.querySelector('.integration-refresh-feedback')), tools: connectors().find((c) => c.name === ${J(NAME)})?.tools.map((t) => t.name) };
  `));
  const stopped = await app.ev(page(`
    button('Stop server', connectorRow(${J(NAME)}))?.click();
    for (let i = 0; i < 80 && !/stopped/.test(connectorRow(${J(NAME)})?.innerText || ''); i++) await pause(100);
    const row = connectorRow(${J(NAME)});
    return { feedback: text(row?.querySelector('.integration-refresh-feedback')), buttons: [...row.querySelectorAll('button')].map((b) => b.innerText.trim()) };
  `));
  await sleep(500);
  const appPids = [...new Set(logSince(0).filter((e) => e.event === "start" && e.parent === "muse-desktop").map((e) => e.pid))];
  const pidsAfterStop = appPids.filter(alive);
  record.phases.restart = { restarted, newProcess: Boolean(restartPid) && restartPid !== persistentPid, refreshed, stopped, appMcpProcessesAlive: pidsAfterStop.length,
    appMcpZombies: { count: appPids.filter(zombie).length, of: appPids.length, note: "processes the app started and killed without reaping (ps state Z): exited, held as zombies until the app exits" } };
  record.phases.restart.restartedProcessGoneAfterStop = Boolean(restartPid) && !alive(restartPid);
  record.verdicts.restartedWithChangedList = /^Persistent server running · 4 tools/.test(restarted.feedback ?? "") && restarted.buttons.includes("Stop server")
    && Boolean(restartPid) && restartPid !== persistentPid && /^Tools refreshed · 4 discovered/.test(refreshed.feedback ?? "");
  record.verdicts.stopEndsProcess = /Persistent server stopped/.test(stopped.feedback ?? "") && stopped.buttons.includes("Start server") && pidsAfterStop.length === 0 && record.phases.restart.restartedProcessGoneAfterStop;

  // ---- the call observed in a Muse session (one live turn) ----------------------------------
  const opted = await app.ev(page(`
    const li = connectorRow(${J(NAME)});
    const box = li && [...li.querySelectorAll('label.integration-toggle')].find((l) => /Use in Muse/.test(l.textContent))?.querySelector('input');
    if (!box || box.disabled) return { ok: false };
    if (!box.checked) box.click();
    await pause(400);
    return { ok: true, stored: connectors().find((c) => c.name === ${J(NAME)})?.useInMuse === true };
  `));
  mark = serverLog().length;
  const conv = await startConversationNoTurn(app, PROJECT);
  const stdio = (conv.args?.mcpServers ?? []).filter((s) => s.transport === "stdio");
  const engineStart = await waitFor(() => { const rows = logSince(mark); return rows.some((e) => e.method === "tools/list") ? rows : null; }, 20_000, 500) ?? logSince(mark);
  const nonce3 = `N301-${randomBytes(4).toString("hex").toUpperCase()}`;
  const prompt = `Call the g6_echo tool of the connected MCP server with nonce "${nonce3}", then reply with the tool's text output exactly, nothing else.`;
  await sendInConversation(app, conv.sid, prompt);
  record.liveTurns = 1;
  const turn = await waitTurn(app, conv.sid);
  const sessionLog = logSince(mark);
  const engineCall = sessionLog.find((e) => e.event === "call" && e.tool === "g6_echo" && e.nonce === nonce3);
  const reply = turn.entries.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
  const sessionServerPid = engineCall?.pid ?? null;
  record.phases.session = {
    useInMuse: opted,
    startSession: { authorizationMode: conv.args?.authorizationMode ?? null, approvalMode: conv.approvalMode, firstMessageRefused: conv.firstMessageSends,
      stdioServers: stdio.map((s) => ({ command: s.command, args: s.args, mode: s.mode })) },
    serverAtSessionStart: engineStart.map(({ pid, ...rest }) => rest),
    nonce: nonce3,
    turn: { finished: turn.finished, ms: turn.ms, approvals: turn.approvals, entries: turn.entries },
    serverLogDuringTurn: sessionLog.map(({ pid, ...rest }) => rest),
  };
  record.verdicts.injectedIntoSessionStart = opted.ok && opted.stored && stdio.some((s) => s.command === "node" && J(s.args) === J([SERVER, "--state", STATE]) && s.mode === "optional");
  record.verdicts.engineConnectedItsOwnProcess = engineStart.some((e) => e.method === "initialize") && engineStart.some((e) => e.method === "tools/list")
    && engineStart.every((e) => e.parent !== "muse-desktop");
  record.verdicts.callObservedInMuseSession = turn.finished && Boolean(engineCall) && engineCall.parent !== "muse-desktop"
    && reply.includes(nonce3) && reply.includes(proofOf(sessionServerPid, nonce3));
  record.verdicts.postureAskedBeforeTheCall = turn.approvals.length > 0 && turn.approvals.every((a) => /once|turn/i.test(a.clicked));
  record.phases.session.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\/(muse-desktop|muse-bin)/, "$1").slice(0, 160));

  // ---- cleanup ----------------------------------------------------------------------------------
  const removed = await app.ev(page(`
    nav('Extensions'); await pause(500);
    button('Remove', connectorRow(${J(NAME)}))?.click();
    await pause(800);
    return { gone: !connectors().some((c) => c.name === ${J(NAME)}) };
  `));
  record.phases.cleanup = { removed };
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 800);
} finally {
  if (inst) record.stop = await inst.stop();
}
await sleep(1_000);
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;
record.verdicts.cleanExit = Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0;
record.verdicts.userEngineConfigUntouched = record.userEngineConfig.unchanged;
record.passed = !failure && Object.values(record.verdicts).every((v) => v === true);
record.limits.push(
  "The engine's own session store (~/.local/share/muse/sessions) is shared with the user (ADR 0003): the proof conversation stays there.",
  "The persistent process is the app's; the session's process is the engine's own (Use in Muse injects the command, the host initialises it). The catalogue the host shows the model is read from the turn, not from a host listing.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, userEngineConfig: out.userEngineConfig.unchanged, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
