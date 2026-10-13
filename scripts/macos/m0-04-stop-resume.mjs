#!/usr/bin/env node
/**
 * M0-04 on macOS: stop and resume with reliable states.
 *
 * One isolated instance on the pinned engine, posture YOLO (allowAll, the
 * Isolation sandbox still on) so that the model's shell tool runs without a
 * card. Two projects, A and B. Every Stop is a trusted mouse click on the
 * composer's Stop button ("Stop the current turn"). For each phase: the
 * cancel_session call and its turnId, the "Stopping…" state, the time to a
 * resolved UI (Ready, no Stop button), the run's terminal as the engine
 * recorded it in its own session log, and the next turn.
 *
 *   beforeFirstToken  Stop as soon as the engine admitted the turn (send_input
 *                     answered), before any reply text.
 *   resume/afterEnd   a short turn right after, which completes; at its end no
 *                     Stop button is left and the engine run is completed.
 *   duringTool        Stop while the model's shell tool runs `sleep 45` (the
 *                     sleep process is seen under the engine): the process
 *                     goes, the run is cancelled.
 *   lateAnswer        Stop mid-stream of a long answer: no text lands after
 *                     the UI resolved.
 *   doubleClick       a trusted double-click on Stop: one cancel_session.
 *   aDoesNotStopB     B runs a long turn; A starts one and is stopped; B
 *                     finishes, completed for the engine.
 *   final             a short turn in A completes.
 *
 *   node scripts/macos/m0-04-stop-resume.mjs [--exe <muse-desktop>] [--port 9414]
 *
 * About ten live turns, most stopped early. Writes
 * docs/evidence/2026-10-13-macos-closure/m0-04-stop-resume.json.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { BASE, COMMIT, EXE, J, assistantHas, clickSelector, engineRuns, now, openSession, platform, pressEnter, sidebar, sleep, transcript, typeInComposer, view, waitFor, writeRecord } from "./m0-g1-helpers.mjs";

const PORT = Number(argValue("--port", "9414"));
const ID = Date.now().toString(36).toUpperCase();
const ROOT = join(BASE, "m0-04", ID);
const A = join(ROOT, "project-a");
const B = join(ROOT, "project-b");
mkdirSync(A, { recursive: true });
mkdirSync(B, { recursive: true });
const STOP = 'button[title="Stop the current turn"]';
const LONG = "Count from 1 to 3000, one number per line, with no other text.";

const record = {
  schema: "muse-desktop.m0-04-stop-resume.v1",
  ticket: "M0-04",
  date: now().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m0-04-stop-resume.mjs on scripts/macos/test-instance.mjs (launch), bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine, the global posture set to YOLO (muse-desktop.authorization-mode.v1, then a reload) before any conversation, the Isolation sandbox left at its default. Projects A and B from the welcome screen. Text typed with Input.insertText and Enter as AppKit key events; Stop clicked with trusted AppKit mouse events on the composer's Stop button. The IPC trace records cancel_session and send_input; the UI is sampled every 25 ms after a click; the engine's own session log (read only) gives each run's terminal state.",
  phases: {},
  checks: {},
  verdicts: {},
  limits: [
    "Posture YOLO for the whole run, so that the shell tool of the duringTool phase runs without an approval card; the Ask postures are covered by M0-05/M0-06.",
    "The engine's session store (~/.local/share/muse/sessions) is the user's, shared by the test instance (ADR 0003); it is only read here.",
    "Debug build in test mode, not the release build.",
  ],
};

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
let turns = 0;

const running = async (sid) => (await sidebar(app)).find((r) => r.sid === sid)?.running === true;
const textLen = async (sid) => (await transcript(app, sid)).filter((e) => e.role === "assistant").reduce((n, e) => n + String(e.text ?? "").length, 0);
const done = (sid, token, ms = 180_000) => waitFor(async () => (await assistantHas(app, sid, token)) && !(await running(sid)), ms, 500);
const lastRun = (sid) => engineRuns(sid)?.at(-1) ?? null;
const runCount = (sid) => engineRuns(sid)?.length ?? 0;

/** Clicks Stop and samples the UI every 25 ms until it is at rest again. */
async function stopAndWatch(sid, { clickCount = 1 } = {}) {
  await app.ev(INSTALL_IPC_TRACE);
  const t0 = Date.now();
  const clicked = await clickSelector(app, STOP, { clickCount });
  let stoppingSeen = false;
  let resolvedMs = null;
  while (Date.now() - t0 < 30_000) {
    const v = await view(app);
    if (v.stop?.text?.startsWith("Stopping")) stoppingSeen = true;
    if (!v.stop && v.state === "Ready") { resolvedMs = Date.now() - t0; break; }
    await sleep(25);
  }
  const cancels = (await app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === 'cancel_session')`)).map((c) => ({ sessionId: c.args?.sessionId, turnId: c.args?.turnId ?? null, ok: c.ok, atMs: c.atMs }));
  return { clicked, stoppingSeen, resolvedMs, cancels, cancelsForThis: cancels.filter((c) => c.sessionId === sid).length, turnIdSent: cancels.some((c) => c.sessionId === sid && typeof c.turnId === "string" && c.turnId.length > 0), view: await view(app) };
}

/** Waits for the engine to record the newest run's terminal. */
const engineTerminal = (sid, expectedRuns) => waitFor(() => { const runs = engineRuns(sid) ?? []; return runs.length >= expectedRuns && runs.at(-1).terminal ? runs.at(-1) : null; }, 20_000, 250);

try {
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(`(localStorage.setItem('muse-desktop.authorization-mode.v1', 'yolo'), true)`);
  await app.send("Page.reload", {});
  await sleep(1_000);
  await waitFor(() => app.ev("document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 250);
  record.posture = await app.ev(`localStorage.getItem('muse-desktop.authorization-mode.v1')`);

  // Project B first (it is the bystander of the last phase), then A.
  record.startB = await newProjectConversation(app, B);
  const sidB = await sendFirstMessage(app, `Reply with exactly READY-B-${ID} and nothing else.`);
  turns++;
  await done(sidB, `READY-B-${ID}`);
  record.startA = await newProjectConversation(app, A);
  const sidA = await sendFirstMessage(app, `Reply with exactly READY-A-${ID} and nothing else.`);
  turns++;
  await done(sidA, `READY-A-${ID}`);
  record.sessions = { sidA, sidB };

  // beforeFirstToken ------------------------------------------------------------
  {
    const p = record.phases.beforeFirstToken = {};
    const before = runCount(sidA);
    const lenBefore = await textLen(sidA);
    await typeInComposer(app, LONG, { enter: false });
    await app.ev(INSTALL_IPC_TRACE);
    const enterAt = Date.now();
    await pressEnter(app);
    // As soon as the engine admitted the turn (send_input answered), before any text.
    p.admitted = await waitFor(() => app.ev(`(window.__baselineIpc.calls.find((c) => c.cmd === 'send_input' && c.ok) || {}).result || null`), 15_000, 20);
    p.stopVisible = await app.ev(`Boolean(document.querySelector(${J(STOP)}))`);
    p.msEnterToClick = Date.now() - enterAt;
    p.replyTextAtClick = (await textLen(sidA)) - lenBefore;
    Object.assign(p, await stopAndWatch(sidA));
    turns++;
    p.engine = await engineTerminal(sidA, before + 1);
    p.noTextAfterwards = (await textLen(sidA)) - lenBefore;
  }
  // resume + afterEnd -------------------------------------------------------------
  {
    const p = record.phases.resumeAfterEnd = {};
    const before = runCount(sidA);
    const tag = `RESUMED-A-${ID}`;
    await app.ev(INSTALL_IPC_TRACE);
    await typeInComposer(app, `Reply with exactly ${tag} and nothing else.`);
    turns++;
    p.completed = Boolean(await done(sidA, tag));
    p.sendInput = (await app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input').map((c) => ({ ok: c.ok, disposition: (String(c.result).match(/"disposition":"(\\w+)"/) || [])[1] ?? null }))`));
    p.viewAtEnd = await view(app);
    p.engine = await engineTerminal(sidA, before + 1);
  }
  // duringTool ------------------------------------------------------------------
  {
    const p = record.phases.duringTool = {};
    const before = runCount(sidA);
    await typeInComposer(app, `Use your shell tool to run exactly this command: sleep 45 && echo SLEPT-${ID}. When it finishes, reply with TOOL-DONE-${ID}.`);
    turns++;
    const sleeping = await waitFor(() => processTree(inst.pid).find((x) => /\bsleep 45\b/.test(x.command)) ?? null, 90_000, 250);
    p.toolProcess = sleeping ? { pid: sleeping.pid, command: sleeping.command.slice(0, 120) } : null;
    p.approvalCards = await app.ev(`document.querySelectorAll('.approval-card, [class*="approval"] button').length`);
    if (sleeping) {
      await sleep(1_500);
      Object.assign(p, await stopAndWatch(sidA));
      p.toolProcessGoneWithin5s = Boolean(await waitFor(() => !processTree(inst.pid).some((x) => x.pid === sleeping.pid), 5_000, 100));
    }
    p.engine = await engineTerminal(sidA, before + 1);
    p.toolDoneTextNeverCame = !(await assistantHas(app, sidA, `TOOL-DONE-${ID}`));
  }
  // lateAnswer ------------------------------------------------------------------
  {
    const p = record.phases.lateAnswer = {};
    const before = runCount(sidA);
    const lenBefore = await textLen(sidA);
    await typeInComposer(app, LONG);
    turns++;
    await waitFor(async () => (await textLen(sidA)) - lenBefore > 800, 120_000, 100);
    p.replyTextAtClick = (await textLen(sidA)) - lenBefore;
    Object.assign(p, await stopAndWatch(sidA));
    const atRest = await textLen(sidA);
    await sleep(5_000);
    p.textGrewAfterResolved = (await textLen(sidA)) - atRest;
    p.engine = await engineTerminal(sidA, before + 1);
  }
  // doubleClick -----------------------------------------------------------------
  {
    const p = record.phases.doubleClick = {};
    const before = runCount(sidA);
    const lenBefore = await textLen(sidA);
    await typeInComposer(app, LONG);
    turns++;
    await waitFor(async () => (await textLen(sidA)) - lenBefore > 200, 120_000, 100);
    Object.assign(p, await stopAndWatch(sidA, { clickCount: 2 }));
    p.engine = await engineTerminal(sidA, before + 1);
  }
  // aDoesNotStopB ---------------------------------------------------------------
  {
    const p = record.phases.aDoesNotStopB = {};
    const beforeA = runCount(sidA);
    const beforeB = runCount(sidB);
    const endB = `END-B-${ID}`;
    await openSession(app, sidB);
    await typeInComposer(app, `Count from 1 to 1500, one number per line, with no other text. After 1500, write ${endB} on its own line.`);
    turns++;
    await waitFor(async () => (await running(sidB)) && (await textLen(sidB)) > 200, 120_000, 100);
    await openSession(app, sidA);
    const lenA = await textLen(sidA);
    await typeInComposer(app, LONG);
    turns++;
    await waitFor(async () => (await textLen(sidA)) - lenA > 200, 120_000, 100);
    p.bothRunningBeforeStop = (await running(sidA)) && (await running(sidB));
    const bLenAtStop = await textLen(sidB);
    Object.assign(p, await stopAndWatch(sidA));
    p.bRunningAfterAStopped = await running(sidB);
    await sleep(2_000);
    p.bGrewAfterAStopped = (await textLen(sidB)) - bLenAtStop;
    p.bFinished = Boolean(await done(sidB, endB, 300_000));
    p.engineA = await engineTerminal(sidA, beforeA + 1);
    p.engineB = await engineTerminal(sidB, beforeB + 1);
  }
  // final -----------------------------------------------------------------------
  {
    const p = record.phases.final = {};
    const tag = `FINAL-A-${ID}`;
    await openSession(app, sidA);
    await typeInComposer(app, `Reply with exactly ${tag} and nothing else.`);
    turns++;
    p.completed = Boolean(await done(sidA, tag));
    p.engineRunsA = engineRuns(sidA);
    p.engineRunsB = engineRuns(sidB);
  }
  record.consoleErrors = app.errors.slice(0, 20);
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.stop = await inst.stop();
}
record.liveTurns = turns;

