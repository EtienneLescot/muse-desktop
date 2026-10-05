#!/usr/bin/env node

/**
 * M3-08 (review run results) and M3-07 (the wake task follows schedule
 * deletion) native acceptance in the real webview, on a live 1.4.2 host.
 *
 * Every step records discriminating facts instead of panel text: the run id,
 * the turn id the host admitted (send_input ack), the host's own turn events
 * (captured on the event poll), and the run status read three ways: the
 * renderer ledger (localStorage), the native mirror (app data) and the card.
 *
 * Phases (results merge into --out, path-free):
 *   setup     no turn. Folders ws/ and retry/ under --base; the user's posture
 *             and default folder saved in the state file; posture "Approve on
 *             my behalf"; default folder <base>\ws (Settings picker, the folder
 *             dialog answered by the harness).
 *   new       1 turn. (1) Once automation -> New conversation, fired by the
 *             scheduler with no click, sampled every 250 ms: no preview before
 *             the terminal event, then preview/summary/status of that run.
 *   busy      2 turns. (2) conversation C runs a long turn A; runs R and Q are
 *             dispatched to C while A runs (the host queues both); (4) Q is
 *             removed from the host queue -> Q Cancelled; A's completion leaves
 *             R running; R settles on its own turn with its own preview.
 *   stop      1 turn, stopped. (3) run S dispatched to C, its turn stopped from
 *             the composer -> S Cancelled.
 *   retry     1 turn. (5) run T fails while its folder is gone (renamed away),
 *             the folder comes back, Retry now -> T completes.
 *   review    no turn. (5) Open conversation (N, R, T), Mark read (R), Archive
 *             then Restore (Q).
 *   restart   no turn. The app is closed from its own window control and
 *             relaunched (--exe): both ledgers keep the runs unchanged and Open
 *             conversation opens the run's own session.
 *   wake      no turn. M3-07: schtasks before/after. A new schedule W replaces
 *             the AutomationWake trigger; with the other pending schedules
 *             disabled, deleting W removes the task; re-enabling restores it.
 *   teardown  no turn. The user's posture and default folder restored; any
 *             schedule the wake phase disabled is enabled again.
 *
 * Usage:
 *   node scripts/cdp-m3-07-08-runs.mjs <phase> [--base G:\muse-proofs\runs]
 *     [--tag <suffix>] [--build pre-fix|fixed]
 *     [--exe <muse-desktop.exe>] [--pid-file <base>\app.pid]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m3-07-08-runs.json]
 * --tag stores the phase under "<phase>-<tag>" (a replay keeps the first run).
 * Launch the app first with MUSE_NO_AUTO_UPDATE=1 and
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, and write
 * its PID to the pid file (the restart phase relaunches it and updates it).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const PHASE = process.argv[2];
const TAG = argValue("--tag", null);
const KEY = [PHASE, TAG].filter(Boolean).join("-");
const BUILD = argValue("--build", "fixed");
const BASE = argValue("--base", "G:\\muse-proofs\\runs");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m3-07-08-runs.json");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const PID_FILE = argValue("--pid-file", join(BASE, "app.pid"));
const STATE = join(BASE, "harness-state.json");
// The run folder; setup records it so the later phases follow it.
const WS_NAME = argValue("--ws", readJson(STATE, {}).ws ?? "ws");
const WS = join(BASE, WS_NAME);
const RETRY = join(BASE, "retry");
const RETRY_AWAY = join(BASE, "retry-away");
const TASK = "Muse-Desktop\\AutomationWake";
const redact = redactor([[RETRY_AWAY, "<retry-away>"], [RETRY, "<retry>"], [WS, `<${WS_NAME}>`], [BASE, "<proof>"]]);

const STOPPED = "^(completed|cancelled|stopped|interrupted|failed|failure|error|retracted|aborted|host_exited)$";

/** Page helpers, evaluated inside the webview. */
const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text && !b.disabled) || null;
  const nav = (label) => { const b = document.querySelector('.primary-nav button[aria-label="' + label + '"]'); if (b) b.click(); return !!b; };
  const runs = () => store('muse-desktop.schedule-runs.v1', '[]') || [];
  const runOf = (name) => runs().filter((r) => r.scheduleName === name).pop() || null;
  const schedules = () => store('muse-desktop.schedules.v1', '[]') || [];
  const schedOf = (name) => schedules().find((s) => s.name === name) || null;
  const pendingOccurrence = (s) => s.enabled && (s.trigger.kind === 'cron' || s.lastFiredAt === undefined);
  const schedItem = (name) => [...document.querySelectorAll('li.sched-item:not(.schedule-run)')]
    .filter((li) => (li.querySelector('.sched-head strong')?.textContent || '').trim() === name);
  const runItem = (name) => [...document.querySelectorAll('li.schedule-run')]
    .find((li) => (li.querySelector('.sched-head strong')?.textContent || '').trim() === name) || null;
  const runCard = (name) => {
    const li = runItem(name);
    if (!li) return null;
    const details = {};
    for (const row of li.querySelectorAll('.run-details-grid > div')) {
      const key = row.querySelector('dt')?.textContent.trim();
      if (key && key !== 'Workspace' && key !== 'Project') details[key] = row.querySelector('dd')?.textContent.trim() ?? null;
    }
    return {
      status: li.querySelector('.run-status')?.textContent.trim() ?? null,
      dataStatus: li.getAttribute('data-status'),
      newBadge: Boolean(li.querySelector('.sched-head .run-unread')),
      reviewNeeded: Boolean(li.querySelector('.run-recovery')),
      meta: li.querySelector(':scope > span.muted')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      preview: li.querySelector(':scope > .run-preview')?.textContent.trim() ?? null,
      summaryHeadline: li.querySelector('.run-summary > strong')?.textContent.trim() ?? null,
      summaryFacts: li.querySelector('.run-summary-facts')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      nextStepsObserved: [...li.querySelectorAll('.run-summary-next li')].map((n) => n.textContent.trim()),
      error: li.querySelector(':scope > small.error')?.textContent.trim() ?? null,
      details,
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
  // The conversation page, not Automations (whose cards also quote the answers).
  const onTask = () => !document.querySelector('section.schedules') && Boolean(document.querySelector('textarea[aria-label="Message Muse"]'));
  const activeSid = () => onTask() ? (document.querySelector('li.session-item.active')?.getAttribute('data-session-id')
    || store('muse-desktop.active.v1', 'null')) : null;
  const transcriptHas = (needle) => onTask() && (document.querySelector('.session-view .stream')?.innerText || '').includes(needle);
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/**
 * Poll + command trace stacked on INSTALL_IPC_TRACE (which answers the folder
 * dialog): the host's turn events from poll_events and the commands that
 * carry run facts, with their results.
 */
const RUNS_TRACE = `(() => {
  const KEEP = new Set(['send_input', 'start_session', 'cancel_session', 'unqueue_turn', 'scheduler_wakeup_sync', 'set_workspace', 'set_approval_mode']);
  const STOPPED = new RegExp(${JSON.stringify(STOPPED)});
  if (window.__runsTrace && window.__runsTrace.installed) {
    window.__runsTrace.events = [];
    window.__runsTrace.calls = [];
    window.__runsTrace.t0 = Date.now();
    return 'reset';
  }
  const state = window.__runsTrace = { installed: true, events: [], calls: [], t0: Date.now() };
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const match = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
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
          state.events.push({ at: Date.now(), seq: e.seq, sid: e.session_id, kind,
            turnId: obj.turnId || obj.turn_id || null, terminal: obj.terminal || null,
            keys: Object.keys(obj).sort(), hasError: obj.error !== undefined && obj.error !== null,
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
      if (state.calls.length > 300) state.calls.shift();
    }
    return response;
  };
  return 'installed';
})()`;

async function install(app) {
  await app.ev(INSTALL_IPC_TRACE);
  return app.ev(RUNS_TRACE);
}

// ---- state, record, environment -----------------------------------------

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));

