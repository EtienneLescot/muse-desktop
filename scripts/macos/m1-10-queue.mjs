#!/usr/bin/env node
/**
 * M1-10 native macOS proof: redirect an execution or queue it.
 *
 * The plan's acceptance (two pending messages, removing the second, a restart,
 * order verified in the engine) and the Windows pieces (removal while the first
 * turn runs, no removed turn ever starting; queue restored and resumed in order
 * after a brutal kill), in isolated instances on the pinned engine.
 *
 * Phase "live" (one instance): a long first turn; while it runs, Guide (steer)
 * asks it to end with STEERED-<id>; two messages are queued (A, B) with a real
 * Enter; B (the second) is removed with its button. The first turn must end
 * with the steered token, A must then start on its own and answer, B never.
 *
 * Phase "restart": a long first turn, two messages queued (A2, B2), SIGKILL on
 * the app process mid-turn, relaunch on the same data folder (same WKWebView
 * store): the stored queue and what the app does with it after the restart.
 *
 *   node scripts/macos/m1-10-queue.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9444] [--base $TMPDIR/muse-proofs-g4/m1-10] [--out docs/evidence/2026-10-13-macos-closure/m1-10-queue-macos.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { INSTALL_IPC_TRACE } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { platform, proc, redactPaths, sameAlive } from "./m1-05-terminal-lib.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9444"));
const ID = Date.now().toString(36).toUpperCase();
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `m1-10-${ID.toLowerCase()}`)));
const OUT = argValue("--out", null);
const PHASES = (argValue("--phases", "live,restart")).split(",");
const LONG = (n) => `Count slowly from one to ${n}, one number per line, nothing else. Take your time.`;

const record = {
  schema: "muse-desktop.m1-10-queue-macos.v1",
  ticket: "M1-10",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m1-10-queue.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  isolation: [],
  method: "Isolated instances on the pinned engine, one project folder per phase under the proof's temp folder. Every message is typed in the real composer (Input.insertText) and sent with a real Enter; Guide and Remove from queue are clicked in the page. The running state is the conversation's status dot (data-running); queue rows are the 'Queued messages' panel; the stored queue is localStorage muse-desktop.queued-turns.v1; replies are read from the stored transcript and the screen. The restart phase kills the app process alone with SIGKILL mid-turn (the engine child is left to its own fate and recorded), then relaunches the same exe on the same data folder.",
  checks: {},
  verdicts: {},
  limits: [],
};
const check = (name, data) => {
  record.checks[name] = data;
  console.error(`- ${name}: ${JSON.stringify(data).slice(0, 360)}`);
};

const running = (app) => app.ev("document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'");
const queueRows = (app) => app.ev("[...document.querySelectorAll('.queued-turn')].map((n) => ({ text: n.querySelector('.queued-turn-text')?.textContent ?? '', recovered: n.classList.contains('queued-turn-recovered'), button: n.querySelector('button')?.innerText.trim() ?? null }))");
const storedQueue = (app) => app.ev("(() => { try { return JSON.parse(localStorage.getItem('muse-desktop.queued-turns.v1') || 'null'); } catch { return 'unreadable'; } })()");
const sendCalls = (app) => app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input' || c.cmd === 'steer_input' || c.cmd === 'unqueue_turn').map((c) => ({ cmd: c.cmd, ok: c.ok, text: String(c.args?.text ?? '').slice(0, 60), result: String(c.result ?? '').slice(0, 200) }))");
const assistantWith = async (app, sid, token) => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(token));

/** Types `text` in the conversation composer and presses a real Enter. */
async function composerSend(app, text) {
  await app.ev("(document.querySelector('textarea[aria-label=\"Message Muse\"]').focus(), true)");
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`document.querySelector('textarea[aria-label="Message Muse"]').value === ${JSON.stringify(text)}`), 5_000, 50);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  return waitFor(() => app.ev("document.querySelector('textarea[aria-label=\"Message Muse\"]').value === ''"), 10_000, 100);
}

function project(name) {
  const dir = join(BASE, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "M1-10 proof project\n");
  return dir;
}

async function startLong(app, dir, n) {
  const ready = await newProjectConversation(app, dir);
  if (ready !== "ready") throw new Error(`welcome flow: ${ready}`);
  const sid = await sendFirstMessage(app, LONG(n));
  if (!sid) throw new Error("start_session failed");
  record.liveTurns += 1;
  const started = await waitFor(() => running(app), 60_000, 250);
  await sleep(3_000);
  return { sid, started: Boolean(started), stillRunningAfter3s: await running(app) };
}