// ---- checks -------------------------------------------------------------------
const ph = record.phases;
const c = record.checks;
const resolved = (p, maxMs = 5_000) => Boolean(p && p.clicked && p.resolvedMs !== null && p.resolvedMs <= maxMs && p.cancelsForThis === 1 && p.cancels.every((x) => x.ok) && p.view?.state === "Ready" && !p.view?.stop);
const cancelled = (p) => p?.engine?.terminal === "cancelled";
c.beforeFirstToken = resolved(ph.beforeFirstToken) && ph.beforeFirstToken.replyTextAtClick === 0 && cancelled(ph.beforeFirstToken);
c.beforeFirstTokenTurnId = Boolean(ph.beforeFirstToken?.turnIdSent);
c.resumeImmediately = Boolean(ph.resumeAfterEnd?.completed && ph.resumeAfterEnd.sendInput?.length === 1 && ph.resumeAfterEnd.sendInput[0].ok);
c.afterEndNoStop = Boolean(ph.resumeAfterEnd?.viewAtEnd && !ph.resumeAfterEnd.viewAtEnd.stop && ph.resumeAfterEnd.viewAtEnd.state === "Ready" && ph.resumeAfterEnd.engine?.terminal === "completed");
c.duringTool = Boolean(ph.duringTool?.toolProcess) && resolved(ph.duringTool) && ph.duringTool.turnIdSent && ph.duringTool.toolProcessGoneWithin5s && cancelled(ph.duringTool) && ph.duringTool.toolDoneTextNeverCame;
c.lateAnswer = resolved(ph.lateAnswer) && ph.lateAnswer.turnIdSent && ph.lateAnswer.textGrewAfterResolved === 0 && cancelled(ph.lateAnswer);
c.doubleClickOneCancel = resolved(ph.doubleClick) && ph.doubleClick.turnIdSent && cancelled(ph.doubleClick);
c.aDoesNotStopB = Boolean(ph.aDoesNotStopB?.bothRunningBeforeStop) && resolved(ph.aDoesNotStopB) && ph.aDoesNotStopB.cancels.every((x) => x.sessionId === record.sessions?.sidA)
  && ph.aDoesNotStopB.bRunningAfterAStopped && ph.aDoesNotStopB.bGrewAfterAStopped > 0 && ph.aDoesNotStopB.bFinished
  && ph.aDoesNotStopB.engineA?.terminal === "cancelled" && ph.aDoesNotStopB.engineB?.terminal === "completed";
