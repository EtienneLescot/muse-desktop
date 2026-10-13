#!/usr/bin/env node
/**
 * M3-08 native macOS proof: review the results of scheduled runs, on the
 * in-app scheduler of the isolated instance (test mode skips the launchd
 * wake-up task; the wake-up itself is M3-06/07, not proved here).
 *
 * Plan acceptance (docs/plans/2026-09-15-agent-implementation-plan.md §M3-08):
 * no result presented before termination, a durable history and opening the
 * right session after a restart. The model of scripts/cdp-m3-07-08-runs.mjs
 * (Windows ☑, 05/10/2026), reduced to two live turns:
 *
 *   setup     default folder <proof>/ws, posture "Ask only for more access"
 *             (as on Windows); the scheduler's state read on Automations.
 *   new       1 turn. A Once automation -> New conversation, fired by the
 *             scheduler with no click; sampled every 250 ms (ledger and card):
 *             no preview before the host's terminal for the run's own turn;
 *             then status, preview, summary and unread, three ways (renderer
 *             ledger, native mirror, card).
 *   stop      1 turn, stopped. A run S (Run on its schedule), its turn stopped
 *             from the conversation's composer -> Cancelled, no preview.
 *   review    Open conversation (N): its own session, its answer on screen;
 *             Mark read (N); Archive then Restore (S).
 *   restart   the app closed from its window, the WKWebView store and the data
 *             folder kept, relaunched on them: every run field-identical in the
 *             ledger and the native mirror, N's card rebuilt, Open conversation
 *             opens N's session with its answer.
 *
 *   node scripts/macos/m3-08-run-review.mjs [--exe <muse-desktop>] [--port 9467]
 *     [--base $TMPDIR/muse-proofs-g6/m3-08] [--out docs/evidence/2026-10-13-macos-closure/m3-08-run-review.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, H, J, compareStamps, installTrace, pickDefaultFolder, platform, processesMentioning, redactorFor,
  setPosture, sleep, userEngineStamp, waitFor, writeRecord,
} from "./m3-g6-common.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9467"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-08"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-08-run-review.json");
const DATA = join(BASE, "data");
const WS = join(BASE, "ws");
const redact = redactorFor(BASE);
const STOPPED = "^(completed|cancelled|stopped|interrupted|failed|failure|error|retracted|aborted|host_exited)$";
mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, "README.md"), "M3-08 macOS proof folder: nothing to change here.\n");

const R = `${H}
  const runs = () => store('muse-desktop.schedule-runs.v1', '[]') || [];
  const runOf = (name) => runs().filter((r) => r.scheduleName === name).pop() || null;
  const schedules = () => store('muse-desktop.schedules.v1', '[]') || [];
  const schedOf = (name) => schedules().find((s) => s.name === name) || null;
  const schedItem = (name) => [...document.querySelectorAll('li.sched-item:not(.schedule-run)')]
    .filter((li) => (li.querySelector('.sched-head strong')?.textContent || '').trim() === name);
  const runItem = (name) => [...document.querySelectorAll('li.schedule-run')]
    .find((li) => (li.querySelector('.sched-head strong')?.textContent || '').trim() === name) || null;
  const runCard = (name) => {
    const li = runItem(name);
    if (!li) return null;
    return {
      status: li.querySelector('.run-status')?.textContent.trim() ?? null,
      newBadge: Boolean(li.querySelector('.sched-head .run-unread')),
      reviewNeeded: Boolean(li.querySelector('.run-recovery')),
      preview: li.querySelector(':scope > .run-preview')?.textContent.trim() ?? null,
      summaryHeadline: li.querySelector('.run-summary > strong')?.textContent.trim() ?? null,
      summaryFacts: li.querySelector('.run-summary-facts')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      nextStepsObserved: [...li.querySelectorAll('.run-summary-next li')].map((n) => n.textContent.trim()),
      error: li.querySelector(':scope > small.error')?.textContent.trim() ?? null,
      actions: [...li.querySelectorAll('.sched-actions button')].map((b) => b.textContent.trim()),
    };
  };
  const runAction = (name, label) => {
    const li = runItem(name);
    const b = li ? [...li.querySelectorAll('.sched-actions button')].find((n) => n.textContent.trim() === label && !n.disabled) : null;
    if (b) b.click();
    return !!b;
  };
  const runFilter = (value) => { const sel = document.querySelector('select[aria-label="Filter automation runs"]'); if (!sel) return false; setValue(sel, value); return sel.value === value; };
  const onTask = () => !document.querySelector('section.schedules') && Boolean(document.querySelector('textarea[aria-label="Message Muse"]'));
  const taskSid = () => onTask() ? (document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || store('muse-desktop.active.v1', 'null')) : null;
  const transcriptHas = (needle) => onTask() && (document.querySelector('.session-view .stream')?.innerText || document.querySelector('.session-center')?.innerText || '').includes(needle);
`;
const page = (body) => `(async () => { ${R} ${body} })()`;

/** The host's turn events (poll_events) and the run-relevant commands, on top of INSTALL_IPC_TRACE. */
const RUNS_TRACE = `(() => {
  const KEEP = new Set(['send_input', 'start_session', 'cancel_session', 'scheduler_wakeup_sync']);
  const STOPPED = new RegExp(${J(STOPPED)});
  if (window.__runsTrace && window.__runsTrace.installed) return 'present';
  const state = window.__runsTrace = { installed: true, events: [], calls: [] };
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/([^/?#]+)/);
    const cmd = match ? decodeURIComponent(match[1]) : null;
    const response = await inner(input, init);
    if (cmd === 'poll_events') {
      try {
        const body = JSON.parse(await response.clone().text());
        for (const e of (body && body.events) || []) {
          const kind = String(e.kind);
          if (!(kind === 'started' || kind.startsWith('turn/') || STOPPED.test(kind))) continue;
          let p = null;
          try { p = JSON.parse(e.payload); } catch { p = null; }
          const obj = p && typeof p === 'object' ? p : {};
          state.events.push({ at: Date.now(), sid: e.session_id, kind, turnId: obj.turnId || obj.turn_id || null, terminal: obj.terminal || null,
            previewKeys: ['result', 'resultPreview', 'output', 'summary', 'text'].filter((k) => k in obj) });
          if (state.events.length > 500) state.events.shift();
        }
      } catch { /* unreadable poll */ }
    } else if (cmd && KEEP.has(cmd)) {
      let args = null;
      try { args = JSON.parse(init && init.body); } catch { args = null; }
      let result = null;
      try { result = (await response.clone().text()).slice(0, 1500); } catch { result = null; }
      state.calls.push({ at: Date.now(), cmd, args, ok: response.headers.get('Tauri-Response') === 'ok', result });
    }
    return response;
  };
  return 'installed';
})()`;
async function install(app) {
  await installTrace(app);
  return app.ev(RUNS_TRACE);
}