function engineVersion() {
  try {
    return execFileSync(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"), ["--version"],
      { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

function dirtyTrackedFiles() {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })
      .split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
  } catch { return null; }
}

function merge(phaseResult) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m3-07-08-runs.v1",
    tickets: ["M3-08", "M3-07"],
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    posture: "Approve on my behalf (host onRequest); text-only prompts, no tool call expected",
    phases: {},
  });
  record.commit = gitHead();
  record.buildTreeDirty = dirtyTrackedFiles();
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  // Any other absolute path left (a user project in a console error) goes too.
  record.phases[KEY] = JSON.parse(JSON.stringify(redact({ build: BUILD, ...phaseResult }))
    .replace(/(?<![A-Za-z])[A-Za-z]:(?:\\\\|\/)[^"]*/g, "<path>"));
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[KEY];
}

function wakeTask() {
  try {
    const xml = execFileSync("schtasks", ["/query", "/tn", TASK, "/xml"], { encoding: "utf8", stdio: "pipe" });
    const startBoundary = (xml.match(/<StartBoundary>([^<]+)<\/StartBoundary>/) ?? [])[1] ?? null;
    return {
      exists: true,
      startBoundary,
      startEpoch: startBoundary ? Date.parse(startBoundary) : null,
      wakeupArgument: /<Arguments>--automation-wakeup<\/Arguments>/.test(xml),
      commandIsMuseDesktop: /<Command>[^<]*muse-desktop\.exe<\/Command>/i.test(xml),
    };
  } catch (error) {
    return { exists: false, exitCode: error.status ?? null };
  }
}

/** Local wall clock for a datetime-local input, `minutes` from now. */
function localDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const farFuture = () => localDateTime(Date.now() + 24 * 3_600_000);
const tag = () => Date.now().toString(36).slice(-5);

// ---- page reads ----------------------------------------------------------

const rowFacts = `(r) => r && ({
  id: r.id, status: r.status, turnId: r.turnId ?? null, sessionId: r.sessionId ?? null,
  threadReuse: r.threadReuse?.kind ?? null, attempt: r.attempt ?? 1, unread: r.unread ?? null,
  archived: r.archived ?? null, recovery: r.recovery ?? null, occurrenceAt: r.occurrenceAt,
  createdAt: r.createdAt, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
  nextRetryAt: r.nextRetryAt ?? null, resultPreview: r.resultPreview ?? null,
  summary: r.resultSummary ? { headline: r.resultSummary.headline, totalItems: r.resultSummary.totalItems,
    assistantMessages: r.resultSummary.assistantMessages, toolEvents: r.resultSummary.toolEvents,
    nextSteps: r.resultSummary.nextSteps ?? [], issues: r.resultSummary.issues ?? [] } : null,
  error: r.error ?? null })`;

/** The run as stored by the renderer, by the native mirror, and as the card shows it. */
async function readRun(app, name, { card = true } = {}) {
  return app.ev(page(`
    const facts = ${rowFacts};
    const local = facts(runOf(${JSON.stringify(name)}));
    let native = null;
    try {
      const mirror = await window.__TAURI_INTERNALS__.invoke('scheduler_runs_read');
      const rows = Array.isArray(mirror?.runs) ? mirror.runs.filter((r) => r.scheduleName === ${JSON.stringify(name)}) : [];
      native = facts(rows.pop() || null);
    } catch (error) { native = { readError: String(error).slice(0, 120) }; }
    return { local, native, card: ${card ? `runCard(${JSON.stringify(name)})` : "null"} };
  `));
}

const events = (app, sid) => app.ev(`(window.__runsTrace?.events || []).filter((e) => e.sid === ${JSON.stringify(sid)})`);
const calls = (app, cmd) => app.ev(`(window.__runsTrace?.calls || []).filter((c) => c.cmd === ${JSON.stringify(cmd)})`);

function ackOf(call) {
  try {
    const value = JSON.parse(call.result);
    return { ok: call.ok, disposition: value?.disposition ?? null, turnId: value?.turnId ?? null };
  } catch { return { ok: call?.ok ?? false, raw: call?.result?.slice(0, 200) ?? null }; }
}

/** The send_input ack for a given outgoing text in a session. */
async function sendAck(app, sid, text, timeoutMs = 30_000) {
  const call = await waitFor(async () => (await calls(app, "send_input"))
    .filter((c) => c.args?.sessionId === sid && c.args?.text === text && c.result !== null).pop() ?? null, timeoutMs, 250);
  return call ? { at: call.at, ...ackOf(call) } : null;
}

const terminalOf = (list, turnId) => list.find((e) => e.turnId === turnId && new RegExp(STOPPED).test(e.kind)) ?? null;

// ---- page actions --------------------------------------------------------

async function automations(app) {
  await app.ev(page("nav('Automations'); await pause(700); return Boolean(document.querySelector('section.schedules'));"));
}

async function createSchedule(app, { name, instructions, at, reuse, sessionId = "" }) {
  await automations(app);
  const created = await app.ev(page(`
    const f = (s) => document.querySelector(s);
    setValue(f('input[aria-label="Automation name"]'), ${JSON.stringify(name)});
    setValue(f('textarea[aria-label="Instructions"]'), ${JSON.stringify(instructions)});
    setValue(f('select[aria-label="Frequency"]'), 'once');
    await pause(200);
    setValue(f('input[aria-label="Date and time"]'), ${JSON.stringify(at)});
    setValue(f('select[aria-label="Target conversation"]'), ${JSON.stringify(reuse)});
    await pause(300);
    if (${JSON.stringify(reuse)} === 'session') {
      const sel = f('select[aria-label="Existing conversation"]');
      if (!sel) return { ok: false, why: 'no existing-conversation select' };
      setValue(sel, ${JSON.stringify(sessionId)});
      await pause(200);
      if (sel.value !== ${JSON.stringify(sessionId)}) return { ok: false, why: 'target conversation not offered' };
    }
    const create = button('Create automation');
    if (!create) return { ok: false, why: 'no create button' };
    create.click();
    await pause(800);
    const s = schedOf(${JSON.stringify(name)});
    if (!s) return { ok: false, why: 'not stored', formError: f('.sched-form .error')?.textContent ?? null };
    return { ok: true, scheduleId: s.id, threadReuse: s.threadReuse.kind, targetIsRequested: s.threadReuse.sessionId === (${JSON.stringify(sessionId)} || undefined),
      authorizationMode: s.authorizationMode ?? null, projectId: s.projectId ?? null, workspace: s.workspace ?? null,
      triggerAt: s.trigger.at, timeZone: s.timeZone ?? null };
  `));
  if (!created.ok) throw new Error(`schedule ${name} not created: ${JSON.stringify(created)}`);
  return created;
}

/** The schedule's own Run button (a manual run-now of a Once schedule). */
async function runNow(app, name) {
  return app.ev(page(`
    const items = schedItem(${JSON.stringify(name)});
    const b = items.length === 1 ? [...items[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Run') : null;
    if (b) b.click();
    return { clicked: !!b, matches: items.length };
  `));
}

async function startConversation(app, text) {
  await app.ev(page("nav('New conversation'); return true;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('textarea[aria-label=\"Your first message\"]'));")), 15_000, 300);
  const before = (await calls(app, "start_session")).length;
  const clicked = await app.ev(page(`
    setValue(document.querySelector('textarea[aria-label="Your first message"]'), ${JSON.stringify(text)});
    await pause(400);
    const start = document.querySelector('button.welcome-send');
    if (!start || start.disabled) return { clicked: false };
    start.click();
    return { clicked: true };
  `));
  if (!clicked.clicked) throw new Error("the welcome screen refused to start");
  const started = await waitFor(async () => {
    const list = await calls(app, "start_session");
    return list.length > before && list.at(-1).result ? list.at(-1) : null;
  }, 90_000, 300);
  const sid = started?.ok ? JSON.parse(started.result).session_id : null;
  if (!sid) throw new Error(`start_session failed: ${JSON.stringify(started)}`);
  return { sid, workspacePath: started.args?.workspacePath ?? null, authorizationMode: started.args?.authorizationMode ?? null };
}

/** Select a conversation in the sidebar, or through a run card when its row is folded away. */
async function openConversation(app, sid, viaRun = null) {
  const done = await app.ev(page(`
    const row = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select');
    if (row) { row.click(); return 'sidebar'; }
    return null;
  `));
  if (!done && viaRun) {
    await automations(app);
    await app.ev(page(`runFilter('all'); await pause(200); return runAction(${JSON.stringify(viaRun)}, 'Open conversation');`));
  }
  const opened = await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)};`)), 15_000, 250);
  if (!opened) throw new Error(`conversation ${sid} could not be opened`);
  return done ?? "run card";
}

/** Answer the folder dialog, then press Settings > Change folder (or Choose folder). */
async function pickDefaultFolder(app, folder) {
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  const result = await app.ev(page(`
    const open = document.querySelector('.sidebar-footer button[aria-label="Settings"]');
    if (open) open.click();
    await pause(700);
    const b = q('.workspace-picker button.workspace-button')[0];
    if (!b) return { clicked: false };
    b.click();
    await pause(900);
    const shown = document.querySelector('.workspace-picker .workspace-path')?.getAttribute('title') ?? null;
    nav('Automations');
    await pause(500);
    return { clicked: true, stored: store('muse-desktop.workspace.v1', 'null'), shown };
  `));
  const setCall = (await calls(app, "set_workspace")).at(-1) ?? null;
  return { ...result, setWorkspaceOk: setCall?.ok ?? null };
}

async function setPosture(app, mode) {
  const label = { ask: "Ask for approval", workspace: "Approve on my behalf", yolo: "YOLO" }[mode];
  return app.ev(page(`
    if (!document.querySelector('button[role="menuitemradio"]')) { nav('New conversation'); await pause(1200); }
    const item = [...document.querySelectorAll('button[role="menuitemradio"]')]
      .find((b) => (b.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(label)});
    if (!item) return { clicked: false };
    item.click();
    await pause(600);
    return { clicked: true, stored: localStorage.getItem('muse-desktop.authorization-mode.v1') };
  `));
}

/** Sample a run (ledger + optional card) every `everyMs` until `until(sample)` or the bound. */
async function sampleRun(app, name, until, timeoutMs, everyMs = 250, { card = true } = {}) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await app.ev(page(`
      const r = runOf(${JSON.stringify(name)});
      const c = ${card ? `runCard(${JSON.stringify(name)})` : "null"};
      return { at: Date.now(), status: r?.status ?? null, turnId: r?.turnId ?? null, sessionId: r?.sessionId ?? null,
        preview: r?.resultPreview ?? null, summary: r?.resultSummary?.headline ?? null, error: r?.error ?? null,
        cardStatus: c?.status ?? null, cardPreview: c?.preview ?? null };
    `));
    const last = samples.at(-1);
    if (!last || last.status !== s.status || last.preview !== s.preview || last.cardStatus !== s.cardStatus
      || last.cardPreview !== s.cardPreview || last.turnId !== s.turnId || last.error !== s.error) samples.push(s);
    if (until(s)) return { done: true, samples, last: s };
    await sleep(everyMs);
  }
  return { done: false, samples, last: samples.at(-1) ?? null };
}

const rel = (t0, list) => list.map((x) => ({ ...x, at: x.at - t0 }));

// ---- phases ----------------------------------------------------------------

async function setup(app) {
  for (const path of [WS, RETRY]) mkdirSync(path, { recursive: true });
  await install(app);
  const before = await app.ev(page(`return { posture: localStorage.getItem('muse-desktop.authorization-mode.v1'),
    workspace: store('muse-desktop.workspace.v1', 'null'),
    scheduler: document.querySelector('.scheduler-status')?.getAttribute('data-mode') ?? null };`));
  // The user's own values stay in the state file (outside the repository).
  if (!("userPosture" in state())) saveState({ userPosture: before.posture, userWorkspace: before.workspace });
  saveState({ ws: WS_NAME });
  const posture = await setPosture(app, "workspace");
  const folder = await pickDefaultFolder(app, WS);
  await automations(app);
  const scheduler = await waitFor(() => app.ev(page(`const s = document.querySelector('.scheduler-status');
    return s && s.getAttribute('data-mode') !== 'none' ? { mode: s.getAttribute('data-mode'), text: s.querySelector('strong')?.textContent ?? null } : null;`)), 40_000, 1_000);
  return {
    liveTurns: 0,
    userValuesSaved: Boolean(state().userPosture !== undefined),
    posture: { clicked: posture.clicked, stored: posture.stored },
    defaultFolder: { ...folder, stored: folder.stored === WS ? `<${WS_NAME}>` : folder.stored },
    scheduler,
    wakeTask: wakeTask(),
  };
}

async function newRun(app) {
  await install(app);
  const t = tag();
  const name = `M3-08 new ${t}`;
  const answer = `RUN-NEW-${t}`;
  const instructions = `Reply with exactly these two lines and nothing else:\n${answer}\nNext steps: archive this run`;
  // The first whole minute at least 25 s away: the scheduler fires it, no click.
  const at = new Date(Math.ceil((Date.now() + 25_000) / 60_000) * 60_000).getTime();
  const sessionsBefore = await app.ev(page("return (store('muse-desktop.sessions.v1', '[]') || []).map((s) => s.session_id);"));
  // A schedule captures the project of whichever conversation is active (and
  // the default folder as its workspace): start from none, so the run is not
  // tied to an unrelated project.
  await app.ev(page("nav('New conversation'); await pause(800); return true;"));
  const created = await createSchedule(app, { name, instructions, at: localDateTime(at), reuse: "new" });
  saveState({ newRun: { name, answer } });
  const t0 = Date.now();
  // No click from here: wait for the scheduler, then follow the run.
  const appear = await waitFor(() => app.ev(page(`return runOf(${JSON.stringify(name)}) ? true : null;`)), at - Date.now() + 90_000, 500);
  if (!appear) throw new Error("the scheduler never created the run");
  const followed = await sampleRun(app, name, (s) => ["completed", "failed", "cancelled"].includes(s.status), 240_000);
  const run = await readRun(app, name);
  const sid = run.local?.sessionId;
  const ack = sid ? await sendAck(app, sid, instructions, 5_000) : null;
  const evs = sid ? await events(app, sid) : [];
  const terminal = run.local?.turnId ? terminalOf(evs, run.local.turnId) : null;
  const runningSamples = followed.samples.filter((s) => s.status === "running");
  const runNowClicks = 0; // the harness pressed no Run button in this phase
  return {
    liveTurns: 1,
    schedule: { ...created, scheduledFor: at - t0 },
    timeline: rel(t0, followed.samples),
    run,
    sendAck: ack,
    hostEvents: rel(t0, evs),
    verdict: {
      firedWithoutClick: runNowClicks === 0 && Boolean(appear) && run.local?.occurrenceAt === at,
      newConversation: Boolean(sid) && !sessionsBefore.includes(sid) && run.local?.threadReuse === "new",
      anchoredToAdmittedTurn: Boolean(ack?.turnId) && ack.turnId === run.local?.turnId,
      settledByItsOwnTerminal: Boolean(terminal) && terminal.turnId === run.local?.turnId,
      noPreviewBeforeTerminal: runningSamples.length > 0 && runningSamples.every((s) => s.preview === null && s.cardPreview === null),
      completed: run.local?.status === "completed" && run.native?.status === "completed" && run.card?.status === "Completed",
      previewIsRunAnswer: (run.local?.resultPreview ?? "").includes(answer) && (run.card?.preview ?? "").includes(answer),
      summaryScoped: run.local?.summary?.assistantMessages === 1 && (run.local?.summary?.headline ?? "").includes(answer)
        && (run.local?.summary?.nextSteps ?? []).includes("archive this run"),
      unreadAfterSettle: run.local?.unread === true && run.card?.newBadge === true,
      hostStructuredPreview: terminal ? (terminal.previewKeys.length > 0 ? terminal.previewKeys : "none emitted by the host") : null,
    },
  };
}

async function busy(app) {
  await install(app);
  const t = tag();
  const names = { R: `M3-08 busy ${t}`, Q: `M3-08 unqueue ${t}` };
  const answers = { A: `END-A-${t}`, R: `RUN-BUSY-${t}`, Q: `RUN-UNQUEUE-${t}` };
  const prompts = {
    A: `Write a 2000-word story about a lighthouse keeper who repairs an old clock, in plain prose with no headings. Do not stop before 2000 words. Finish with a last line containing only ${answers.A}`,
    R: `Reply with exactly this line and nothing else: ${answers.R}`,
    Q: `Reply with exactly this line and nothing else: ${answers.Q}`,
  };
  const t0 = Date.now();
  const C = await startConversation(app, prompts.A);
  saveState({ busy: { C: C.sid, names, answers } });
  const ackA = await sendAck(app, C.sid, prompts.A);
  const aStarted = await waitFor(async () => (await events(app, C.sid)).find((e) => e.kind === "started") ?? null, 90_000, 250);
  // Dispatch R then Q into the busy conversation.
  const created = {};
  const runClicks = {};
  for (const key of ["R", "Q"]) {
    created[key] = await createSchedule(app, { name: names[key], instructions: prompts[key], at: farFuture(), reuse: "session", sessionId: C.sid });
    runClicks[key] = await runNow(app, names[key]);
  }
  const acks = { R: await sendAck(app, C.sid, prompts.R), Q: await sendAck(app, C.sid, prompts.Q) };
  const aTerminalAtDispatch = terminalOf(await events(app, C.sid), ackA?.turnId);
  if (!ackA?.turnId || !acks.R?.turnId || !acks.Q?.turnId) {
    throw new Error(`missing admission ack: ${JSON.stringify({ A: ackA, ...acks })}`);
  }
  // attachRunTurn lands right after the ack resolves the dispatch.
  await waitFor(() => app.ev(page(`return runOf(${JSON.stringify(names.R)})?.turnId && runOf(${JSON.stringify(names.Q)})?.turnId ? true : null;`)), 5_000, 200);
  const afterDispatch = { R: await readRun(app, names.R), Q: await readRun(app, names.Q) };
  // (4) Remove Q from the host queue, from the conversation's queue panel.
  const openedVia = await openConversation(app, C.sid, names.R);
  const queuePanel = await waitFor(() => app.ev(page(`
    const rows = q('.queued-turns .queued-turn');
    return rows.length ? rows.map((n) => n.querySelector('.queued-turn-text')?.textContent ?? '') : null;
  `)), 15_000, 300);
  const removeClick = await app.ev(page(`
    const row = q('.queued-turns .queued-turn').find((n) => (n.textContent || '').includes(${JSON.stringify(answers.Q)}));
    const b = row ? [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Remove from queue') : null;
    if (b) b.click();
    return { clicked: !!b };
  `));
  const qSettled = await sampleRun(app, names.Q, (s) => s.status !== "running", 30_000, 250, { card: false });
  const unqueueCall = (await calls(app, "unqueue_turn")).at(-1) ?? null;
  const unqueuedEvent = (await events(app, C.sid)).find((e) => e.kind === "turn/unqueued") ?? null;
  // (2) Watch R on the Automations page until A ends, then until R ends.
  await automations(app);
  await app.ev(page("runFilter('all'); return true;"));
  const watch = [];
  let aTerminal = null;
  let rTerminal = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline && !rTerminal) {
    const evs = await events(app, C.sid);
    aTerminal = aTerminal ?? terminalOf(evs, ackA?.turnId);
    rTerminal = acks.R?.turnId ? terminalOf(evs, acks.R.turnId) : null;
    if (aTerminal) {
      const s = await app.ev(page(`
        const r = runOf(${JSON.stringify(names.R)});
        const c = runCard(${JSON.stringify(names.R)});
        return { at: Date.now(), status: r?.status ?? null, turnId: r?.turnId ?? null, preview: r?.resultPreview ?? null,
          finishedAt: r?.finishedAt ?? null, cardStatus: c?.status ?? null, cardPreview: c?.preview ?? null };
      `));
      s.rStarted = Boolean(evs.find((e) => e.kind === "started" && e.turnId === acks.R?.turnId));
      const last = watch.at(-1);
      if (!last || last.status !== s.status || last.cardStatus !== s.cardStatus || last.preview !== s.preview || last.rStarted !== s.rStarted) watch.push(s);
    }
    await sleep(250);
  }
  // One more sample once R's terminal is in, so the settled row is in the watch.
  await sleep(1_500);
  const final = { R: await readRun(app, names.R), Q: await readRun(app, names.Q) };
  const evs = await events(app, C.sid);
  // The conversation's rows since R was dispatched: which turn each belongs to.
  const rStartedAt = final.R.local?.startedAt ?? 0;
  const logSinceR = await app.ev(page(`
    const log = store('muse-desktop.log.v1.' + ${JSON.stringify(C.sid)}, '[]') || [];
    return log.filter((e) => (e.ts ?? 0) >= ${rStartedAt}).map((e) => ({ role: e.role, turnId: e.turnId ?? null,
      text: String(e.text || '').replace(/\\s+/g, ' ').slice(0, 60) }));
  `));
  // Samples taken after A's terminal reached the page and before R's did.
  const betweenATerminalAndRTerminal = watch.filter((s) => aTerminal && rTerminal && s.at >= aTerminal.at && s.at < rTerminal.at);
  return {
    liveTurns: 2,
    conversation: { workspacePath: C.workspacePath, authorizationMode: C.authorizationMode },
    turnA: { ack: ackA, startedEventAt: aStarted ? aStarted.at - t0 : null, terminal: aTerminal ? { ...aTerminal, at: aTerminal.at - t0 } : null },
    schedules: created,
    runClicks,
    acks: { R: acks.R && { ...acks.R, at: acks.R.at - t0 }, Q: acks.Q && { ...acks.Q, at: acks.Q.at - t0 } },
    aStillRunningWhenDispatched: !aTerminalAtDispatch,
    afterDispatch,
    unqueue: { openedVia, queuePanel, removeClick, call: unqueueCall && { ok: unqueueCall.ok, turnId: unqueueCall.args?.turnId ?? null },
      event: unqueuedEvent && { ...unqueuedEvent, at: unqueuedEvent.at - t0 }, qTimeline: rel(t0, qSettled.samples) },
    rWatchAfterA: rel(t0, watch),
    final,
    hostEvents: rel(t0, evs),
    conversationRowsSinceR: logSinceR,
    verdict: {
      precondition_bothQueuedBehindA: acks.R?.disposition === "queued" && acks.Q?.disposition === "queued" && !aTerminalAtDispatch,
      r_anchoredToItsQueuedTurn: Boolean(acks.R?.turnId) && afterDispatch.R.local?.turnId === acks.R.turnId && acks.R.turnId !== ackA?.turnId,
      r_notSettledByA: betweenATerminalAndRTerminal.length > 0 && betweenATerminalAndRTerminal.every((s) => s.status === "running" && s.preview === null && s.cardStatus === "Running"),
      r_settledByItsOwnTurn: Boolean(rTerminal) && final.R.local?.status === "completed" && final.R.local.finishedAt >= rTerminal.at - 1_000,
      r_previewIsItsOwn: (final.R.local?.resultPreview ?? "").includes(answers.R) && !(final.R.local?.resultPreview ?? "").includes(answers.A)
        && (final.R.card?.preview ?? "").includes(answers.R),
      r_summaryScoped: (final.R.local?.summary?.headline ?? "").includes(answers.R) && final.R.local?.summary?.assistantMessages === 1,
      q_unqueuedCancelled: removeClick.clicked && final.Q.local?.status === "cancelled" && final.Q.native?.status === "cancelled" && final.Q.card?.status === "Cancelled",
      q_noPreview: final.Q.local?.resultPreview === null,
      q_neverStarted: !evs.some((e) => e.kind === "started" && e.turnId === acks.Q?.turnId),
    },
  };
}

async function stop(app) {
  await install(app);
  const t = tag();
  const C = state().busy?.C;
  if (!C) throw new Error("run the busy phase first");
  const name = `M3-08 stop ${t}`;
  const instructions = `Write a 2000-word story about a clockmaker in plain prose with no headings. Do not stop early. Marker STOP-${t}`;
  const t0 = Date.now();
  const created = await createSchedule(app, { name, instructions, at: farFuture(), reuse: "session", sessionId: C });
  const runClick = await runNow(app, name);
  const ack = await sendAck(app, C, instructions);
  const started = await waitFor(async () => (await events(app, C)).find((e) => e.kind === "started" && e.turnId === ack?.turnId) ?? null, 90_000, 250);
  const running = await readRun(app, name);
  await openConversation(app, C, name);
  const stopButton = await waitFor(() => app.ev(page(`
    const b = q('button').find((n) => (n.innerText || '').trim() === 'Stop' && !n.disabled && !/subagent/i.test(n.getAttribute('title') || ''));
    return b ? { title: b.getAttribute('title') } : null;
  `)), 20_000, 250);
  await sleep(2_500);
  const stopClick = await app.ev(page(`
    const b = q('button').find((n) => (n.innerText || '').trim() === 'Stop' && !n.disabled && !/subagent/i.test(n.getAttribute('title') || ''));
    if (b) b.click();
    return { clicked: !!b };
  `));
  const stopClickedAt = Date.now();
  const terminal = await waitFor(async () => terminalOf(await events(app, C), ack?.turnId), 60_000, 250);
  await sleep(1_500);
  await automations(app);
  await app.ev(page("runFilter('all'); return true;"));
  await sleep(500);
  const final = await readRun(app, name);
  const cancel = (await calls(app, "cancel_session")).at(-1) ?? null;
  return {
    liveTurns: 1,
    schedule: created,
    runClick,
    ack: ack && { ...ack, at: ack.at - t0 },
    startedEventAt: started ? started.at - t0 : null,
    whileRunning: running,
    stopButton,
    stopClick: { ...stopClick, at: stopClickedAt - t0 },
    cancelCall: cancel && { ok: cancel.ok, carriedTurnId: JSON.stringify(cancel.args ?? {}).includes(ack?.turnId ?? "~") },
    terminal: terminal && { ...terminal, at: terminal.at - t0 },
    final,
    verdict: {
      anchoredToItsTurn: Boolean(ack?.turnId) && running.local?.turnId === ack.turnId && running.local?.status === "running",
      stoppedFromComposer: stopClick.clicked && Boolean(terminal),
      cancelled: final.local?.status === "cancelled" && final.native?.status === "cancelled" && final.card?.status === "Cancelled",
      noResultOnCancel: final.local?.resultPreview === null && final.card?.preview === null,
      finishedAfterStop: (final.local?.finishedAt ?? 0) >= stopClickedAt,
    },
  };
}

async function retry(app) {
  await install(app);
  const t = tag();
  const name = `M3-08 retry ${t}`;
  const answer = `RUN-RETRY-${t}`;
  const instructions = `Reply with exactly this line and nothing else: ${answer}`;
  mkdirSync(RETRY, { recursive: true });
  const folder = await pickDefaultFolder(app, RETRY);
  const created = await createSchedule(app, { name, instructions, at: farFuture(), reuse: "new" });
  // The folder disappears before the run (an unplugged drive, a renamed repo).
  renameSync(RETRY, RETRY_AWAY);
  const t0 = Date.now();
  const runClick = await runNow(app, name);
  const failed = await sampleRun(app, name, (s) => s.status === "failed", 30_000, 250);
  const failedRun = await readRun(app, name);
  const startCall = (await calls(app, "start_session")).at(-1) ?? null;
  renameSync(RETRY_AWAY, RETRY);
  const retryClick = await app.ev(page(`runFilter('all'); await pause(200); return runAction(${JSON.stringify(name)}, 'Retry now');`));
  const retryAt = Date.now();
  const afterClick = await readRun(app, name, { card: false });
  // The scheduler check picks the retry up on its next tick; a focus event wakes it now.
  await app.ev("(window.dispatchEvent(new Event('focus')), true)");
  const followed = await sampleRun(app, name, (s) => ["completed", "cancelled"].includes(s.status)
    || (s.status === "failed" && s.at > retryAt + 2_000), 240_000);
  const final = await readRun(app, name);
  const sid = final.local?.sessionId;
  const ack = sid ? await sendAck(app, sid, instructions, 5_000) : null;
  const evs = sid ? await events(app, sid) : [];
  const back = await pickDefaultFolder(app, WS);
  saveState({ retryRun: { name, answer, sid } });
  return {
    liveTurns: 1,
    defaultFolder: { picked: folder.clicked, restoredToWs: back.stored === WS },
    schedule: created,
    runClick,
    failedAttempt: { timeline: rel(t0, failed.samples), run: failedRun,
      startSession: startCall && { ok: startCall.ok, error: startCall.ok ? null : String(startCall.result).slice(0, 160) } },
    retryClick,
    afterRetryClick: afterClick.local,
    timeline: rel(t0, followed.samples),
    final,
    sendAck: ack,
    hostEvents: rel(t0, evs),
    verdict: {
      failedWithReason: failedRun.local?.status === "failed" && /could not start/i.test(failedRun.local?.error ?? "")
        && failedRun.card?.status === "Failed" && failedRun.card?.actions.includes("Retry now"),
      retryRequeued: retryClick === true && afterClick.local?.status === "queued" && afterClick.local?.error === null,
      retryCompleted: final.local?.status === "completed" && final.native?.status === "completed" && final.card?.status === "Completed",
      retryIsSameRun: final.local?.id === failedRun.local?.id,
      retryAnchored: Boolean(ack?.turnId) && ack.turnId === final.local?.turnId && Boolean(terminalOf(evs, ack.turnId)),
      previewIsRunAnswer: (final.local?.resultPreview ?? "").includes(answer),
    },
  };
}

async function review(app) {
  await install(app);
  const s = state();
  const names = { N: s.newRun?.name, R: s.busy?.names.R, Q: s.busy?.names.Q, T: s.retryRun?.name };
  if (Object.values(names).some((n) => !n)) throw new Error("run new, busy and retry first");
  const result = { liveTurns: 0, open: {} };
  const before = {};
  for (const [key, name] of Object.entries(names)) before[key] = (await readRun(app, name)).local;
  // Open conversation: the run's own session, and its own answer on screen.
  const answers = { N: s.newRun.answer, R: s.busy.answers.R, T: s.retryRun.answer };
  for (const key of ["N", "R", "T"]) {
    await automations(app);
    const clicked = await app.ev(page(`runFilter('all'); await pause(250); return runAction(${JSON.stringify(names[key])}, 'Open conversation');`));
    const opened = await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(before[key].sessionId)} && transcriptHas(${JSON.stringify(answers[key])}) ? true : null;`)), 15_000, 250);
    result.open[key] = { clicked, sessionId: before[key].sessionId, activeIsRunSession: Boolean(opened),
      page: await app.ev(page("return document.querySelector('.primary-nav button[aria-current=\"page\"]')?.getAttribute('aria-label') ?? 'task';")) };
  }
  // Mark read (R only).
  await automations(app);
  result.markRead = { clicked: await app.ev(page(`runFilter('all'); await pause(250); return runAction(${JSON.stringify(names.R)}, 'Mark read');`)) };
  await sleep(1_000);
  result.markRead.R = await readRun(app, names.R);
  result.markRead.N = (await readRun(app, names.N)).local;
  result.markRead.unreadFilterHasR = await app.ev(page(`runFilter('unread'); await pause(300); const has = Boolean(runItem(${JSON.stringify(names.R)})); runFilter('all'); return has;`));
  // Archive then Restore (Q).
  result.archive = { clicked: await app.ev(page(`runFilter('all'); await pause(250); return runAction(${JSON.stringify(names.Q)}, 'Archive');`)) };
  await sleep(1_000);
  result.archive.Q = await readRun(app, names.Q, { card: false });
  result.archive.inActive = await app.ev(page(`runFilter('all'); await pause(300); return Boolean(runItem(${JSON.stringify(names.Q)}));`));
  result.archive.inArchived = await app.ev(page(`runFilter('archived'); await pause(300); const c = runCard(${JSON.stringify(names.Q)}); return c ? { status: c.status, actions: c.actions } : null;`));
  result.restore = { clicked: await app.ev(page(`return runAction(${JSON.stringify(names.Q)}, 'Restore');`)) };
  await sleep(1_000);
  result.restore.Q = (await readRun(app, names.Q, { card: false })).local;
  result.restore.inActive = await app.ev(page(`runFilter('all'); await pause(300); return Boolean(runItem(${JSON.stringify(names.Q)}));`));
  result.verdict = {
    openConversation: Object.values(result.open).every((o) => o.clicked && o.activeIsRunSession)
      && new Set(Object.values(result.open).map((o) => o.sessionId)).size === 3,
    markRead: result.markRead.clicked && result.markRead.R.local?.unread === false && result.markRead.R.native?.unread === false
      && result.markRead.R.card?.newBadge === false && result.markRead.N?.unread === true && result.markRead.unreadFilterHasR === false
      && result.markRead.R.local?.status === "completed",
    archive: result.archive.clicked && result.archive.Q.local?.archived === true && result.archive.Q.native?.archived === true
      && result.archive.inActive === false && Boolean(result.archive.inArchived?.actions.includes("Restore")),
    restore: result.restore.clicked && result.restore.Q?.archived === false && result.restore.inActive === true
      && result.restore.Q?.status === "cancelled",
  };
  return result;
}