c.finalTurn = Boolean(ph.final?.completed);
if (ph.beforeFirstToken && !ph.beforeFirstToken.turnIdSent && cancelled(ph.beforeFirstToken)) {
  record.observations = { beforeFirstTokenTurnId: `The Stop clicked ${ph.beforeFirstToken.msEnterToClick} ms after Enter, once send_input had answered with its turnId, went out without a turnId (the renderer had not taken it yet); the engine still cancelled that run. The by-design fallback also seen on Windows (cdp-stop-terminal notes).` };
}
c.stoppingStateShown =Object.values(ph).filter((p) => p && "stoppingSeen" in p).map((p) => p.stoppingSeen);
c.nothingLeft = record.stop.leftAfterQuit.length === 0 && record.stop.groupLeftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd === true;
record.verdicts = {
  stopBeforeFirstToken: Boolean(c.beforeFirstToken),
  stopDuringTool: Boolean(c.duringTool),
  stopAfterEnd: Boolean(c.afterEndNoStop),
  stopWithLateAnswer: Boolean(c.lateAnswer),
  stopDoubleClick: Boolean(c.doubleClickOneCancel),
  stoppingADoesNotAffectB: Boolean(c.aDoesNotStopB),
  finalStateMatchesEngine: [ph.beforeFirstToken, ph.duringTool, ph.lateAnswer, ph.doubleClick].every(cancelled) && ph.resumeAfterEnd?.engine?.terminal === "completed",
  resumeAfterStop: Boolean(c.resumeImmediately && c.finalTurn),
  nothingLeft: Boolean(c.nothingLeft),
};
record.passed = !record.failure && Object.values(record.verdicts).every(Boolean);
console.log(JSON.stringify(writeRecord("m0-04-stop-resume.json", record), null, 2));
process.exit(record.passed ? 0 : 1);
