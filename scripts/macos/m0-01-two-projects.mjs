#!/usr/bin/env node
/**
 * M0-01 on macOS: A keeps working when project B is opened, active and cut.
 *
 * One isolated instance (launch()) on the pinned engine. Two projects, each a
 * folder of its own under the proof folder, each its own engine host. A long
 * turn in A, then a long turn in B while A still streams; both must run at
 * once. B's host (the muse-bin serve whose working directory is B) is killed
 * with SIGKILL mid-turn. Checked: B alone shows the host's end, A finishes its
 * turn with no error and on the same host, A then takes a new turn, and
 * nothing is left after the window closes. What B does after the kill (the
 * app's one silent resume of the open conversation) is recorded.
 *
 *   node scripts/macos/m0-01-two-projects.mjs [--exe <muse-desktop>] [--port 9411]
 *
 * Three live turns. Writes docs/evidence/2026-10-13-macos-closure/m0-01-two-projects.json.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { BASE, COMMIT, EXE, alive, assistantHas, hosts, now, openSession, platform, sidebar, sleep, transcript, typeInComposer, view, waitFor, writeRecord } from "./m0-g1-helpers.mjs";

const PORT = Number(argValue("--port", "9411"));
const ID = Date.now().toString(36).toUpperCase();
const ROOT = join(BASE, "m0-01", ID);
const A = join(ROOT, "project-a");
const B = join(ROOT, "project-b");
const END_A = `END-A-${ID}`;
const END_B = `END-B-${ID}`;
const AGAIN = `A-AGAIN-${ID}`;
const long = (end) => `Count from 1 to 3000, one number per line, with no other text. After 3000, write ${end} on its own line.`;

mkdirSync(A, { recursive: true });
mkdirSync(B, { recursive: true });
const realA = realpathSync(A);
const realB = realpathSync(B);

const record = {
  schema: "muse-desktop.m0-01-two-projects.v1",
  ticket: "M0-01",
  date: now().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 3,
  harness: `scripts/macos/m0-01-two-projects.mjs on scripts/macos/test-instance.mjs (launch), bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine (MUSE_NO_AUTO_UPDATE=1). Project A and project B are two fresh folders under the proof folder, each created from the welcome screen (folder dialog answered by the IPC trace) with a real Enter. A long counting turn in A; while it streams, a long counting turn in B. Both rows show Working at once and both transcripts grow. B's engine host, found as the muse-bin serve child of the app whose working directory (lsof) is B, gets SIGKILL mid-turn. Then: what B shows and the host list over 12 s, A finishing on the same host pid, a new turn in A, B's transcript, and the window closed with nothing left (app pid and every host pid gone).",
  steps: [],
  checks: {},
  verdicts: {},
  limits: [
    "The engine's session store (~/.local/share/muse/sessions) is the user's, shared by the test instance (ADR 0003).",
    "Debug build in test mode, not the notarised release build: the packaged repetition stays with the DMG (M4-09 session).",
  ],
};
const step = (label, data = {}) => record.steps.push({ label, at: now().slice(11, 23), ...data });

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
try {
  // A: long turn.
  step("A/start", { ui: await newProjectConversation(app, A) });
  const sidA = await sendFirstMessage(app, long(END_A));
  step("A/sent", { sidA });
  await waitFor(async () => (await sidebar(app)).find((r) => r.sid === sidA)?.running, 30_000, 250);
  // A's first text before B starts, so the turns overlap for real.
  const aFirst = await waitFor(async () => (await transcript(app, sidA)).some((e) => e.role === "assistant" && String(e.text ?? "").length > 0), 120_000, 500);
  step("A/streaming", { aFirstText: Boolean(aFirst) });

  // B: long turn while A streams.
  step("B/start", { ui: await newProjectConversation(app, B) });
  const sidB = await sendFirstMessage(app, long(END_B));
  step("B/sent", { sidB });
  const both = await waitFor(async () => {
    const rows = await sidebar(app);
    return rows.find((r) => r.sid === sidA)?.running && rows.find((r) => r.sid === sidB)?.running ? rows : null;
  }, 30_000, 250);
  const lenOf = async (sid) => (await transcript(app, sid)).filter((e) => e.role === "assistant").reduce((n, e) => n + String(e.text ?? "").length, 0);
  // Streams interleaved: both transcripts grow over the same seconds.
  await waitFor(async () => (await lenOf(sidB)) > 0, 120_000, 500);
  const growth = [];
  for (let i = 0; i < 4; i++) { growth.push({ a: await lenOf(sidA), b: await lenOf(sidB) }); await sleep(1_000); }
  const hostsBefore = hosts(inst.pid);
  step("both/running", { bothRunning: Boolean(both), growth, hosts: hostsBefore });
  record.checks.twoHostsTwoFolders = hostsBefore.length === 2 && hostsBefore.some((h) => h.cwd === realA) && hostsBefore.some((h) => h.cwd === realB);
  record.checks.bothWorkingAtOnce = Boolean(both);
  record.checks.streamsInterleaved = growth.at(-1).a > growth[0].a && growth.at(-1).b > growth[0].b;
  const hostA = hostsBefore.find((h) => h.cwd === realA);
  const hostB = hostsBefore.find((h) => h.cwd === realB);
  record.checks.aNotDoneBeforeKill = !(await assistantHas(app, sidA, END_A));

  // Kill B's host mid-turn, B being the conversation on screen.
  const killedAt = Date.now();
  process.kill(hostB.pid, "SIGKILL");
  step("B/host-killed", { pid: hostB.pid, aRunning: (await sidebar(app)).find((r) => r.sid === sidA)?.running });
  // B's screen and the hosts over the next 12 s (the app resumes the open
  // conversation silently once per run: lib/bootResume.ts selectResumeOnOpen).
  const timeline = [];
  let bView = null;
  for (let t = 0; t < 48; t++) {
    const v = await view(app);
    if (!bView && v.sid === sidB && v.hostEndedLine && v.state === "Ready") bView = { ...v, msAfterKill: Date.now() - killedAt };
    timeline.push({ ms: Date.now() - killedAt, state: v.state, connection: v.connection, hostEndedLine: v.hostEndedLine, reconnect: v.reconnect, hosts: hosts(inst.pid).map((h) => ({ pid: h.pid, project: h.cwd === realA ? "A" : h.cwd === realB ? "B" : h.cwd })) });
    await sleep(250);
  }
  const compact = timeline.filter((e, i) => i === 0 || JSON.stringify({ ...e, ms: 0 }) !== JSON.stringify({ ...timeline[i - 1], ms: 0 }));
  step("B/after-kill", { honestStatus: bView, timeline: compact });
  record.checks.bHonestStatus = Boolean(bView);
  record.checks.bNotRunning = (await sidebar(app)).find((r) => r.sid === sidB)?.running === false;
  record.checks.bTurnNotFinished = !(await assistantHas(app, sidB, END_B));
  record.checks.aRunningThroughBDeath = timeline.every((e) => e.hosts.some((h) => h.pid === hostA.pid));
  const respawn = timeline.find((e) => e.hosts.some((h) => h.project === "B"));
  record.observations = { bHostRespawnedByResumeOnOpenAtMs: respawn ? respawn.ms : null };

  // A finishes its turn on the same host.
  await openSession(app, sidA);
  const aMid = await view(app);
  step("A/after-kill", { view: aMid });
  record.checks.aStillWorkingAfterKill = aMid.state === "Working" && aMid.connection === "Connected" && !aMid.hostEndedLine;
  const aDone = await waitFor(async () => (await assistantHas(app, sidA, END_A)) && !(await sidebar(app)).find((r) => r.sid === sidA)?.running, 300_000, 1_000);
  const aEnd = await view(app);
  const aLog = await transcript(app, sidA);
  step("A/done", { msAfterKill: Date.now() - killedAt, view: aEnd, roles: aLog.map((e) => e.role) });
  record.checks.aFinishedAfterKill = Boolean(aDone);
  record.checks.aNoErrorNoHostEnd = !aEnd.hostEndedLine && aEnd.connection === "Connected" && !aLog.some((e) => /error|failed/i.test(String(e.role)));
  record.checks.aSameHost = alive(hostA.pid) && hosts(inst.pid).some((h) => h.pid === hostA.pid && h.cwd === realA);

  // A keeps its requests: a new turn.
  await app.ev(INSTALL_IPC_TRACE);
  await typeInComposer(app, `Reply with exactly ${AGAIN} and nothing else.`);
  const again = await waitFor(async () => (await assistantHas(app, sidA, AGAIN)) && !(await sidebar(app)).find((r) => r.sid === sidA)?.running, 180_000, 1_000);
  const sends = await app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input').map((c) => ({ sessionId: c.args?.sessionId, ok: c.ok }))`);
  step("A/new-turn", { replied: Boolean(again), sends });
  record.checks.aNewTurn = Boolean(again) && sends.length === 1 && sends[0].sessionId === sidA && sends[0].ok;

  // B afterwards: its killed turn stays ended, its transcript kept.
  const hostsAfter = hosts(inst.pid);
  await openSession(app, sidB);
  const bLater = await view(app);
  const bLog = await transcript(app, sidB);
  step("hosts/after", { hosts: hostsAfter, bView: bLater, bRoles: bLog.map((e) => e.role) });
  record.checks.bTranscriptKept = bLog.some((e) => e.role === "user") && bLog.some((e) => e.role === "assistant" && String(e.text ?? "").length > 0);
  record.checks.bKilledTurnNotReplayed = !(await assistantHas(app, sidB, END_B)) && (await sidebar(app)).find((r) => r.sid === sidB)?.running === false;
  const sessions = await app.ev(`JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').map((s) => ({ sid: s.session_id, workspace: s.workspace }))`);
  record.checks.identitiesKept = sessions.some((s) => s.sid === sidA && s.workspace && realpathSync(s.workspace) === realA)
    && sessions.some((s) => s.sid === sidB && s.workspace && realpathSync(s.workspace) === realB);
  step("sessions", { sessions });
  record.consoleErrors = app.errors.slice(0, 20);
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.stop = await inst.stop();
}
record.checks.nothingLeftAfterClose = record.stop.leftAfterQuit.length === 0 && record.stop.groupLeftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd === true;
await sleep(1_000);
record.checks.ourProcessesGone = !alive(inst.pid) && !record.steps.flatMap((x) => x.hosts ?? []).some((h) => alive(h.pid));
const c = record.checks;
record.verdicts = {
  concurrentTurnsInTwoProjects: Boolean(c.twoHostsTwoFolders && c.bothWorkingAtOnce && c.streamsInterleaved),
  onlyBDisconnected: Boolean(c.bHonestStatus && c.bNotRunning && c.bTurnNotFinished && c.aStillWorkingAfterKill && c.aRunningThroughBDeath),
  aFinishesAfterBDies: Boolean(c.aNotDoneBeforeKill && c.aFinishedAfterKill && c.aNoErrorNoHostEnd && c.aSameHost),
  aKeepsIdentityAndRequests: Boolean(c.identitiesKept && c.aNewTurn),
  bKeepsItsTranscript: Boolean(c.bTranscriptKept && c.bKilledTurnNotReplayed),
  nothingLeftAfterClose: Boolean(c.nothingLeftAfterClose && c.ourProcessesGone),
};
record.passed = !record.failure && Object.values(record.verdicts).every(Boolean);
console.log(JSON.stringify(writeRecord("m0-01-two-projects.json", record), null, 2));
process.exit(record.passed ? 0 : 1);