// ---- phase live --------------------------------------------------------------
async function phaseLive() {
  const dir = project("project-live");
  const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data-live") });
  record.engine = inst.engineVersion;
  record.isolation.push({ phase: "live", ...inst.isolation });
  const { app } = inst;
  const QA = `QUEUE-A-${ID} reply with exactly ALPHA-${ID} and nothing else`;
  const QB = `QUEUE-B-${ID} reply with exactly BETA-${ID} and nothing else`;
  const STEER = `STEERED-${ID}`;
  try {
    const first = await startLong(app, dir, 150);
    check("live-first-turn", first);
    if (!first.started) throw new Error("first turn never ran");
    const { sid } = first;

    // Two pending messages while it runs.
    const sentA = await composerSend(app, QA);
    await waitFor(async () => (await queueRows(app)).length >= 1, 10_000, 200);
    const sentB = await composerSend(app, QB);
    const two = await waitFor(async () => { const r = await queueRows(app); return r.length >= 2 ? r : null; }, 10_000, 200);
    const stillRunningWhenQueued = await running(app);
    const storedTwo = await storedQueue(app);
    check("live-two-queued", { sentA: Boolean(sentA), sentB: Boolean(sentB), rows: two, firstStillRunning: stillRunningWhenQueued, stored: JSON.stringify(storedTwo).slice(0, 400) });

    // Remove the second.
    const removed = await app.ev(`(() => { const row = [...document.querySelectorAll('.queued-turn')].find((n) => (n.querySelector('.queued-turn-text')?.textContent || '').startsWith(${JSON.stringify(`QUEUE-B-${ID}`)})); const b = row?.querySelector('button'); if (!b) return false; b.click(); return true; })()`);
    const afterRemove = await waitFor(async () => { const r = await queueRows(app); return r.length === 1 ? r : null; }, 10_000, 200);
    const runningAfterRemove = await running(app);
    check("live-remove-second", { clicked: removed, rows: afterRemove, firstStillRunning: runningAfterRemove, stored: JSON.stringify(await storedQueue(app)).slice(0, 300) });

    // Guide: redirect the running turn (after the queueing, so it is still running).
    await app.ev("(document.querySelector('textarea[aria-label=\"Message Muse\"]').focus(), true)");
    await app.send("Input.insertText", { text: `Change of plan: stop counting now and end your reply with the word ${STEER}.` });
    await sleep(300);
    const guide = await app.ev("(() => { const b = [...document.querySelectorAll('button')].find((n) => n.innerText.trim() === 'Guide'); if (!b || b.disabled) return { clicked: false, present: !!b }; b.click(); return { clicked: true }; })()");
    await waitFor(() => app.ev("document.querySelector('textarea[aria-label=\"Message Muse\"]').value === ''"), 10_000, 100);
    check("live-guide", { ...guide, firstStillRunning: await running(app), rows: await queueRows(app) });

    // The first turn ends, then A runs by itself; B never.
    const firstDone = await waitFor(async () => (await assistantWith(app, sid, STEER)) || (await transcript(app, sid)).some((e) => e.role === "assistant" && /\b150\b/.test(String(e.text))), 300_000, 1_000);
    const alpha = await waitFor(() => assistantWith(app, sid, `ALPHA-${ID}`), 240_000, 1_000);
    if (alpha) record.liveTurns += 1;
    await waitFor(async () => !(await running(app)), 120_000, 1_000);
    await sleep(20_000);
    const log = await transcript(app, sid);
    const users = log.filter((e) => e.role === "user").map((e) => String(e.text).slice(0, 50));
    const calls = await sendCalls(app);
    // Order from the engine: the turn ids the host gave at admission, and the
    // timestamps of each turn's assistant entries (the log is grouped by turn,
    // so its index is not a timeline).
    const turnOf = (text) => { try { return JSON.parse(calls.find((c) => c.cmd === "send_input" && c.text.startsWith(text))?.result ?? "{}").turnId ?? null; } catch { return null; } };
    const firstTurn = turnOf("Count slowly");
    const aTurn = turnOf(`QUEUE-A-${ID}`);
    const bTurn = turnOf(`QUEUE-B-${ID}`);
    const span = (turnId) => { const ts = log.filter((e) => e.role === "assistant" && e.turnId === turnId).map((e) => e.ts); return ts.length ? { first: Math.min(...ts), last: Math.max(...ts), entries: ts.length } : null; };
    const firstSpan = span(firstTurn);
    const aSpan = span(aTurn);
    const steered = log.find((e) => e.role === "assistant" && String(e.text).includes(STEER)) ?? null;
    const alphaEntry = log.find((e) => e.role === "assistant" && String(e.text).includes(`ALPHA-${ID}`)) ?? null;
    const betaAnswered = log.some((e) => e.role === "assistant" && (String(e.text).includes(`BETA-${ID}`) || (bTurn && e.turnId === bTurn)));
    const lastNumber = Math.max(0, ...log.filter((e) => e.role === "assistant" && e.turnId === firstTurn).flatMap((e) => [...String(e.text).matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]))));
    check("live-outcome", {
      turnIds: { first: firstTurn, a: aTurn, b: bTurn },
      firstTurnSpan: firstSpan, aTurnSpan: aSpan,
      steeredTokenInFirstTurn: steered ? steered.turnId === firstTurn : false, firstTurnStoppedCountingAt: lastNumber,
      alphaAnswered: Boolean(alpha), alphaInATurn: alphaEntry ? alphaEntry.turnId === aTurn : false,
      aStartedAfterFirstEnded: Boolean(firstSpan && aSpan && aSpan.first >= firstSpan.last),
      betaAnswered, queueRowsAtEnd: (await queueRows(app)).length, storedAtEnd: JSON.stringify(await storedQueue(app)).slice(0, 200),
      userEntries: users, ipc: calls,
      assistantEntries: log.filter((e) => e.role === "assistant").map((e) => `${e.turnId === firstTurn ? "first" : e.turnId === aTurn ? "A" : e.turnId === bTurn ? "B" : String(e.turnId).slice(0, 8)} @${e.ts}: ${String(e.text).replace(/\s+/g, " ").slice(-60)}`),
      steeredTokenAnywhere: log.some((e) => String(e.text).includes(STEER) && e.role === "assistant"),
      betaOnScreen: await app.ev(`(document.querySelector('.session-center')?.innerText || '').includes(${JSON.stringify(`BETA-${ID}`)})`),
    });
    const steeredAt = steered && steered.turnId === firstTurn ? 0 : -1;
    const alphaAt = alphaEntry && alphaEntry.turnId === aTurn && firstSpan && aSpan && aSpan.first >= firstSpan.last ? 1 : -1;
    // Informational (Guide is not in the plan's acceptance; not counted in all).
    record.informational = { guideRedirectsRunningTurn: Boolean(guide.clicked && steeredAt >= 0 && lastNumber < 150) };
    record.verdicts.twoQueuedWhileRunning = Boolean(two?.length === 2 && two[0].text.startsWith(`QUEUE-A-${ID}`) && two[1].text.startsWith(`QUEUE-B-${ID}`) && stillRunningWhenQueued);
    record.verdicts.secondRemovedWhileRunning = Boolean(removed && afterRemove?.length === 1 && afterRemove[0].text.startsWith(`QUEUE-A-${ID}`) && runningAfterRemove && calls.some((c) => c.cmd === "unqueue_turn" && c.ok));
    record.verdicts.removedNeverRuns = !betaAnswered;
    record.verdicts.remainingRunsAfterFirstInOrder = Boolean(alpha && alphaAt === 1);
  } catch (error) {
    record.failure = `live: ${String(error?.stack ?? error).slice(0, 600)}`;
  } finally {
    record.checks["live-stop"] = await inst.stop();
  }
}

