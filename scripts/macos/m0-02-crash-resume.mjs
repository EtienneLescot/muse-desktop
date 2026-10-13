#!/usr/bin/env node
/**
 * M0-02 on macOS: resume a conversation after the engine closes or crashes,
 * with the draft and the threads intact.
 *
 * Three instances in a row on the SAME data folder (launch() derives the
 * WKWebView store from it; the store is kept between them):
 *
 *   1. App crash. A project conversation with a first turn (a token to
 *      remember), then a long turn in flight and a draft typed in the
 *      composer without sending. SIGKILL of the app process. Checked: the
 *      engine host does not outlive the app.
 *   2. Relaunch on the same data. Projects, conversations, transcript and
 *      draft as before the kill (bytes and composer). The conversation comes
 *      back on a new host and a new turn recalls the first token: the engine's
 *      durable session, not a new one. Then engine crash: a long turn, SIGKILL
 *      of the conversation's host only. Honest status, Reconnect clicked
 *      (trusted mouse click), resume_session + read_session_history on the
 *      wire, a new turn recalls the token. A second draft is typed, then the
 *      window is closed the normal way (engine closed with the app).
 *   3. Relaunch after the normal close: second draft restored, a new turn
 *      recalls the token.
 *
 *   node scripts/macos/m0-02-crash-resume.mjs [--exe <muse-desktop>] [--port 9412]
 *
 * Six live turns. Writes docs/evidence/2026-10-13-macos-closure/m0-02-crash-resume.json.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { BASE, COMMIT, EXE, J, alive, assistantHas, calls, clickSelector, hosts, now, openSession, platform, sidebar, sleep, transcript, typeInComposer, view, waitFor, writeRecord } from "./m0-g1-helpers.mjs";

const PORT = Number(argValue("--port", "9412"));
const ID = Date.now().toString(36).toUpperCase();
const ROOT = join(BASE, "m0-02", ID);
const PROJECT = join(ROOT, "project");
const DATA = join(ROOT, "data");
const SECRET = `KIWI-${ID}`;
const DRAFT1 = `M0-02 draft typed during a running turn, never sent ${ID} — accents é, emoji 😀`;
const DRAFT2 = `M0-02 second draft before a normal close ${ID}`;
const LONG = "Count from 1 to 3000, one number per line, with no other text.";
const recall = (tag) => `What exact token did I ask you to reply with in my very first message of this conversation? Reply with that token, then a space, then ${tag}.`;

mkdirSync(PROJECT, { recursive: true });
const realProject = realpathSync(PROJECT);

const record = {
  schema: "muse-desktop.m0-02-crash-resume.v1",
  ticket: "M0-02",
  date: now().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 6,
  harness: `scripts/macos/m0-02-crash-resume.mjs on scripts/macos/test-instance.mjs (launch, three instances on one data folder, store kept between them), bridge port ${PORT}`,
  isolation: null,
  method: "Instance 1: project conversation, first turn asks for a token, then a long counting turn and, while it streams, a draft typed (Input.insertText) in the same composer; 2 s later SIGKILL of the app pid. Instance 2 on the same data folder: storage compared with the values read just before the kill, draft read back in the composer, the conversation resumed on open, a new turn asks for the first token (engine-side history). Then a long turn and SIGKILL of that conversation's muse-bin host only; the Reconnect button clicked with a trusted mouse event; resume_session and read_session_history traced; a new turn recalls the token. A second draft, then a normal window close. Instance 3 on the same data: second draft restored, a new turn recalls the token.",
  phases: {},
  checks: {},
  verdicts: {},
  limits: [
    "The engine's session store (~/.local/share/muse/sessions) is the user's, shared by the test instances (ADR 0003).",
    "The page loads before the harness can trace it: the boot resume of instances 2 and 3 is read from its effects (host respawned in the project folder, Connected, the token recalled through the same session id), not from an IPC trace. The manual Reconnect of the engine-crash phase is traced.",
    "Debug build in test mode, not the release build.",
  ],
};

const storageSnapshot = (app, sid) => app.ev(`(() => {
  const keys = ['muse-desktop.projects.v1', 'muse-desktop.sessions.v1', 'muse-desktop.thread-projects.v1', 'muse-desktop.log.v1.' + ${J(sid)}, 'muse-desktop.draft.' + ${J(sid)}, 'muse-desktop.active.v1'];
  const out = {};
  for (const k of keys) { const v = localStorage.getItem(k); let valid = null; try { JSON.parse(v); valid = true; } catch { valid = false; } out[k.replace(${J(sid)}, '<sid>')] = v === null ? null : { bytes: v.length, validJson: valid, value: v }; }
  return out;
})()`);
const stripValues = (snap) => Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v && { bytes: v.bytes, validJson: v.validJson }]));
const doneTurn = (app, sid, token, ms = 240_000) => waitFor(async () => (await assistantHas(app, sid, token)) && !(await sidebar(app)).find((r) => r.sid === sid)?.running, ms, 1_000);
const lastAssistant = async (app, sid) => String((await transcript(app, sid)).filter((e) => e.role === "assistant").at(-1)?.text ?? "").slice(0, 200);

let sid = null;
let failure = null;

// ---- 1. app crash -------------------------------------------------------------
{
  const phase = record.phases.appCrash = {};
  const inst = await launch({ exe: EXE, port: PORT, data: DATA });
  record.engine = inst.engineVersion;
  record.isolation = { ...inst.isolation, sameDataFolderForAllInstances: true };
  const { app } = inst;
  try {
    phase.start = await newProjectConversation(app, PROJECT);
    sid = await sendFirstMessage(app, `Reply with exactly ${SECRET} and nothing else.`);
    phase.firstTurn = Boolean(await doneTurn(app, sid, SECRET));
    await typeInComposer(app, LONG);
    phase.longTurnRunning = Boolean(await waitFor(async () => (await transcript(app, sid)).filter((e) => e.role === "assistant").length >= 2 && (await sidebar(app)).find((r) => r.sid === sid)?.running, 60_000, 250));
    phase.draftTyped = await typeInComposer(app, DRAFT1, { enter: false });
    await sleep(2_000);
    phase.beforeKill = { view: await view(app), hosts: hosts(inst.pid) };
    phase.storageBeforeKill = await storageSnapshot(app, sid);
    const hostPids = phase.beforeKill.hosts.map((h) => h.pid);
    phase.killedAt = now();
    process.kill(inst.pid, "SIGKILL");
    await waitFor(() => !alive(inst.pid), 10_000, 100);
    phase.hostsAliveAfterAppKill = await waitFor(() => hostPids.filter(alive).length === 0 ? [] : null, 10_000, 250) ?? hostPids.filter(alive);
  } catch (error) {
    failure = `appCrash: ${error?.message ?? error}`;
  } finally {
    phase.stop = await inst.stop({ keepStore: true });
  }
}

// ---- 2. relaunch, then engine crash -------------------------------------------
if (!failure) {
  const phase = record.phases.relaunchAndEngineCrash = {};
  const inst = await launch({ exe: EXE, port: PORT, data: DATA });
  const { app } = inst;
  try {
    await waitFor(() => app.ev(`Boolean(document.querySelector('.session-item[data-session-id=${J(sid)}]'))`), 30_000, 250);
    await sleep(1_500);
    const after = await storageSnapshot(app, sid);
    const before = record.phases.appCrash.storageBeforeKill;
    phase.storageAfterRelaunch = stripValues(after);
    phase.storageCompare = Object.fromEntries(Object.keys(before).map((k) => [k, before[k]?.value === after[k]?.value ? "identical" : after[k] === null ? "missing" : `changed (${before[k]?.bytes} -> ${after[k]?.bytes} bytes, valid ${after[k]?.validJson})`]));
    // sessions.v1 may gain fields on relaunch (the boot restore): the row itself must be kept.
    const rowOf = (raw) => { try { return JSON.parse(raw).find((s) => s.session_id === sid) ?? null; } catch { return null; } };
    const rowBefore = rowOf(before["muse-desktop.sessions.v1"]?.value);
    const rowAfter = rowOf(after["muse-desktop.sessions.v1"]?.value);
    phase.sessionRowKept = Boolean(rowBefore && rowAfter) && Object.keys(rowBefore).filter((k) => !["running", "updatedAt", "lastActive"].includes(k)).every((k) => J(rowBefore[k]) === J(rowAfter[k]));
    phase.sessionRowFieldsChanged = rowBefore && rowAfter ? [...new Set([...Object.keys(rowBefore), ...Object.keys(rowAfter)])].filter((k) => J(rowBefore[k]) !== J(rowAfter[k])) : null;
    await openSession(app, sid);
    phase.draftInComposer = (await view(app)).composer?.value ?? null;
    const sessions = await app.ev(`JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').map((s) => s.session_id)`);
    const projects = await app.ev(`JSON.parse(localStorage.getItem('muse-desktop.projects.v1') || '[]').map((p) => p.root ?? p.path ?? p.name)`);
    const log = await transcript(app, sid);
    phase.restored = { sessions, projects, roles: log.map((e) => e.role), firstTokenInLog: log.some((e) => e.role === "assistant" && String(e.text).includes(SECRET)), draftUserMessageNotSent: !log.some((e) => e.role === "user" && String(e.text).includes(ID) && String(e.text).includes("draft")) };
    phase.resumeOnOpen = await waitFor(async () => { const v = await view(app); return v.connection === "Connected" ? { view: v, hosts: hosts(inst.pid) } : null; }, 60_000, 500) ?? { view: await view(app), hosts: hosts(inst.pid) };
    phase.killedTurnNotRunning = (await sidebar(app)).find((r) => r.sid === sid)?.running === false;
    // A new turn in the same session recalls the first token (engine history).
    await app.ev(INSTALL_IPC_TRACE);
    await app.ev(`(() => { const t = document.querySelector('textarea[aria-label="Message Muse"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const tag1 = `AFTER-APP-KILL-${ID}`;
    await typeInComposer(app, recall(tag1));
    phase.recallAfterAppKill = { done: Boolean(await doneTurn(app, sid, tag1)), reply: await lastAssistant(app, sid) };
    phase.recallAfterAppKill.sends = (await calls(app, "send_input")).map((c) => ({ sessionId: c.args?.sessionId, ok: c.ok }));

    // Engine crash: a long turn, then SIGKILL of this conversation's host only.
    await typeInComposer(app, LONG);
    await waitFor(async () => (await sidebar(app)).find((r) => r.sid === sid)?.running && (await lastAssistant(app, sid)).includes("20"), 90_000, 250);
    const host = hosts(inst.pid).find((h) => h.cwd === realProject);
    phase.engineKill = { host, at: now() };
    process.kill(host.pid, "SIGKILL");
    phase.afterEngineKill = await waitFor(async () => { const v = await view(app); return v.hostEndedLine && v.state === "Ready" && v.reconnect.length === 1 ? v : null; }, 30_000, 250) ?? await view(app);
    phase.appAliveAfterEngineKill = alive(inst.pid);
    phase.hostEndedInLog = (await transcript(app, sid)).filter((e) => e.role === "system").map((e) => String(e.text).slice(0, 120));
    // Reconnect, as the user does.
    await app.ev(INSTALL_IPC_TRACE);
    phase.reconnectClicked = await clickSelector(app, 'button[title="Reconnect this saved conversation to its workspace engine"]');
    phase.afterReconnect = await waitFor(async () => { const v = await view(app); return v.connection === "Connected" ? v : null; }, 60_000, 250) ?? await view(app);
    phase.reconnectWire = (await app.ev(`window.__baselineIpc.calls.filter((c) => ['resume_session', 'read_session_history'].includes(c.cmd)).map((c) => ({ cmd: c.cmd, sessionId: c.args?.sessionId, ok: c.ok, loaded: /"loaded"\\s*:\\s*true/.test(c.result || ''), durable: /"session_durability"\\s*:\\s*"durable"/.test(c.result || ''), resultBytes: (c.result || '').length }))`));
    phase.hostsAfterReconnect = hosts(inst.pid);
    const tag2 = `AFTER-ENGINE-KILL-${ID}`;
    await typeInComposer(app, recall(tag2));
    phase.recallAfterEngineKill = { done: Boolean(await doneTurn(app, sid, tag2)), reply: await lastAssistant(app, sid) };
    // A second draft, then a normal close.
    phase.draft2Typed = await typeInComposer(app, DRAFT2, { enter: false });
    await sleep(1_000);
  } catch (error) {
    failure = `relaunchAndEngineCrash: ${error?.message ?? error}`;
  } finally {
    phase.consoleErrors = app.errors.slice(0, 20);
    phase.stop = await inst.stop({ keepStore: true });
  }
}

// ---- 3. relaunch after a normal close ------------------------------------------
if (!failure) {
  const phase = record.phases.relaunchAfterClose = {};
  const inst = await launch({ exe: EXE, port: PORT, data: DATA });
  const { app } = inst;
  try {
    await waitFor(() => app.ev(`Boolean(document.querySelector('.session-item[data-session-id=${J(sid)}]'))`), 30_000, 250);
    await openSession(app, sid);
    phase.draftInComposer = (await view(app)).composer?.value ?? null;
    phase.resumeOnOpen = await waitFor(async () => { const v = await view(app); return v.connection === "Connected" ? v : null; }, 60_000, 500) ?? await view(app);
    await app.ev(`(() => { const t = document.querySelector('textarea[aria-label="Message Muse"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const tag3 = `AFTER-CLOSE-${ID}`;
    await typeInComposer(app, recall(tag3));
    phase.recallAfterClose = { done: Boolean(await doneTurn(app, sid, tag3)), reply: await lastAssistant(app, sid) };
    phase.roles = (await transcript(app, sid)).map((e) => e.role);
  } catch (error) {
    failure = `relaunchAfterClose: ${error?.message ?? error}`;
  } finally {
    phase.consoleErrors = app.errors.slice(0, 20);
    phase.stop = await inst.stop();
  }
}

// ---- verdicts -----------------------------------------------------------------
const p1 = record.phases.appCrash ?? {};
const p2 = record.phases.relaunchAndEngineCrash ?? {};
const p3 = record.phases.relaunchAfterClose ?? {};
if (p1.storageBeforeKill) p1.storageBeforeKill = stripValues(p1.storageBeforeKill);
const c = record.checks;
c.firstTurnAndLongTurnInFlight = Boolean(p1.firstTurn && p1.longTurnRunning && p1.beforeKill?.view?.state === "Working");
c.hostDiesWithApp = Array.isArray(p1.hostsAliveAfterAppKill) && p1.hostsAliveAfterAppKill.length === 0;
c.storageIntactAfterKill = Boolean(p2.storageCompare) && ["muse-desktop.projects.v1", "muse-desktop.thread-projects.v1", "muse-desktop.draft.<sid>"].every((k) => p2.storageCompare[k] === "identical")
  && p2.sessionRowKept === true;
c.transcriptKept = Boolean(p2.restored?.firstTokenInLog);
c.draftRestoredAfterKill = p2.draftInComposer === DRAFT1;
c.draftNeverSent = Boolean(p2.restored?.draftUserMessageNotSent);
c.resumedAfterAppKill = p2.resumeOnOpen?.view?.connection === "Connected" && (p2.resumeOnOpen?.hosts ?? []).some((h) => h.cwd === realProject) && p2.killedTurnNotRunning === true;
c.historyAfterAppKill = Boolean(p2.recallAfterAppKill?.done && p2.recallAfterAppKill.reply.includes(SECRET) && p2.recallAfterAppKill.sends?.length === 1 && p2.recallAfterAppKill.sends[0].sessionId === sid);
c.honestStatusAfterEngineKill = Boolean(p2.afterEngineKill?.hostEndedLine && p2.afterEngineKill.state === "Ready" && p2.afterEngineKill.connection === "Disconnected" && p2.appAliveAfterEngineKill
  && (p2.hostEndedInLog ?? []).some((t) => t.startsWith("Muse stopped because the host process ended")));
c.reconnectResumesDurable = Boolean(p2.afterReconnect?.connection === "Connected" && p2.reconnectWire?.some((w) => w.cmd === "resume_session" && w.ok && w.loaded && w.durable && w.sessionId === sid) && p2.reconnectWire?.some((w) => w.cmd === "read_session_history" && w.ok));
c.historyAfterEngineKill = Boolean(p2.recallAfterEngineKill?.done && p2.recallAfterEngineKill.reply.includes(SECRET));
c.draftRestoredAfterClose = p3.draftInComposer === DRAFT2;
c.historyAfterClose = Boolean(p3.recallAfterClose?.done && p3.recallAfterClose.reply.includes(SECRET) && p3.resumeOnOpen?.connection === "Connected");
c.nothingLeft = [p1.stop, p2.stop, p3.stop].every((s) => s && s.leftAfterQuit.length === 0 && s.groupLeftAfterQuit.length === 0 && s.defaultStoresUnchangedAtEnd) && p3.stop?.testStoreDeleted === true;
record.verdicts = {
  appCrashKeepsThreadsAndDraft: Boolean(c.firstTurnAndLongTurnInFlight && c.storageIntactAfterKill && c.transcriptKept && c.draftRestoredAfterKill && c.draftNeverSent),
  noSecondHostAfterAppCrash: Boolean(c.hostDiesWithApp),
  resumeAfterAppCrash: Boolean(c.resumedAfterAppKill && c.historyAfterAppKill),
  resumeAfterEngineCrash: Boolean(c.honestStatusAfterEngineKill && c.reconnectResumesDurable && c.historyAfterEngineKill),
  resumeAfterNormalClose: Boolean(c.draftRestoredAfterClose && c.historyAfterClose),
  nothingLeft: Boolean(c.nothingLeft),
};
record.failure = failure;
record.passed = !failure && Object.values(record.verdicts).every(Boolean);
console.log(JSON.stringify(writeRecord("m0-02-crash-resume.json", record), null, 2));
process.exit(record.passed ? 0 : 1);