const rowFacts = `(r) => r && ({
  id: r.id, status: r.status, turnId: r.turnId ?? null, sessionId: r.sessionId ?? null,
  threadReuse: r.threadReuse?.kind ?? null, attempt: r.attempt ?? 1, unread: r.unread ?? null,
  archived: r.archived ?? null, recovery: r.recovery ?? null, occurrenceAt: r.occurrenceAt,
  createdAt: r.createdAt, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
  resultPreview: r.resultPreview ?? null,
  summary: r.resultSummary ? { headline: r.resultSummary.headline, assistantMessages: r.resultSummary.assistantMessages, nextSteps: r.resultSummary.nextSteps ?? [] } : null,
  error: r.error ?? null })`;
async function readRun(app, name, { card = true } = {}) {
  return app.ev(page(`
    const facts = ${rowFacts};
    const local = facts(runOf(${J(name)}));
    let native = null;
    try {
      const mirror = await window.__TAURI_INTERNALS__.invoke('scheduler_runs_read');
      const rows = Array.isArray(mirror?.runs) ? mirror.runs.filter((r) => r.scheduleName === ${J(name)}) : [];
      native = facts(rows.pop() || null);
    } catch (error) { native = { readError: String(error).slice(0, 120) }; }
    return { local, native, card: ${card ? `runCard(${J(name)})` : "null"} };
  `));
}
const events = (app, sid) => app.ev(`(window.__runsTrace?.events || []).filter((e) => e.sid === ${J(sid)})`);
const calls = (app, cmd) => app.ev(`(window.__runsTrace?.calls || []).filter((c) => c.cmd === ${J(cmd)})`);
const terminalOf = (list, turnId) => list.find((e) => e.turnId === turnId && new RegExp(STOPPED).test(e.kind)) ?? null;
async function sendAck(app, sid, text, timeoutMs = 30_000) {
  const call = await waitFor(async () => (await calls(app, "send_input")).filter((c) => c.args?.sessionId === sid && c.args?.text === text && c.result !== null).pop() ?? null, timeoutMs, 250);
  if (!call) return null;
  try { const v = JSON.parse(call.result); return { at: call.at, ok: call.ok, disposition: v?.disposition ?? null, turnId: v?.turnId ?? null }; } catch { return { at: call.at, ok: call.ok }; }
}
async function automations(app) {
  await app.ev(page("nav('Automations'); await pause(700); return Boolean(document.querySelector('section.schedules'));"));
}
function localDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
async function createSchedule(app, { name, instructions, at, reuse }) {
  await automations(app);
  const created = await app.ev(page(`
    const f = (s) => document.querySelector(s);
    setValue(f('input[aria-label="Automation name"]'), ${J(name)});
    setValue(f('textarea[aria-label="Instructions"]'), ${J(instructions)});
    setValue(f('select[aria-label="Frequency"]'), 'once');
    await pause(200);
    setValue(f('input[aria-label="Date and time"]'), ${J(at)});
    setValue(f('select[aria-label="Target conversation"]'), ${J(reuse)});
    await pause(300);
    const create = button('Create automation');
    if (!create) return { ok: false, why: 'no create button' };
    create.click();
    await pause(800);
    const s = schedOf(${J(name)});
    if (!s) return { ok: false, why: 'not stored', formError: text(f('.sched-form .error')) };
    return { ok: true, threadReuse: s.threadReuse.kind, authorizationMode: s.authorizationMode ?? null, workspaceIsWs: s.workspace === ${J(WS)} || (s.workspace || '').endsWith('/ws'),
      triggerAt: s.trigger.at, timeZone: s.timeZone ?? null };
  `));
  if (!created.ok) throw new Error(`schedule ${name} not created: ${J(created)}`);
  return created;
}
async function sampleRun(app, name, until, timeoutMs, everyMs = 250) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await app.ev(page(`
      const r = runOf(${J(name)});
      const c = runCard(${J(name)});
      return { at: Date.now(), status: r?.status ?? null, turnId: r?.turnId ?? null, preview: r?.resultPreview ?? null, summary: r?.resultSummary?.headline ?? null,
        cardStatus: c?.status ?? null, cardPreview: c?.preview ?? null };
    `));
    const last = samples.at(-1);
    if (!last || last.status !== s.status || last.preview !== s.preview || last.cardStatus !== s.cardStatus || last.cardPreview !== s.cardPreview || last.turnId !== s.turnId) samples.push(s);
    if (until(s)) return { done: true, samples };
    await sleep(everyMs);
  }
  return { done: false, samples };
}
const rel = (t0, list) => list.map((x) => ({ ...x, at: x.at - t0 }));

