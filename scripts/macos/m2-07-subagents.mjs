#!/usr/bin/env node
/**
 * M2-07 native macOS proof: drive the real sub-agents. The Windows records
 * are scripts/cdp-m2-07-subagents.mjs (26/09: a lane stopped through its own
 * control, parent resume) and docs/evidence/2026-09-27-qualif-native/
 * m2-worktrees.md run2 (3 + 2 simultaneous lanes across two threads).
 *
 *   1. Global posture Yolo (isolated instance), so the children's `sleep`
 *      runs without a card.
 *   2. Thread A asks for three sub-agents at once, each running `sleep 45`;
 *      as soon as A has a running lane, thread B asks for two more.
 *   3. Both conversations' stored logs are sampled every second: running
 *      controllable lanes (role subagent, not host-internal) per thread and
 *      at the same instant across threads.
 *   4. A's first running lane is stopped through its own Stop button
 *      (subagent/stop); its status changes, the other lanes (A's and B's)
 *      keep running.
 *   5. Both parents end; on a finished lane Stop is disabled with its reason;
 *      Read result on a finished lane answers.
 *   6. Switch to B and back to A: same lanes, same terminal states, nothing
 *      re-runs (no new lane, no lane back to running).
 *
 *   node scripts/macos/m2-07-subagents.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9456] [--base $TMPDIR/muse-proofs-g5/m2-07]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-07-subagents.json]
 *
 * Two live turns (their children are sub-agents of those turns).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9456"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-07")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-07-subagents.json");
mkdirSync(BASE_ARG, { recursive: true });
const BASE = realpathSync(BASE_ARG);
const FA = join(BASE, "thread-a");
const FB = join(BASE, "thread-b");
const J = JSON.stringify;
const redact = redactor([[FA, "<folder A>"], [FB, "<folder B>"], [BASE, "<proof>"], [BASE_ARG, "<proof>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]);
const PROMPT_A = "M2-07 macOS proof. Start three sub-agents at the same time, in parallel, without waiting for one before starting the next. Each sub-agent must run the shell command `sleep 45` and then answer with the single word DONE. Do not wait for them to finish: as soon as the three are started, reply with just the word SPAWNED.";
const PROMPT_B = "M2-07 macOS proof, second thread. Start two sub-agents at the same time, in parallel. Each sub-agent must run the shell command `sleep 45` and then answer with the single word DONE. Do not wait for them: once both are started, reply with just the word SPAWNED.";

/** Controllable lanes of one conversation, from its stored log. */
const lanes = (app, sid) => app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${J(sid)}) || '[]'))
  .filter((e) => e.role === 'subagent' && e.subagentInternal !== true)
  .map((e) => ({ id: e.id, agentId: e.agentId ?? null, child: e.childSessionId ?? null, status: e.subagentStatus ?? (e.open ? 'running' : 'completed'), open: e.open === true }))`);
const internalCount = (app, sid) => app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${J(sid)}) || '[]')).filter((e) => e.role === 'subagent' && e.subagentInternal === true).length`);
const parentRunning = (app, sid) => app.ev(`document.querySelector('li.session-item[data-session-id="' + ${J(sid)} + '"] .dot')?.getAttribute('data-running') === 'true'`);
async function select(app, sid) {
  await app.ev(`(() => { const b = document.querySelector('li.session-item[data-session-id="' + ${J(sid)} + '"] button.session-select'); if (b) b.click(); return !!b; })()`);
  await waitFor(() => app.ev(`document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${J(sid)}`), 15_000, 200);
  await sleep(800);
}
/** The lane blocks on screen for the active conversation. */
const domLanes = (app) => app.ev(`[...document.querySelectorAll('details.msg.subagent')].map((d) => ({
  status: d.querySelector('.subagent-status')?.getAttribute('data-status') ?? null,
  child: d.querySelector('.subagent-child')?.getAttribute('title') ?? null,
  stop: (() => { const b = [...d.querySelectorAll('.subagent-controls button')].find((x) => x.innerText.trim() === 'Stop'); return b ? { disabled: b.disabled, title: b.title } : null; })(),
  readResult: (() => { const b = [...d.querySelectorAll('.subagent-controls button')].find((x) => x.innerText.trim() === 'Read result'); return b ? { disabled: b.disabled, title: b.title } : null; })(),
}))`);