async function restart(app) {
  await install(app);
  const s = state();
  const names = { N: s.newRun?.name, R: s.busy?.names.R, Q: s.busy?.names.Q, T: s.retryRun?.name };
  const stop = (await app.ev(page("return (store('muse-desktop.schedule-runs.v1', '[]') || []).filter((r) => /^M3-08 stop /.test(r.scheduleName)).pop()?.scheduleName ?? null;")));
  if (stop) names.S = stop;
  const before = {};
  for (const [key, name] of Object.entries(names)) before[key] = await readRun(app, name, { card: false });
  // Close from the window's own control, as a user would.
  const pid = readFileSync(PID_FILE, "utf8").trim();
  await app.ev(page("const b = document.querySelector('button[aria-label=\"Close window\"]'); if (b) b.click(); return !!b;")).catch(() => null);
  app.close();
  const alive = () => { try { execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`]); return true; } catch { return false; } };
  const exited = await waitFor(async () => !alive(), 30_000, 1_000);
  if (!exited) execFileSync("taskkill", ["/F", "/T", "/PID", pid]);
  await sleep(3_000);
  const child = spawn(EXE, [], { detached: true, stdio: "ignore",
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" } });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  let next = null;
  await waitFor(async () => { try { next = await openPage(); return true; } catch { return false; } }, 60_000, 1_000);
  if (!next) throw new Error("relaunched app has no CDP page");
  await waitFor(() => next.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 1_000);
  await sleep(4_000); // the native ledger merge runs after boot
  await install(next);
  const after = {};
  for (const [key, name] of Object.entries(names)) after[key] = await readRun(next, name, { card: false });
  const keysToCompare = ["id", "status", "turnId", "sessionId", "attempt", "unread", "archived", "finishedAt", "resultPreview", "error"];
  const same = (a, b) => Boolean(a && b) && keysToCompare.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  const comparison = Object.fromEntries(Object.keys(names).map((key) => [key, {
    localUnchanged: same(before[key].local, after[key].local),
    nativeUnchanged: same(before[key].native, after[key].native),
    nativeEqualsLocal: same(after[key].local, after[key].native),
    status: after[key].local?.status ?? null,
    recovery: after[key].local?.recovery ?? null,
  }]));
  await automations(next);
  const cardN = await next.ev(page(`runFilter('all'); await pause(300); return runCard(${JSON.stringify(names.N)});`));
  const clicked = await next.ev(page(`return runAction(${JSON.stringify(names.N)}, 'Open conversation');`));
  const opened = await waitFor(() => next.ev(page(`return activeSid() === ${JSON.stringify(before.N.local?.sessionId)} && transcriptHas(${JSON.stringify(s.newRun.answer)}) ? true : null;`)), 20_000, 300);
  const result = {
    liveTurns: 0,
    close: { exitedFromWindowControl: Boolean(exited) },
    comparison,
    cardAfterRestart: cardN,
    openAfterRestart: { clicked, activeIsRunSession: Boolean(opened) },
    consoleErrors: next.errors.slice(0, 10),
    verdict: {
      durableHistory: Object.values(comparison).every((c) => c.localUnchanged && c.nativeUnchanged && c.nativeEqualsLocal && c.recovery === null),
      cardRebuilt: cardN?.status === "Completed" && (cardN?.preview ?? "").includes(s.newRun.answer),
      rightSessionOpened: clicked && Boolean(opened),
    },
  };
  next.close();
  return result;
}

async function wake(app) {
  await install(app);
  const t = tag();
  const name = `M3-07 wake ${t}`;
  const before = wakeTask();
  const others = await app.ev(page("return schedules().filter(pendingOccurrence).map((s) => ({ id: s.id, name: s.name, at: s.trigger.at ?? null }));"));
  const at = new Date(Date.now() + 24 * 3_600_000);
  at.setHours(9, 0, 0, 0);
  const created = await createSchedule(app, { name, instructions: "Reply with exactly: WAKE-UNUSED", at: localDateTime(at.getTime()), reuse: "new" });
  const afterCreate = await waitFor(() => { const w = wakeTask(); return w.exists && w.startEpoch === at.getTime() ? w : null; }, 20_000, 500) ?? wakeTask();
  // The remaining enabled schedules with an occurrence are paused, then restored.
  saveState({ wakeDisabled: others.map((o) => o.id) });
  const disabled = [];
  for (const other of others) {
    const ok = await app.ev(page(`
      const li = schedItem(${JSON.stringify(other.name)});
      const b = li.length === 1 ? [...li[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Disable') : null;
      if (b) b.click();
      await pause(400);
      return Boolean(b) && schedules().find((s) => s.id === ${JSON.stringify(other.id)})?.enabled === false;
    `));
    disabled.push({ name: other.name, disabled: ok });
  }
  const afterDisable = wakeTask();
  const lastPending = await app.ev(page("return schedules().filter(pendingOccurrence).map((s) => s.name);"));
  const del = await app.ev(page(`
    const li = schedItem(${JSON.stringify(name)});
    const b = li.length === 1 ? [...li[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Delete') : null;
    if (b) b.click();
    await pause(500);
    return { clicked: !!b, stillStored: Boolean(schedOf(${JSON.stringify(name)})), pendingLeft: schedules().filter(pendingOccurrence).length };
  `));
  const afterDelete = await waitFor(() => { const w = wakeTask(); return w.exists ? null : w; }, 20_000, 500) ?? wakeTask();
  const uiStatus = await app.ev(page(`const s = document.querySelector('.scheduler-wakeup-status');
    return s ? { installed: s.getAttribute('data-installed'), message: s.querySelector('span')?.textContent ?? null } : null;`));
  const reenabled = [];
  for (const other of others) {
    const ok = await app.ev(page(`
      const li = schedItem(${JSON.stringify(other.name)});
      const b = li.length === 1 ? [...li[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Enable') : null;
      if (b) b.click();
      await pause(400);
      return Boolean(b) && schedules().find((s) => s.id === ${JSON.stringify(other.id)})?.enabled === true;
    `));
    reenabled.push({ name: other.name, enabled: ok });
  }
  if (reenabled.every((r) => r.enabled)) saveState({ wakeDisabled: [] });
  const afterRestore = await waitFor(() => { const w = wakeTask(); return w.exists && w.startEpoch === before.startEpoch ? w : null; }, 20_000, 500) ?? wakeTask();
  const syncCalls = (await calls(app, "scheduler_wakeup_sync")).map((c) => ({ wakeAt: c.args?.wakeAt ?? null, ok: c.ok }));
  return {
    liveTurns: 0,
    before,
    otherPendingSchedules: others.map((o) => ({ name: o.name })),
    schedule: created,
    afterCreate,
    disabled,
    afterDisable,
    lastPendingBeforeDelete: lastPending,
    delete: del,
    afterDelete,
    uiStatusAfterDelete: uiStatus,
    reenabled,
    afterRestore,
    syncCalls,
    verdict: {
      createReplacesTrigger: afterCreate.exists && afterCreate.startEpoch === at.getTime() && afterCreate.startEpoch !== before.startEpoch,
      deleteLastRemovesTask: del.clicked && !del.stillStored && del.pendingLeft === 0 && afterDelete.exists === false
        && uiStatus?.installed === "false",
      restoredAsBefore: afterRestore.exists === before.exists && afterRestore.startEpoch === before.startEpoch
        && reenabled.every((r) => r.enabled),
    },
  };
}

async function teardown(app) {
  await install(app);
  const s = state();
  const result = { liveTurns: 0 };
  if ((s.wakeDisabled ?? []).length) {
    result.reenabled = await app.ev(page(`
      const ids = ${JSON.stringify(s.wakeDisabled)};
      const out = [];
      for (const id of ids) {
        const row = schedules().find((x) => x.id === id);
        const li = row ? schedItem(row.name) : [];
        const b = li.length === 1 ? [...li[0].querySelectorAll('button')].find((n) => n.textContent.trim() === 'Enable') : null;
        if (b) { b.click(); await pause(400); }
        out.push(Boolean(b));
      }
      return out;
    `));
    saveState({ wakeDisabled: [] });
  }
  if ("userPosture" in s) {
    // An absent key reads as the default posture, Ask.
    const target = s.userPosture ?? "ask";
    const restored = await setPosture(app, target);
    result.postureRestored = restored.stored === target;
  }
  if (s.userWorkspace) {
    const restored = await pickDefaultFolder(app, s.userWorkspace);
    result.defaultFolderRestored = restored.stored === s.userWorkspace;
  } else {
    result.defaultFolderRestored = "the user had no default folder; the UI cannot clear one";
  }
  result.wakeTask = wakeTask();
  return result;
}

const PHASES = { setup, new: newRun, busy, stop, retry, review, restart, wake, teardown };
if (!PHASES[PHASE]) {
  process.stderr.write(`usage: cdp-m3-07-08-runs.mjs <${Object.keys(PHASES).join("|")}> [--base dir] [--exe path] [--pid-file path] [--out file]\n`);
  process.exit(2);
}
mkdirSync(BASE, { recursive: true });
if (!existsSync(PID_FILE) && PHASE === "restart") throw new Error(`no pid file at ${PID_FILE}`);
const app = await openPage();
try {
  const result = await PHASES[PHASE](app);
  result.consoleErrors ??= app.errors.slice(0, 10);
  const written = merge(result);
  process.stdout.write(`${JSON.stringify(written.verdict ?? written, null, 2)}\n`);
} catch (error) {
  merge({ failure: String(error?.message ?? error).slice(0, 400), consoleErrors: app.errors.slice(0, 10) });
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  app.close();
}