const record = {
  schema: "muse-desktop.macos-m3-08-run-review.v1",
  ticket: "M3-08",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-08-run-review.mjs on scripts/macos/test-instance.mjs (model: scripts/cdp-m3-07-08-runs.mjs)",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-08 (no result presented before termination, a durable history and opening the right session after a restart) and docs/ROADMAP.md §M3-08 (status, preview, unread, link to the conversation, archiving, filters, extractive summary with next steps, each run anchored to its own turn, cancelled recorded as such)",
  isolation: null,
  posture: "Ask only for more access (host onRequest), as on Windows; text-only prompts, no tool call expected",
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment) on the pinned engine. Test mode skips the launchd wake-up task; the in-app scheduler holds its native lease and fires the runs while the app is open.",
    "Each run is read three ways: the renderer ledger (localStorage muse-desktop.schedule-runs.v1), the native mirror (scheduler_runs_read, app data) and the card on Automations. The host's turn events are read from the event poll (IPC trace), so a run is matched to the turn the host admitted (send_input ack) and to that turn's own terminal.",
    "The restart closes the app from its window (Tauri window close), keeps the data folder and the WKWebView store, and relaunches the same exe on them.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
const names = {};
const answers = {};
try {
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  let app = inst.app;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await install(app);

  // ---- setup ------------------------------------------------------------------------
  const posture = await setPosture(app, "workspace");
  const folder = await pickDefaultFolder(app, WS);
  await automations(app);
  const scheduler = await waitFor(() => app.ev(page(`const s = document.querySelector('.scheduler-status');
    return s && s.getAttribute('data-mode') !== 'none' ? { mode: s.getAttribute('data-mode'), text: text(s.querySelector('strong')) } : null;`)), 40_000, 1_000);
  const wake = await app.ev(page("return text(document.querySelector('.scheduler-wakeup-status'));"));
  record.phases.setup = { posture, defaultFolder: folder, scheduler, wakeUp: wake };

  // ---- new: fired by the scheduler, no click (1 turn) -----------------------------------
  const t = ID.slice(-5);
  names.N = `M3-08 new ${t}`;
  answers.N = `RUN-NEW-${t}`;
  const instructionsN = `Reply with exactly these two lines and nothing else:\n${answers.N}\nNext steps: archive this run`;
  const at = new Date(Math.ceil((Date.now() + 25_000) / 60_000) * 60_000).getTime();
  const sessionsBefore = await app.ev(page("return (store('muse-desktop.sessions.v1', '[]') || []).map((s) => s.session_id);"));
  await app.ev(page("nav('New conversation'); await pause(800); return true;"));
  const createdN = await createSchedule(app, { name: names.N, instructions: instructionsN, at: localDateTime(at), reuse: "new" });
  const t0 = Date.now();
  const appear = await waitFor(() => app.ev(page(`return runOf(${J(names.N)}) ? true : null;`)), at - Date.now() + 90_000, 250);
  if (!appear) throw new Error("the scheduler never created the run");
  record.liveTurns += 1;
  const followed = await sampleRun(app, names.N, (s) => ["completed", "failed", "cancelled"].includes(s.status), 240_000);
  await sleep(1_000);
  const runN = await readRun(app, names.N);
  const sidN = runN.local?.sessionId;
  const ackN = sidN ? await sendAck(app, sidN, instructionsN, 5_000) : null;
  const evN = sidN ? await events(app, sidN) : [];
  const termN = runN.local?.turnId ? terminalOf(evN, runN.local.turnId) : null;
  const runningSamples = followed.samples.filter((s) => s.status === "running" || s.status === "queued");
  const terminalSample = termN ? followed.samples.find((s) => s.at >= termN.at) : null;
  const previewBeforeTerminal = termN ? followed.samples.filter((s) => s.at < termN.at && (s.preview !== null || s.cardPreview !== null)) : null;
  record.phases.new = { schedule: { ...createdN, scheduledInMs: at - t0 }, timeline: rel(t0, followed.samples), run: runN, sendAck: ackN && { ...ackN, at: ackN.at - t0 },
    hostEvents: rel(t0, evN), terminalAt: termN ? termN.at - t0 : null };
  record.verdicts.firedWithoutClick = runN.local?.occurrenceAt === at && runN.local?.threadReuse === "new";
  record.verdicts.newConversationAnchoredToItsTurn = Boolean(sidN) && !sessionsBefore.includes(sidN) && Boolean(ackN?.turnId) && ackN.turnId === runN.local?.turnId
    && Boolean(termN) && termN.turnId === runN.local?.turnId;
  record.verdicts.noResultBeforeTermination = runningSamples.length > 0 && runningSamples.every((s) => s.preview === null && s.cardPreview === null)
    && Array.isArray(previewBeforeTerminal) && previewBeforeTerminal.length === 0;
  record.verdicts.completedReviewable = runN.local?.status === "completed" && runN.native?.status === "completed" && runN.card?.status === "Completed"
    && (runN.local?.resultPreview ?? "").includes(answers.N) && (runN.card?.preview ?? "").includes(answers.N)
    && (runN.local?.summary?.nextSteps ?? []).includes("archive this run") && runN.local?.unread === true && runN.card?.newBadge === true
    && ["Open conversation", "Mark read", "Archive"].every((a) => runN.card?.actions.includes(a));
  record.phases.new.hostStructuredPreview = termN ? (termN.previewKeys.length > 0 ? termN.previewKeys : "none emitted by the host") : null;

  // ---- stop: a run's turn stopped from the composer (1 turn, stopped) ------------------------------
  names.S = `M3-08 stop ${t}`;
  const instructionsS = "Write a 1500-word story about a lighthouse keeper who repairs an old clock, in plain prose with no headings. Do not stop early.";
  const createdS = await createSchedule(app, { name: names.S, instructions: instructionsS, at: localDateTime(Date.now() + 24 * 3_600_000), reuse: "new" });
  const runClick = await app.ev(page(`
    const items = schedItem(${J(names.S)});
    const b = items.length === 1 ? [...items[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Run') : null;
    if (b) b.click();
    return { clicked: !!b };
  `));
  record.liveTurns += 1;
  const runningS = await waitFor(async () => { const r = await readRun(app, names.S, { card: false }); return r.local?.status === "running" && r.local?.sessionId ? r : null; }, 90_000, 300);
  const sidS = runningS?.local?.sessionId;
  const ackS = sidS ? await sendAck(app, sidS, instructionsS, 20_000) : null;
  await waitFor(async () => (await events(app, sidS)).find((e) => e.kind === "started") ?? null, 60_000, 250);
  await app.ev(page(`runFilter('all'); await pause(200); return runAction(${J(names.S)}, 'Open conversation');`));
  await waitFor(() => app.ev(page(`return taskSid() === ${J(sidS)};`)), 15_000, 250);
  await sleep(2_500);
  const stopClick = await app.ev(page(`
    const b = q('button').find((n) => (n.innerText || '').trim() === 'Stop' && !n.disabled && !/subagent/i.test(n.getAttribute('title') || ''));
    if (b) b.click();
    return { clicked: !!b };
  `));
  const stopAt = Date.now();
  const termS = await waitFor(async () => terminalOf(await events(app, sidS), ackS?.turnId), 60_000, 250);
  await sleep(1_500);
  await automations(app);
  await app.ev(page("runFilter('all'); return true;"));
  await sleep(500);
  const finalS = await readRun(app, names.S);
  const cancel = (await calls(app, "cancel_session")).at(-1) ?? null;
  record.phases.stop = { schedule: createdS, runClick, whileRunning: runningS?.local ?? null, sendAck: ackS && { ok: ackS.ok, disposition: ackS.disposition, turnId: ackS.turnId },
    stopClick: { ...stopClick, msAfterRunStart: runningS?.local?.startedAt ? stopAt - runningS.local.startedAt : null },
    cancelCall: cancel && { ok: cancel.ok, carriedTurnId: J(cancel.args ?? {}).includes(ackS?.turnId ?? "~") },
    terminal: termS && { kind: termS.kind, terminal: termS.terminal, turnId: termS.turnId }, final: finalS };
  // The run's turn id lands right after the send_input ack: compared on the settled row.
  record.verdicts.stoppedRunCancelledWithoutResult = runClick.clicked && Boolean(ackS?.turnId) && finalS.local?.turnId === ackS.turnId && stopClick.clicked && Boolean(termS)
    && record.phases.stop.cancelCall?.carriedTurnId === true
    && finalS.local?.status === "cancelled" && finalS.native?.status === "cancelled" && finalS.card?.status === "Cancelled"
    && finalS.local?.resultPreview === null && finalS.card?.preview === null && (finalS.local?.finishedAt ?? 0) >= stopAt - 1_000;

  // ---- review actions ----------------------------------------------------------------------
  const review = {};
  await automations(app);
  review.open = { clicked: await app.ev(page(`runFilter('all'); await pause(250); return runAction(${J(names.N)}, 'Open conversation');`)) };
  review.open.activeIsRunSession = Boolean(await waitFor(() => app.ev(page(`return taskSid() === ${J(sidN)} && transcriptHas(${J(answers.N)}) ? true : null;`)), 15_000, 250));
  await automations(app);
  review.markRead = { clicked: await app.ev(page(`runFilter('all'); await pause(250); return runAction(${J(names.N)}, 'Mark read');`)) };
  await sleep(1_000);
  review.markRead.N = await readRun(app, names.N);
  review.markRead.unreadFilterHasN = await app.ev(page(`runFilter('unread'); await pause(300); const has = Boolean(runItem(${J(names.N)})); runFilter('all'); return has;`));
  review.archive = { clicked: await app.ev(page(`runFilter('all'); await pause(250); return runAction(${J(names.S)}, 'Archive');`)) };
  await sleep(1_000);
  review.archive.S = await readRun(app, names.S, { card: false });
  review.archive.inActive = await app.ev(page(`runFilter('all'); await pause(300); return Boolean(runItem(${J(names.S)}));`));
  review.archive.inArchived = await app.ev(page(`runFilter('archived'); await pause(300); const c = runCard(${J(names.S)}); return c ? { status: c.status, actions: c.actions } : null;`));
  review.restore = { clicked: await app.ev(page(`return runAction(${J(names.S)}, 'Restore');`)) };
  await sleep(1_000);
  review.restore.S = (await readRun(app, names.S, { card: false })).local;
  review.restore.inActive = await app.ev(page(`runFilter('all'); await pause(300); return Boolean(runItem(${J(names.S)}));`));
  record.phases.review = review;
  record.verdicts.openConversationIsRunSession = review.open.clicked && review.open.activeIsRunSession;
  record.verdicts.markRead = review.markRead.clicked && review.markRead.N.local?.unread === false && review.markRead.N.native?.unread === false
    && review.markRead.N.card?.newBadge === false && review.markRead.unreadFilterHasN === false && review.markRead.N.local?.status === "completed";
  record.verdicts.archiveRestore = review.archive.clicked && review.archive.S.local?.archived === true && review.archive.S.native?.archived === true
    && review.archive.inActive === false && Boolean(review.archive.inArchived?.actions.includes("Restore"))
    && review.restore.clicked && review.restore.S?.archived === false && review.restore.inActive === true && review.restore.S?.status === "cancelled";

  // ---- restart -------------------------------------------------------------------------------
  const before = {};
  for (const [key, name] of Object.entries(names)) before[key] = await readRun(app, name, { card: false });
  const closed = await inst.stop({ keepStore: true });
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  app = inst.app;
  await waitFor(() => app.ev("Boolean(document.querySelector('li.session-item'))"), 60_000, 1_000);
  await sleep(4_000); // the native ledger merge runs after boot
  await install(app);
  const after = {};
  for (const [key, name] of Object.entries(names)) after[key] = await readRun(app, name, { card: false });
  const keys = ["id", "status", "turnId", "sessionId", "attempt", "unread", "archived", "finishedAt", "resultPreview", "error"];
  const same = (a, b) => Boolean(a && b) && keys.every((k) => J(a[k]) === J(b[k]));
  const comparison = Object.fromEntries(Object.keys(names).map((key) => [key, {
    localUnchanged: same(before[key].local, after[key].local), nativeUnchanged: same(before[key].native, after[key].native),
    nativeEqualsLocal: same(after[key].local, after[key].native), status: after[key].local?.status ?? null, recovery: after[key].local?.recovery ?? null,
  }]));
  await automations(app);
  const cardN = await app.ev(page(`runFilter('all'); await pause(300); return runCard(${J(names.N)});`));
  const reopened = await app.ev(page(`return runAction(${J(names.N)}, 'Open conversation');`));
  const opened = await waitFor(() => app.ev(page(`return taskSid() === ${J(sidN)} && transcriptHas(${J(answers.N)}) ? true : null;`)), 20_000, 300);
  record.phases.restart = { closed: { quitBy: closed.quitBy, leftAfterQuit: closed.leftAfterQuit }, comparison, cardAfterRestart: cardN, openAfterRestart: { clicked: reopened, activeIsRunSession: Boolean(opened) } };
  record.verdicts.durableHistory = closed.quitBy === "window closed" && Object.values(comparison).every((c) => c.localUnchanged && c.nativeUnchanged && c.nativeEqualsLocal && c.recovery === null);
  record.verdicts.cardRebuiltAfterRestart = cardN?.status === "Completed" && (cardN?.preview ?? "").includes(answers.N);
  record.verdicts.rightSessionOpenedAfterRestart = reopened && Boolean(opened);
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
}
await sleep(1_000);
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;
record.verdicts.cleanExit = Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0;
record.verdicts.userEngineConfigUntouched = record.userEngineConfig.unchanged;
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.limits.push(
  "The runs fire from the in-app scheduler with the app open: test mode skips the launchd wake-up task, so a run while the app is closed (M3-06/07) is not covered here.",
  "The host-structured preview winning over the local excerpt stays unit-tested only: 1.4.2's turn/completed carries no result field (hostStructuredPreview in the new phase).",
  "Busy-thread anchoring, removal from the host queue and Retry now (Windows phases busy and retry) are shared renderer code not replayed here; this proof keeps to the plan acceptance and the review actions.",
  "The engine's session store is shared with the user (ADR 0003): the proof conversations stay there.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