const record = {
  schema: "muse-desktop.m2-07-subagents.macos.v1",
  ticket: "M2-07",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon; debug build 08b291d with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  liveTurns: 2,
  harness: `scripts/macos/m2-07-subagents.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  method: "One isolated instance, global posture Yolo (allowAll) in its own data folder so the children's shell steps run without cards. Two conversations in two project folders started from the welcome screen (typed message, real Enter). Lane states are read from each conversation's stored log every second (both threads at the same instant); controls are the lane block's own buttons in the DOM. The sub-agent processes are counted under the app with ps (`sleep 45`).",
  prompts: { A: PROMPT_A, B: PROMPT_B },
};
let inst = null;
try {
  mkdirSync(FA, { recursive: true });
  mkdirSync(FB, { recursive: true });
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const { app } = inst;
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  // 1. Yolo.
  await app.ev(`(async () => { document.querySelector('button[aria-label="Settings"]').click(); await new Promise((r) => setTimeout(r, 800));
    document.querySelector('input[name="authorization-mode"][value="yolo"]').click(); await new Promise((r) => setTimeout(r, 400)); return true; })()`);
  record.posture = await app.ev(`[...document.querySelectorAll('.authorization-status')].map((n) => n.innerText.trim())`);

  // 2. Thread A, then thread B once A has a running lane.
  record.startA = await newProjectConversation(app, FA);
  const sidA = await sendFirstMessage(app, PROMPT_A);
  const samples = [];
  // Each child's `sleep 45`, attributed to its thread by the engine it runs under (that engine's cwd).
  const cwdOf = new Map();
  const sleepsUnderApp = () => {
    const tree = processTree(inst.pid);
    const byPid = new Map(tree.map((p) => [p.pid, p]));
    const out = { all: 0, A: 0, B: 0 };
    for (const p of tree.filter((x) => /^(\/bin\/)?sleep 45$/.test(x.command.trim()))) {
      out.all += 1;
      let up = byPid.get(p.ppid);
      while (up && !/muse-bin/.test(up.command)) up = byPid.get(up.ppid);
      if (!up) continue;
      if (!cwdOf.has(up.pid)) { try { cwdOf.set(up.pid, execFileSync("lsof", ["-a", "-p", String(up.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null); } catch { cwdOf.set(up.pid, null); } }
      const cwd = cwdOf.get(up.pid);
      if (cwd === FA) out.A += 1; else if (cwd === FB) out.B += 1;
    }
    return out;
  };
  // What the model's sub-agents leave in a log besides lanes: the subagent_spawn tool rows, and the host-internal children.
  const others = (sid) => app.ev(`(() => { const l = JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${J(sid)}) || '[]');
    return { spawnAccepted: l.filter((e) => e.role === 'tool' && /^subagent_spawn\\n/.test(e.text || '') && /"status":"accepted"/.test(e.text || '')).length,
      internalRunning: l.filter((e) => e.role === 'subagent' && e.subagentInternal === true && (e.subagentStatus ?? (e.open ? 'running' : 'completed')) === 'running').length }; })()`);
  const sample = async (sidB = null) => {
    const a = await lanes(app, sidA);
    const b = sidB ? await lanes(app, sidB) : [];
    const oa = await others(sidA);
    const ob = sidB ? await others(sidB) : { spawnAccepted: 0, internalRunning: 0 };
    const s = { t: samples.length, aRunning: a.filter((l) => l.status === "running").length, bRunning: b.filter((l) => l.status === "running").length,
      aLanes: a.length, bLanes: b.length, aChildren: a.filter((l) => l.child).length,
      aSpawnAccepted: oa.spawnAccepted, bSpawnAccepted: ob.spawnAccepted, aInternalRunning: oa.internalRunning, bInternalRunning: ob.internalRunning, sleeps: sleepsUnderApp() };
    samples.push(s);
    return s;
  };
  // A lane, or the spawn accepted, or the children's `sleep` running: B starts then.
  await waitFor(async () => { const s = await sample(); return s.aRunning > 0 || s.aSpawnAccepted > 0 || s.sleeps.all > 0; }, 120_000, 1_000);
  await app.ev(`(() => { document.querySelector('.primary-nav button[aria-label="New conversation"]').click(); return true; })()`);
  await sleep(1_000);
  record.startB = await newProjectConversation(app, FB);
  const sidB = await sendFirstMessage(app, PROMPT_B);

  // 3-4. Sample both threads; stop A's first running lane from its own button.
  await select(app, sidA);
  let stop = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const s = await sample(sidB);
    if (stop === null && s.aRunning > 0 && (s.bRunning > 0 || Date.now() - t0 > 40_000)) {
      const lanesBefore = { a: await lanes(app, sidA), b: await lanes(app, sidB) };
      const clicked = await app.ev(`(() => {
        const block = [...document.querySelectorAll('details.msg.subagent')].find((d) => d.querySelector('.subagent-status')?.getAttribute('data-status') === 'running'
          && [...d.querySelectorAll('.subagent-controls button')].some((x) => x.innerText.trim() === 'Stop' && !x.disabled));
        if (!block) return { clicked: false };
        const b = [...block.querySelectorAll('.subagent-controls button')].find((x) => x.innerText.trim() === 'Stop');
        const child = block.querySelector('.subagent-child')?.getAttribute('title') ?? null;
        b.click();
        return { clicked: true, title: b.title, child };
      })()`);
      stop = { atSample: s.t, clicked, lanesBefore };
      if (clicked.clicked) {
        await sleep(4_000);
        stop.ipc = (await app.ev("window.__baselineIpc.calls.filter((c) => /subagent/.test(c.cmd))")).map((c) => ({ cmd: c.cmd, ok: c.ok, args: c.args ? { sessionId: c.args.sessionId ?? null, agentId: c.args.agentId ?? c.args.agent ?? null } : null, result: String(c.result ?? "").slice(0, 300) }));
        stop.lanesAfter = { a: await lanes(app, sidA), b: await lanes(app, sidB) };
        stop.dom = await domLanes(app);
      }
    }
    const done = !(await parentRunning(app, sidA)) && !(await parentRunning(app, sidB)) && s.aRunning === 0 && s.bRunning === 0 && s.aLanes > 0;
    if (done && stop) break;
    await sleep(1_000);
  }
  await waitFor(async () => { const s = await sample(sidB); return s.aRunning === 0 && s.bRunning === 0 && !(await parentRunning(app, sidA)) && !(await parentRunning(app, sidB)); }, 180_000, 2_000);
  record.samples = samples;
  record.stop = stop;

  // 5. Finished lanes: Stop disabled with its reason; Read result answers.
  await select(app, sidA);
  const finalA = await lanes(app, sidA);
  const finalB = await lanes(app, sidB);
  const allChildren = (sid) => app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${J(sid)}) || '[]')).filter((e) => e.role === 'subagent' || (e.role === 'tool' && /^subagent_spawn/.test(e.text || ''))).map((e) => [e.id, e.role, e.subagentInternal === true, e.subagentStatus ?? null, e.open === true])`);
  record.finished = { a: finalA, b: finalB, dom: await domLanes(app), internalLanes: { a: await internalCount(app, sidA), b: await internalCount(app, sidB) }, childrenA: await allChildren(sidA) };
  const readCount = (await app.ev("window.__baselineIpc.calls.filter((c) => /subagent|session_read|read_subagent/.test(c.cmd)).length"));
  record.readResult = await app.ev(`(async () => {
    const block = [...document.querySelectorAll('details.msg.subagent')].find((d) => d.querySelector('.subagent-status')?.getAttribute('data-status') === 'completed'
      && [...d.querySelectorAll('.subagent-controls button')].some((x) => x.innerText.trim() === 'Read result' && !x.disabled));
    if (!block) return { clicked: false };
    block.open = true;
    [...block.querySelectorAll('.subagent-controls button')].find((x) => x.innerText.trim() === 'Read result').click();
    await new Promise((r) => setTimeout(r, 4000));
    return { clicked: true, shown: (block.innerText || '').replace(/\\s+/g, ' ').slice(-300) };
  })()`);
  record.readResult.ipc = (await app.ev("window.__baselineIpc.calls")).filter((c) => /subagent|session_read|read_subagent/.test(c.cmd)).slice(readCount - 0)
    .map((c) => ({ cmd: c.cmd, ok: c.ok, result: String(c.result ?? "").slice(0, 300) }));

  // 6. Parent resume: B, then A again.
  await select(app, sidB);
  await sleep(2_000);
  await select(app, sidA);
  await sleep(3_000);
  record.afterResume = { a: await lanes(app, sidA), dom: await domLanes(app), childrenA: await allChildren(sidA) };

  const maxA = Math.max(0, ...samples.map((s) => s.aRunning));
  const maxB = Math.max(0, ...samples.map((s) => s.bRunning));
  const maxBoth = Math.max(0, ...samples.filter((s) => s.aRunning > 0 && s.bRunning > 0).map((s) => s.aRunning + s.bRunning));
  const stoppedId = stop?.clicked?.clicked ? stop.lanesBefore.a.find((l) => l.status === "running" && (l.child === stop.clicked.child || !stop.clicked.child))?.id : null;
  const stoppedAfter = stop?.lanesAfter?.a.find((l) => l.id === stoppedId) ?? null;
  const othersBefore = stop?.lanesBefore ? [...stop.lanesBefore.a.filter((l) => l.id !== stoppedId && l.status === "running"), ...stop.lanesBefore.b.filter((l) => l.status === "running")] : [];
  const othersAfter = stop?.lanesAfter ? [...stop.lanesAfter.a, ...stop.lanesAfter.b] : [];
  const finishedDom = record.finished.dom.filter((d) => d.status && d.status !== "running");
  const controllable = finalA.length + finalB.length > 0;
  const HOST = "not reachable on Muse 1.4.2: the host emits no subagent item for the sub-agents its model spawns (m2-07-msp-subagent-notifications-1.4.2.json)";
  record.verdicts = {
    spawnAcceptedInBothThreads: Math.max(...samples.map((x) => x.aSpawnAccepted)) >= 1 && Math.max(...samples.map((x) => x.bSpawnAccepted)) >= 1,
    childrenRanConcurrentlyInOneThread: Math.max(...samples.map((x) => x.sleeps.A)) >= 2,
    childrenRanConcurrentlyAcrossThreads: samples.some((x) => x.sleeps.A >= 1 && x.sleeps.B >= 1),
    internalChildrenGetNoDeadControls: record.finished.internalLanes.a > 0 && record.finished.dom.length === finalA.length,
    parentResumeKeepsHistory: J(record.afterResume.childrenA) === J(record.finished.childrenA) && record.afterResume.childrenA.every((c) => c[4] === false),
  };
  record.controllableLaneCriteria = controllable ? {
    controllableLanesRendered: finalA.length > 0 && record.finished.dom.some((d) => d.child && d.stop),
    childSessionLinks: finalA.some((l) => l.child),
    concurrentLanesInOneThread: maxA >= 2,
    concurrentLanesAcrossThreads: maxBoth >= 2 && samples.some((s) => s.aRunning > 0 && s.bRunning > 0),
    laneStoppedThroughItsControl: stop?.clicked?.clicked === true && stop.clicked.title === "subagent/stop" && stoppedAfter !== null && stoppedAfter.status !== "running",
    stopTouchesOnlyThatLane: othersBefore.length > 0 && othersBefore.every((o) => { const now = othersAfter.find((l) => l.id === o.id); return now && (now.status === "running" || now.status === "completed"); }),
    finishedLaneControlsBounded: finishedDom.length > 0 && finishedDom.every((d) => d.stop === null || (d.stop.disabled === true && /finished|nothing to/.test(d.stop.title))),
    parentResumeKeepsLanes: J(record.afterResume.a.map((l) => [l.id, l.status])) === J(finalA.map((l) => [l.id, l.status])) && record.afterResume.a.every((l) => l.status !== "running"),
  } : { controllableLanesRendered: HOST, laneStoppedThroughItsControl: HOST, stopTouchesOnlyThatLane: HOST, finishedLaneControlsBounded: HOST };
  record.measures = { maxRunningA: maxA, maxRunningB: maxB, maxRunningAcrossThreads: maxBoth, maxSleepProcesses: Math.max(0, ...samples.map((x) => x.sleeps.all)), maxSleepsA: Math.max(0, ...samples.map((x) => x.sleeps.A)), maxSleepsB: Math.max(0, ...samples.map((x) => x.sleeps.B)), stoppedLaneStatus: stoppedAfter?.status ?? null };
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 1000);
  if (error?.appOutput) record.appOutput = error.appOutput;
} finally {
  if (inst) {
    record.consoleErrors = inst.app.errors.slice(0, 20);
    record.stopApp = await inst.stop();
  }
}
record.limits = [
  "How many lanes run at once is the model's choice; the prompts ask for parallel children and the samples say what the host did.",
  "Engine session store and Keychain shared with the user (ADR 0003 amendment).",
];
record.passed = !record.failure && Object.values(record.verdicts ?? {}).every((v) => v === true) && Object.values(record.controllableLaneCriteria ?? {}).every((v) => v === true) && record.stopApp?.leftAfterQuit?.length === 0;
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, verdicts: out.verdicts, controllable: out.controllableLaneCriteria, measures: out.measures, failure: out.failure }, null, 2));
process.exit(out.passed ? 0 : 1);