// ---- phase restart -------------------------------------------------------------
async function phaseRestart() {
  const dir = project("project-restart");
  const data = join(BASE, "data-restart");
  const QA = `RESTORE-A-${ID} reply with exactly ALPHA2-${ID} and nothing else`;
  const QB = `RESTORE-B-${ID} reply with exactly BETA2-${ID} and nothing else`;
  let inst = await launch({ exe: EXE, port: PORT, data });
  record.isolation.push({ phase: "restart (first launch)", ...inst.isolation });
  let sid = null;
  try {
    const first = await startLong(inst.app, dir, 400);
    sid = first.sid;
    await composerSend(inst.app, QA);
    await waitFor(async () => (await queueRows(inst.app)).length >= 1, 10_000, 200);
    await composerSend(inst.app, QB);
    const two = await waitFor(async () => { const r = await queueRows(inst.app); return r.length >= 2 ? r : null; }, 10_000, 200);
    const stored = await storedQueue(inst.app);
    const stillRunning = await running(inst.app);
    const engines = processTree(inst.pid).filter((p) => /muse-bin/.test(p.command)).map((p) => proc(p.pid));
    check("restart-before-kill", { firstTurn: first, rows: two, firstStillRunning: stillRunning, stored: JSON.stringify(stored).slice(0, 400) });
    // Brutal kill of the app process alone, mid-turn.
    process.kill(inst.pid, "SIGKILL");
    await waitFor(() => inst.child.exitCode !== null || inst.child.signalCode !== null, 10_000, 100);
    await sleep(3_000);
    const enginesAfterKill = engines.map((p) => ({ command: p.command.slice(0, 80), aliveAfter3s: sameAlive(p) }));
    const stop1 = await inst.stop({ keepStore: true });
    check("restart-kill", { signal: inst.child.signalCode, enginesAfterKill, stop: stop1 });
    record.verdicts.queueStoredBeforeKill = Boolean(two?.length === 2 && JSON.stringify(stored).includes(`RESTORE-A-${ID}`) && JSON.stringify(stored).includes(`RESTORE-B-${ID}`) && stillRunning);
  } catch (error) {
    record.failure = `restart (first launch): ${String(error?.stack ?? error).slice(0, 600)}`;
    await inst.stop().catch(() => null);
    return;
  }

  inst = await launch({ exe: EXE, port: PORT, data });
  record.isolation.push({ phase: "restart (relaunch)", ...inst.isolation });
  const { app } = inst;
  try {
    await waitFor(() => app.ev("document.querySelectorAll('li.session-item').length > 0"), 60_000, 500);
    await app.ev(INSTALL_IPC_TRACE);
    const storedAtRelaunch = await storedQueue(app);
    await app.ev(`(document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select')?.click(), true)`);
    await waitFor(() => app.ev(`document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${JSON.stringify(sid)}`), 15_000, 200);
    // A timeline from the relaunch on, without any click: queue rows, the
    // stored queue, the running state and the log (rebuilt from the host's
    // history), every change kept.
    const ids = (() => { try { return (storedAtRelaunch[sid] ?? []).map((r) => r.turn_id); } catch { return []; } })();
    const [aId, bId] = ids;
    const timeline = [];
    let last = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const log = await transcript(app, sid);
      const snap = {
        rows: (await queueRows(app)).map((r) => `${r.text.slice(0, 18)}${r.recovered ? " [recovered: " + r.button + "]" : ""}`),
        stored: ((await storedQueue(app))?.[sid] ?? []).map((r) => (r.turn_id === aId ? "A" : r.turn_id === bId ? "B" : r.turn_id.slice(0, 8))),
        running: await running(app),
        log: log.map((e) => `${e.role}${e.turnId === aId ? "(A)" : e.turnId === bId ? "(B)" : ""}: ${String(e.text).replace(/\s+/g, " ").slice(0, 46)}`),
      };
      const key = JSON.stringify(snap);
      if (key !== last) { timeline.push({ atMs: Date.now() - t0, ...snap }); last = key; }
      if (await assistantWith(app, sid, `BETA2-${ID}`)) break;
      await sleep(500);
    }
    const log = await transcript(app, sid);
    const alpha = log.find((e) => e.role === "assistant" && String(e.text).includes(`ALPHA2-${ID}`)) ?? null;
    const beta = log.find((e) => e.role === "assistant" && String(e.text).includes(`BETA2-${ID}`)) ?? null;
    const alphaCount = log.filter((e) => e.role === "assistant" && String(e.text).includes(`ALPHA2-${ID}`)).length;
    const betaCount = log.filter((e) => e.role === "assistant" && String(e.text).includes(`BETA2-${ID}`)).length;
    if (alpha) record.liveTurns += 1;
    if (beta) record.liveTurns += 1;
    check("restart-relaunch", {
      storedAtRelaunch: (storedAtRelaunch?.[sid] ?? []).map((r) => r.text.slice(0, 20)),
      timeline,
      alphaAnswered: Boolean(alpha), betaAnswered: Boolean(beta), alphaCount, betaCount,
      ipc: await sendCalls(app),
    });
    record.verdicts.queueSurvivesKill = JSON.stringify(storedAtRelaunch).includes(`RESTORE-A-${ID}`) && JSON.stringify(storedAtRelaunch).includes(`RESTORE-B-${ID}`);
    record.verdicts.queueResumesInOrderAfterRestart = Boolean(alpha && beta && alpha.ts < beta.ts && alphaCount === 1 && betaCount === 1);
  } catch (error) {
    record.failure = `restart (relaunch): ${String(error?.stack ?? error).slice(0, 600)}`;
  } finally {
    record.consoleErrors = app.errors.slice(0, 20);
    record.checks["restart-stop"] = await inst.stop();
  }
}

if (PHASES.includes("live")) await phaseLive();
if (PHASES.includes("restart")) await phaseRestart();
const stops = Object.entries(record.checks).filter(([k]) => /stop$/.test(k)).map(([, v]) => v);
record.verdicts.noProcessLeft = stops.every((s) => s.leftAfterQuit?.length === 0);
record.verdicts.isolationKept = stops.every((s) => s.defaultStoresUnchangedAtEnd === true && s.testStoreDeleted === true);
record.verdicts.all = !record.failure && Object.entries(record.verdicts).every(([, v]) => v === true);
const out = redactPaths([[BASE, "<proof>"]])(record);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
}
console.log(JSON.stringify(out.verdicts, null, 2));
if (record.failure) console.error(record.failure);
process.exit(record.verdicts.all ? 0 : 1);
