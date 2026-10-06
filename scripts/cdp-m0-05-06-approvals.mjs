#!/usr/bin/env node

/**
 * M0-05 / M0-06 native acceptance in the real webview: approval cards raised
 * by a live host (1.4.2) under the Ask posture (`promptUnmatched`, no client
 * auto-approval). The prompt recipe is a PowerShell write with a variable
 * argument, which the host cannot clear statically, so it always asks.
 *
 * Phases (results merge into --out, path-free):
 *   setup          no turn. Test projects A and B (folders under --base, picked
 *                  through the Projects panel; the harness answers the folder
 *                  dialog), the user's posture saved, posture set to Ask.
 *   reject         1 turn. (a) card with the host's choices; (b) Reject -> tool
 *                  denied, no "Muse is resuming".
 *   allow          1 turn. (e) real CDP double-click on Allow, decide calls
 *                  counted; (d) card per stage, and with --replay-stale the
 *                  stage-0 requirement is replayed through invoke('approve');
 *                  (c) Allow -> terminal.
 *   restart        1 turn. (f) card pending, taskkill /F of the app (--pid file),
 *                  relaunch (--exe, from PowerShell), reopen the conversation.
 *                  On 1.4.2 the host aborts the approval when the app dies
 *                  (stdin EOF): no card may come back, and the transcript must
 *                  say the approval was cancelled by the restart.
 *   reload         1 turn. (f) variant: page reload with the card pending; the
 *                  bridge and host live on; card rebuilt from listPending, decided.
 *   two            2 turns. (g) A and B pending together; deciding A reaches A
 *                  only (B still pending), then B. --reload also reloads the page
 *                  with both pending: (f) both cards back with no user action.
 *   forged         1 turn. (g) A's real card pending; a second tool_request for
 *                  an idle conversation B, carrying A's exact payload (same
 *                  approvalId and requirement), is appended to a poll_events
 *                  response, the path every bridge event takes to the renderer.
 *                  Deciding A must leave B's card pending and untouched.
 *   posture        2 turns. (h) card pending under Ask, posture switched to the
 *                  saved user posture (YOLO by default): card not decided; then
 *                  decided; the next action follows the new posture.
 *   isolation      1 turn. --tag network|elevated: the middle posture in a test
 *                  project whose Isolation is "Workspace and network" (network
 *                  call) or "Elevated access" (write outside the folder, then a
 *                  network call); every card answered Allow once.
 *   d1             1 turn. YOLO, default isolation: Muse's write_file tool and a
 *                  PowerShell write with an absolute in-root path (decision D1).
 *   wire           no turn. After a relaunch: resume of conversations started
 *                  under each posture, then the selector cycled through the
 *                  three postures; approval_mode / effectiveMode as the host
 *                  returned them.
 *   texts          no turn. Settings posture and isolation texts vs the
 *                  measured matrix (m0-06-verdict-matrix-1.4.2.json) and the
 *                  isolation, d1 and wire phases of this record.
 *
 * M0-06, policy in force, on the isolated app only (test mode, ADR 0003; pass
 * --test-data: the run stops unless the WebView2 profile lies in that folder):
 *   setup --projects A,B,N   no turn. Three test projects; N will allow network.
 *   scope          no turn. A conversation with no message per case: which
 *                  Isolation a project conversation really gets, from the
 *                  start_session posture and the engine argv the OS runs;
 *                  then a posture change against a running engine.
 *   policy         1 turn. --tag workspace|elevated: the middle posture, one
 *                  PowerShell write outside the folder and one HTTPS call,
 *                  under the default Isolation (project A) or Elevated access
 *                  (project B, Sandbox "Full access"). The first card is read
 *                  in the DOM against the host's choices, and shot.
 *   sentences      no turn. Every posture and Isolation sentence read from
 *                  Settings, each with its measured cells (this record, the
 *                  --msp report of msp-verdict-matrix.mjs, the 05/10 matrix and
 *                  approvals records); a sentence with no claim fails.
 * Launch for these (PowerShell, a fresh data folder):
 *   $env:MUSE_DESKTOP_TEST_DATA_DIR='G:\muse-proofs\m0-06\appdata-1'
 *   $env:MUSE_DESKTOP_TEST_SIDECAR='["<repo>/src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe"]'
 *   $env:MUSE_DESKTOP_TEST_CDP_PORT='9333'; $env:MUSE_NO_AUTO_UPDATE='1'
 *   (no WEBVIEW2_* variable) Start-Process <muse-desktop.exe>
 * then MUSE_CDP_PORT=9333 node scripts/cdp-m0-05-06-approvals.mjs <phase>
 *   --test-data G:\muse-proofs\m0-06\appdata-1 --base G:\muse-proofs\m0-06\app
 *   --out docs/evidence/2026-10-05-roadmap-closure/m0-06-policy-in-force.json
 *   [--msp docs/evidence/2026-10-05-roadmap-closure/m0-06-junction-network-1.4.2.json]
 *
 * The decide calls are counted on window.fetch (Tauri's IPC transport):
 * `__TAURI_INTERNALS__` rejects a monkey-patched `invoke` (cdp-stop-terminal).
 *
 * Usage:
 *   node scripts/cdp-m0-05-06-approvals.mjs <phase> [--base G:\muse-proofs\approvals]
 *     [--replay-stale] [--continue] [--tag <name>] [--build pre-fix|fixed]
 *     [--exe <muse-desktop.exe>] [--pid-file <base>\app.pid]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-05-06-approvals.json]
 * Launch the app with MUSE_NO_AUTO_UPDATE=1 and
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, under, waitFor, webviewProfile } from "./cdp-harness.mjs";
import { WEB_STAGE } from "./msp-verdict-matrix.mjs";

const PHASE = process.argv[2];
const CONTINUE = process.argv.includes("--continue");
const TAG = argValue("--tag", null);
const KEY = [PHASE, TAG, CONTINUE ? "continued" : null].filter(Boolean).join("-");
const BUILD = argValue("--build", "fixed");
const BASE = argValue("--base", "G:\\muse-proofs\\approvals");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-05-06-approvals.json");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const PID_FILE = argValue("--pid-file", join(BASE, "app.pid"));
const MATRIX = "docs/evidence/2026-10-05-roadmap-closure/m0-06-verdict-matrix-1.4.2.json";
const APPROVALS = "docs/evidence/2026-10-05-roadmap-closure/m0-05-06-approvals.json";
const MSP = argValue("--msp", "docs/evidence/2026-10-05-roadmap-closure/m0-06-junction-network-1.4.2.json");
const TEST_DATA = argValue("--test-data", null);
const STATE = join(BASE, "harness-state.json");
const ROOTS = { A: join(BASE, "a"), B: join(BASE, "b"), N: join(BASE, "n"), network: join(BASE, "net"), elevated: join(BASE, "elev") };
const NAMES = { A: "m05-approvals-a", B: "m05-approvals-b", N: "m06-network-n" };
const OUTSIDE = join(BASE, "outside");
const redact = redactor([[ROOTS.A, "<project A>"], [ROOTS.B, "<project B>"], [ROOTS.N, "<project N>"], [ROOTS.network, "<project net>"],
  [ROOTS.elevated, "<project elev>"], [OUTSIDE, "<outside>"], [BASE, "<proof>"], ...(TEST_DATA ? [[TEST_DATA, "<test data>"]] : [])]);
const PENDING_KEY = "muse-desktop.pending-approvals.v1";
const POSTURE_LABEL = { ask: "Ask for approval", workspace: "Ask only for more access", yolo: "YOLO" };
const recipe = (tag) =>
  `Use your PowerShell tool to run exactly this command in the workspace, unchanged, once: $m = '${tag}'; Set-Content -Path probe.txt -Value $m`;

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
  const cards = () => q('.approvals .approval').map((g) => ({
    title: g.querySelector('.approval-title-row strong')?.innerText.trim() || null,
    command: g.querySelector('.approval-details pre')?.innerText.slice(0, 300) || null,
    scope: g.querySelector('.approval-scope')?.innerText.trim() || null,
    buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => ({ text: b.innerText.trim(), aria: b.getAttribute('aria-label'), cls: b.className })),
    noChoices: /No choices supplied/.test(g.innerText),
  }));
  const health = () => { const h = document.querySelector('.stream-health'); return h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160) : null; };
  const alerts = () => q('.error, [role="alert"], .error-banner').map((n) => n.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 4);
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const running = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"] .dot')?.getAttribute('data-running') || null;
  const view = () => ({ activeSid: activeSid(), health: health(), cards: cards(), alerts: alerts() });
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));

function merge(phaseResult) {
  const record = readJson(OUT, TEST_DATA ? {
    schema: "muse-desktop.m0-06-policy-in-force.v1",
    tickets: ["M0-06"],
    platform: "Windows 11 (26200), debug build with embedded frontend, isolated test mode (ADR 0003), WebView2 over CDP",
    phases: {},
  } : {
    schema: "muse-desktop.m0-05-06-approvals.v1",
    tickets: ["M0-05", "M0-06"],
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    posture: "Ask -> promptUnmatched, no client auto-approval (decision 05/10)",
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.phases[KEY] = redact({ build: BUILD, ...phaseResult });
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[KEY];
}

function engineVersion() {
  try {
    return execFileSync(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"), ["--version"],
      { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

// ---- page actions -------------------------------------------------------

/** Pending snapshot from the bridge; accepts the raw host rows and the normalized ones. */
async function pending(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${JSON.stringify(sid)} })`);
  const rows = Array.isArray(res?.approvals) ? res.approvals : [];
  return {
    raw: rows[0] ? Object.keys(rows[0]).sort() : [],
    approvals: rows.map((r) => ({
      approvalId: r.approvalId ?? r.request_id,
      requirement: r.currentRequirementId ?? null,
      choices: (r.choices ?? r.availableChoices ?? []).map((c) => ({
        choiceId: c.choiceId, label: c.label ?? null, decision: c.decision?.kind ?? c.decision, scope: c.scope ?? null,
      })),
    })),
  };
}

const ipc = (app, cmd, max = 2000) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})
  .map((c) => ({ atMs: c.atMs, args: c.args, ok: c.ok, result: c.result ? c.result.slice(0, ${max}) : c.result }))`);

async function setPosture(app, mode) {
  const label = POSTURE_LABEL[mode];
  return app.ev(page(`
    if (!document.querySelector('button[role="menuitemradio"]')) {
      q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
      await new Promise((r) => setTimeout(r, 1200));
    }
    const item = [...document.querySelectorAll('button[role="menuitemradio"]')].find((b) => (b.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(label)});
    if (!item) return { clicked: false };
    item.click();
    await new Promise((r) => setTimeout(r, 600));
    return { clicked: true, stored: localStorage.getItem('muse-desktop.authorization-mode.v1') };
  `));
}

/** Welcome screen -> project option -> first message -> Start. Returns the new session id. */
async function startIn(app, projectId, text, rootIndex = 0) {
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  const before = (await ipc(app, "start_session")).length;
  const picked = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    if (!details) return { found: false };
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const target = q('[role="option"].project-option').find((o) => fiberKey(o) === ${JSON.stringify(`${projectId}:${rootIndex}`)});
    if (!target) return { found: false };
    target.click();
    await new Promise((r) => setTimeout(r, 400));
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    setValue(field, ${JSON.stringify(text)});
    await new Promise((r) => setTimeout(r, 300));
    const start = document.querySelector('button.welcome-send');
    if (!start || start.disabled) return { found: true, clicked: false };
    start.click();
    return { found: true, clicked: true };
  `));
  if (!picked.clicked) throw new Error(`could not start in project ${projectId}: ${JSON.stringify(picked)}`);
  const started = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > before && calls.at(-1).result ? calls.at(-1) : null;
  }, 90_000);
  const meta = started?.result ? JSON.parse(started.result) : null;
  const sid = meta?.session_id ?? null;
  if (!sid) throw new Error(`start_session failed: ${JSON.stringify(started)}`);
  // approval_mode is the host's own session/start answer (session.approvalMode).
  return { sid, startSession: { ok: started.ok, authorizationMode: started.args?.authorizationMode ?? null,
    sandboxMode: started.args?.sandboxMode ?? null, hostApprovalMode: meta.approval_mode ?? null } };
}

/** Host approval modes the bridge returned, per command, for `sids` (all when omitted). */
async function wireModes(app, sids) {
  const keep = (c) => !sids || sids.includes(c.args?.sessionId);
  const parse = (c) => { try { return JSON.parse(c.result); } catch { return null; } };
  return {
    resume: (await ipc(app, "resume_session")).filter(keep).map((c) => ({ sessionId: c.args?.sessionId, ok: c.ok,
      sandboxMode: c.args?.sandboxMode ?? null, hostApprovalMode: c.ok ? parse(c)?.approval_mode ?? null : null })),
    setApprovalMode: (await ipc(app, "set_approval_mode")).filter(keep).map((c) => ({ sessionId: c.args?.sessionId, mode: c.args?.mode, ok: c.ok,
      status: c.ok ? parse(c)?.status ?? null : null, effectiveMode: c.ok ? parse(c)?.effectiveMode?.mode ?? null : null,
      error: c.ok ? undefined : String(c.result ?? "").slice(0, 200) })),
  };
}

async function select(app, sid) {
  await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)};`)), 15_000, 300);
  await sleep(800);
}

async function followUp(app, text) {
  return app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { sent: false, reason: 'no composer' };
    setValue(field, ${JSON.stringify(text)});
    await new Promise((r) => setTimeout(r, 300));
    const send = document.querySelector('button.send');
    if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
    send.click();
    return { sent: true };
  `));
}

/** Wait until the host lists a pending approval for `sid` and the card is painted. */
async function waitCard(app, sid, timeoutMs = 120_000) {
  const t0 = Date.now();
  const hit = await waitFor(async () => {
    const snap = await pending(app, sid);
    if (snap.approvals.length === 0) return null;
    const ui = await app.ev(page("return view();"));
    return ui.activeSid !== sid || ui.cards.length > 0 ? { snap, ui } : null;
  }, timeoutMs, 700);
  return hit ? { ...hit, msToCard: Date.now() - t0 } : null;
}

/** Real mouse clicks through CDP Input (clickCount 2 on the second press = a double-click). */
async function mouseClick(app, label, count = 1) {
  const box = await app.ev(page(`
    const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === ${JSON.stringify(label)});
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `));
  if (!box) return { clicked: false };
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  for (let n = 1; n <= count; n++) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: n });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: n });
  }
  return { clicked: true, count };
}

const labelOf = (snap, accepted) => {
  const c = snap.approvals[0]?.choices.find((x) => (x.decision === "abort" || /^denied/.test(x.decision)) !== accepted);
  return c?.label ?? null;
};

/** Decide every remaining stage of `sid`'s approval with single clicks on `label`. */
async function decideAll(app, sid, label, maxStages = 4) {
  const stages = [];
  for (let i = 0; i < maxStages; i++) {
    const snap = await pending(app, sid);
    if (snap.approvals.length === 0) break;
    const requirement = JSON.stringify(snap.approvals[0].requirement);
    const ui = await app.ev(page("return view();"));
    const click = await mouseClick(app, label);
    stages.push({ requirement, choices: snap.approvals[0].choices.map((c) => c.choiceId), cardButtons: ui.cards[0]?.buttons.map((b) => b.text) ?? [], ...click });
    if (!click.clicked) break;
    await waitFor(async () => {
      const next = await pending(app, sid);
      return next.approvals.length === 0 || JSON.stringify(next.approvals[0].requirement) !== requirement;
    }, 30_000, 400);
    // Human pace: the card repaints from the next poll after the host moves on.
    // A click before that is pinned to the old stage and refused (-32053).
    await sleep(1_500);
  }
  return stages;
}

/**
 * Sample the status row until the turn is idle (or the bound expires). With
 * `stopOnCard`, a new card after the current one cleared also ends the wait:
 * the host may re-request inside the same turn.
 */
async function untilIdle(app, sid, timeoutMs = 150_000, stopOnCard = false) {
  const samples = [];
  const t0 = Date.now();
  let cleared = false;
  let last = null;
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${JSON.stringify(sid)}) };`));
    last = s;
    const sample = { atMs: Date.now() - t0, health: (s.health ?? "").replace(/Last update \d+s ago\.\s*/, ""), cards: s.cards.length, running: s.running };
    if (samples.length === 0 || samples.at(-1).health !== sample.health || samples.at(-1).cards !== sample.cards) samples.push(sample);
    if (s.cards.length === 0) cleared = true;
    if (stopOnCard && cleared && s.cards.length > 0) return s;
    return s.running === "false" && s.cards.length === 0 && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "") ? s : null;
  }, timeoutMs, 700);
  return { idle: Boolean(done) && done.cards.length === 0, newCard: Boolean(done) && done.cards.length > 0,
    msToEnd: done ? Date.now() - t0 : null, healthSamples: samples, alerts: (done ?? last)?.alerts ?? [] };
}

async function tail(app, sid, n = 8) {
  return app.ev(page(`
    const log = store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];
    return log.slice(-${n}).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ').slice(0, 220) }));
  `));
}

/** Every entry of the persisted transcript, flattened (role + text). */
const fullLog = (app, sid) => app.ev(page(`
  return (store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ') }));
`));

/**
 * The cards of the active conversation as React holds them: the card's key is
 * `${session_id}:${request_id}` (ApprovalPanel), and the panel's `approvals`
 * prop gives the requirement token and choices behind each painted card.
 */
const cardsWithKeys = (app) => app.ev(page(`
  return q('.approvals .approval').map((g) => {
    const fk = Object.keys(g).find((k) => k.startsWith('__reactFiber$'));
    const fiber = fk ? g[fk] : null;
    let f = fiber;
    while (f && !(f.memoizedProps && Array.isArray(f.memoizedProps.approvals))) f = f.return;
    const card = f ? f.memoizedProps.approvals.find((a) => a.session_id + ':' + a.request_id === fiber.key) : null;
    return { key: fiber ? fiber.key : null, requirementId: card ? card.requirementId ?? null : null,
      choices: card ? card.choices.map((c) => c.choiceId + '/' + c.decision) : [], summary: card ? card.summary.slice(0, 160) : null,
      buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()) };
  });
`));

/**
 * Renderer-side poll interceptor: records the tool_request events the bridge
 * delivers and appends queued forged events to the next poll_events response.
 * poll_events is how every bridge event (push_event) reaches the renderer.
 */
const INSTALL_FORGE = `(() => {
  if (window.__forge) { window.__forge.queue = []; window.__forge.applied = []; window.__forge.seen = []; return 'reset'; }
  const forge = window.__forge = { queue: [], applied: [], seen: [] };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!/^https?:\\/\\/ipc\\.localhost\\/poll_events/.test(url)) return original(input, init);
    const response = await original(input, init);
    if (response.headers.get('Tauri-Response') !== 'ok') return response;
    const body = await response.clone().json();
    for (const e of body.events || []) if (e.kind === 'tool_request') forge.seen.push({ session_id: e.session_id, payload: e.payload });
    if (forge.queue.length === 0) return response;
    const forged = forge.queue.splice(0).map((e) => ({ seq: body.head, ...e }));
    forge.applied.push(...forged);
    body.events = [...(body.events || []), ...forged];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
  };
  return 'installed';
})()`;

/** Start the app the way a user does, from PowerShell, with the proof environment. */
function launchApp() {
  const pid = execFileSync("powershell", ["-NoProfile", "-Command",
    `$env:MUSE_NO_AUTO_UPDATE='1'; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; (Start-Process -FilePath '${EXE}' -PassThru).Id`],
  { encoding: "utf8" }).trim();
  writeFileSync(PID_FILE, pid);
  return pid;
}

/** Answer every card of the active conversation with Allow once until its turn is idle. */
async function allowUntilIdle(app, sid, timeoutMs = 180_000) {
  const t0 = Date.now();
  const stages = [];
  let sawRunning = false;
  while (Date.now() - t0 < timeoutMs) {
    const s = await app.ev(page(`return { ...view(), running: running(${JSON.stringify(sid)}) };`));
    if (s.running === "true") sawRunning = true;
    if (s.cards.length > 0) {
      const snap = await pending(app, sid);
      if (snap.approvals.length > 0) {
        const requirement = JSON.stringify(snap.approvals[0].requirement);
        const click = await mouseClick(app, labelOf(snap, true));
        stages.push({ approvalId: snap.approvals[0].approvalId, requirement, choices: snap.approvals[0].choices.map((c) => c.choiceId),
          title: s.cards[0].title, command: s.cards[0].command, ...click });
        await waitFor(async () => {
          const next = await pending(app, sid);
          return next.approvals.length === 0 || JSON.stringify(next.approvals[0].requirement) !== requirement;
        }, 30_000, 400);
        await sleep(1_500);
        continue;
      }
    }
    if (sawRunning && s.running === "false" && s.cards.length === 0 && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "")) {
      return { idle: true, msToEnd: Date.now() - t0, stages, alerts: s.alerts };
    }
    await sleep(700);
  }
  return { idle: false, msToEnd: null, stages, alerts: [] };
}

/** The approval panel only: the sidebar and the review queue show the user's own titles and paths. */
async function shot(app, name) {
  const clip = await app.ev(page("const n = q('.approvals')[0]; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };"));
  if (!clip) return null;
  const dir = "docs/evidence/2026-10-05-roadmap-closure/shots";
  mkdirSync(dir, { recursive: true });
  const capture = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(capture.data, "base64"));
  return `shots/${name}.png`;
}

// ---- phases ---------------------------------------------------------------

async function setup(app) {
  for (const path of Object.values(ROOTS)) {
    mkdirSync(path, { recursive: true });
    if (!existsSync(join(path, ".git"))) execFileSync("git", ["init", "-q"], { cwd: path });
  }
  await app.ev(INSTALL_IPC_TRACE);
  const result = {};
  const before = await app.ev(page(`return { posture: localStorage.getItem('muse-desktop.authorization-mode.v1'),
    isolation: (store('muse-desktop.settings.v1', 'null') || {}).mode || null,
    projects: (store('muse-desktop.projects.v1', '[]') || []).map((p) => ({ id: p.id, name: p.name })) };`));
  result.userPosture = before.posture;
  result.userIsolation = before.isolation;
  const ids = {};
  for (const key of argValue("--projects", "A,B").split(",")) {
    const existing = before.projects.find((p) => p.name === NAMES[key]);
    if (existing) { ids[key] = existing.id; continue; }
    await app.ev(page("const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b;"));
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
    await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOTS[key])}), true)`);
    ids[key] = await app.ev(page(`
      setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(NAMES[key])});
      button('Choose project folders').click();
      await new Promise((r) => setTimeout(r, 800));
      button('+ Add project').click();
      await new Promise((r) => setTimeout(r, 800));
      return (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAMES[key])})?.id || null;
    `));
    if (!ids[key]) throw new Error(`project ${key} not created`);
  }
  if (!state().userPosture) saveState({ userPosture: before.posture, userIsolation: before.isolation });
  saveState({ projects: ids });
  result.projectsCreated = Object.keys(ids);
  result.setAsk = await setPosture(app, "ask");
  return { ...result, liveTurns: 0 };
}

async function reject(app) {
  await app.ev(INSTALL_IPC_TRACE);
  let sid = CONTINUE ? state().rejectSid : null;
  let startSession = null;
  if (sid) await select(app, sid);
  else {
    ({ sid, startSession } = await startIn(app, state().projects.A, recipe("m05-reject")));
    saveState({ rejectSid: sid });
  }
  const result = { liveTurns: CONTINUE ? 0 : 1, startSession, rounds: [] };
  // Reject every card of this turn: the host may re-request after a reject.
  for (let round = 0; round < 3; round++) {
    const card = await waitCard(app, sid, round === 0 ? 120_000 : 60_000);
    if (!card) break;
    const rejectLabel = labelOf(card.snap, false);
    const entry = { approvalId: card.snap.approvals[0].approvalId, msToCard: card.msToCard, hostChoices: card.snap.approvals[0].choices,
      rawListPendingFields: card.snap.raw, card: card.ui.cards[0], health: card.ui.health, rejectLabel };
    if (result.rounds.length === 0 && !CONTINUE) entry.shot = await shot(app, "m0-05-a-card");
    entry.click = await mouseClick(app, rejectLabel);
    entry.after = await untilIdle(app, sid, 150_000, true);
    result.rounds.push(entry);
    if (!entry.after.newCard) break;
  }
  result.decide = await ipc(app, "approve");
  result.pendingAfter = (await pending(app, sid)).approvals.length;
  result.transcript = await tail(app, sid, 12);
  const first = result.rounds[0];
  result.verdict = {
    a_cardWithHostChoices: Boolean(first) && first.hostChoices.every((c) => first.card.buttons.some((b) => b.text === c.label)),
    b_oneDecisionPerCard: result.decide.length === result.rounds.length && result.decide.every((d) => d.ok === true && d.args.choiceId === "abort"),
    b_noResumingState: result.rounds.every((r) => !r.after.healthSamples.some((x) => /resuming/i.test(x.health ?? ""))),
    b_turnTerminal: Boolean(result.rounds.at(-1)?.after.idle),
    b_nothingPending: result.pendingAfter === 0,
  };
  return result;
}

async function allow(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const { sid, startSession } = await startIn(app, state().projects.A, recipe("m05-allow"));
  saveState({ allowSid: sid });
  const card = await waitCard(app, sid);
  if (!card) throw new Error("no approval card within the bound");
  const allowLabel = labelOf(card.snap, true);
  const stage0 = JSON.stringify(card.snap.approvals[0].requirement);
  const result = { liveTurns: 1, startSession, msToCard: card.msToCard, hostChoices: card.snap.approvals[0].choices, allowLabel, stage0 };
  // (e) a real double-click on Allow.
  result.doubleClick = await mouseClick(app, allowLabel, 2);
  await sleep(2_500);
  result.decideAfterDoubleClick = await ipc(app, "approve");
  result.afterDoubleClick = { ...(await app.ev(page("return view();"))), pending: await pending(app, sid) };
  // (d) the stage-0 requirement replayed through the bridge, if the card moved on.
  if (process.argv.includes("--replay-stale")) {
    const approvalId = card.snap.approvals[0].approvalId;
    const choiceId = card.snap.approvals[0].choices.find((c) => c.label === allowLabel)?.choiceId;
    const replay = await app.ev(`window.__TAURI_INTERNALS__.invoke('approve', { sessionId: ${JSON.stringify(sid)},
      approvalId: ${JSON.stringify(approvalId)}, choiceId: ${JSON.stringify(choiceId)}, requirementId: ${stage0} })
      .then((terminal) => ({ accepted: true, terminal }), (error) => ({ accepted: false, error: String(error).slice(0, 300) }))`);
    await sleep(1_500);
    result.staleReplay = { replayedRequirement: stage0, ...replay,
      after: { ...(await app.ev(page("return view();"))), pending: await pending(app, sid) } };
  }
  result.shot = await shot(app, "m0-05-d-stage");
  result.stages = await decideAll(app, sid, allowLabel);
  result.after = await untilIdle(app, sid);
  result.decide = await ipc(app, "approve");
  result.transcript = await tail(app, sid);
  result.probeFile = existsSync(join(ROOTS.A, "probe.txt")) ? readFileSync(join(ROOTS.A, "probe.txt"), "utf8").trim() : null;
  const firstBurst = result.decideAfterDoubleClick;
  result.verdict = {
    e_doubleClickSendsOneDecision: firstBurst.length === 1,
    d_cardFollowedStages: result.stages.length >= 1 && result.stages.every((s) => s.requirement !== stage0),
    ...(result.staleReplay ? { d_staleRefused: result.staleReplay.accepted === false && /-32053|stale/i.test(result.staleReplay.error) } : {}),
    c_turnTerminal: result.after.idle,
  };
  return result;
}

/** Clip the transcript from the last element showing `fromText` to the one showing `toText`. */
async function shotTranscript(app, fromText, toText, name) {
  const clip = await app.ev(page(`
    const leaf = (t) => q('.stream *').filter((n) => n.children.length === 0 && (n.innerText || '').includes(t)).at(-1) || null;
    const a = leaf(${JSON.stringify(fromText)}), b = leaf(${JSON.stringify(toText)});
    if (!a || !b) return null;
    b.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    const col = document.querySelector('.stream').getBoundingClientRect();
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const y = Math.max(col.y, Math.min(ra.y, rb.y) - 8), bottom = Math.min(col.y + col.height, Math.max(ra.bottom, rb.bottom) + 8);
    return { x: col.x, y, width: col.width, height: Math.max(1, bottom - y), scale: 1 };
  `));
  if (!clip) return null;
  const capture = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join("docs/evidence/2026-10-05-roadmap-closure/shots", `${name}.png`), Buffer.from(capture.data, "base64"));
  return `shots/${name}.png`;
}

async function restart(app) {
  await app.ev(INSTALL_IPC_TRACE);
  await setPosture(app, "ask");
  const { sid, startSession } = await startIn(app, state().projects.A, recipe("m05-restart"));
  saveState({ restartSid: sid });
  const card = await waitCard(app, sid);
  if (!card) throw new Error("no approval card within the bound");
  const result = { liveTurns: 1, startSession, before: { approvalId: card.snap.approvals[0].approvalId, requirement: card.snap.approvals[0].requirement, card: card.ui.cards[0] } };
  // The marker is written with the "Approval requested" entry; give the
  // webview's storage a few seconds to reach disk, as a user reading the card would.
  result.before.markerStored = Boolean(await waitFor(() => app.ev(page(`return (store(${JSON.stringify(PENDING_KEY)}, '[]') || []).includes(${JSON.stringify(sid)});`)), 10_000, 300));
  await sleep(8_000);
  app.close();
  const pid = readFileSync(PID_FILE, "utf8").trim();
  const children = () => {
    try {
      return JSON.parse(execFileSync("powershell", ["-NoProfile", "-Command",
        `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object ProcessId, Name) | ConvertTo-Json -Compress`], { encoding: "utf8" }) || "[]");
    } catch { return []; }
  };
  const hosts = [children()].flat().filter((p) => /muse/i.test(p?.Name ?? ""));
  execFileSync("taskkill", ["/F", "/PID", pid]);
  await sleep(5_000);
  const alive = hosts.filter((h) => {
    try { execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${h.ProcessId} -ErrorAction Stop | Out-Null`]); return true; } catch { return false; }
  });
  result.kill = { appKilled: true, hostsBefore: hosts.length, hostsAlive5s: alive.length };
  launchApp();
  let next = null;
  await waitFor(async () => { try { next = await openPage(); return true; } catch { return false; } }, 60_000, 1_000);
  if (!next) throw new Error("relaunched app has no CDP page");
  await waitFor(() => next.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 1_000);
  await sleep(3_000);
  await next.ev(INSTALL_IPC_TRACE);
  // The notice is written at boot, before the conversation is opened.
  const noticeAtBoot = (await fullLog(next, sid)).some((e) => e.role === "system" && /^Approval cancelled:/.test(e.text));
  await select(next, sid);
  // Opening it resumes it on a fresh host: give a card every chance to come back.
  await waitFor(async () => (await ipc(next, "list_pending_requests")).some((c) => c.args?.sessionId === sid && c.ok !== undefined), 60_000, 700);
  const phantom = await waitFor(async () => {
    const ui = await next.ev(page("return view();"));
    return ui.cards.length > 0 ? ui : null;
  }, 15_000, 700);
  const log = await fullLog(next, sid);
  const requested = log.findLastIndex((e) => e.role === "tool" && e.text.startsWith("Approval requested:"));
  const notice = log.findLastIndex((e) => e.role === "system" && /^Approval cancelled:/.test(e.text));
  result.relaunch = {
    noticeAtBoot,
    phantomCard: phantom?.cards[0] ?? null,
    view: await next.ev(page("return view();")),
    hostPending: (await pending(next, sid)).approvals.length,
    ...(await wireModes(next, [sid])),
    transcript: log.slice(Math.max(0, requested - 1)).map((e) => ({ role: e.role, text: e.text.slice(0, 220) })),
    markerAfterBoot: await next.ev(page(`return store(${JSON.stringify(PENDING_KEY)}, '[]');`)),
  };
  result.shot = await shotTranscript(next, "Approval requested:", "Approval cancelled:", "m0-05-f-restart-notice");
  result.decide = await ipc(next, "approve");
  result.consoleErrors = next.errors.slice(0, 10);
  next.close();
  result.verdict = {
    f_noPhantomCardAfterRestart: !phantom && result.relaunch.hostPending === 0,
    f_transcriptSaysCancelledByRestart: requested >= 0 && notice > requested,
    f_noDecisionSent: result.decide.length === 0,
  };
  return result;
}

/**
 * (f) variant: the renderer restarts (page reload) while the bridge and the
 * host keep running. The 1.4.2 host aborts a pending approval when its client
 * process dies (stdin EOF), so after a kill there is nothing left to rebuild;
 * a reload exercises the approval/listPending rebuild itself.
 */
async function reload(app) {
  await app.ev(INSTALL_IPC_TRACE);
  let sid = CONTINUE ? state().reloadSid : null;
  const result = { liveTurns: CONTINUE ? 0 : 1 };
  const t0 = Date.now();
  if (!sid) {
    ({ sid } = await startIn(app, state().projects.A, recipe("m05-reload")));
    saveState({ reloadSid: sid });
    const card = await waitCard(app, sid);
    if (!card) throw new Error("no approval card within the bound");
    result.before = { approvalId: card.snap.approvals[0].approvalId, card: card.ui.cards[0] };
    // Trace the boot calls of the reloaded page, then reload it.
    await app.send("Page.enable");
    const { identifier } = await app.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_IPC_TRACE });
    await app.send("Page.reload", { ignoreCache: false });
    await sleep(2_000);
    await app.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 700);
  }
  if ((await app.ev(page("return activeSid();"))) !== sid) await select(app, sid);
  const hasCard = async () => { const ui = await app.ev(page("return view();")); return ui.cards.length > 0 ? ui : null; };
  let rebuilt = await waitFor(hasCard, CONTINUE ? 3_000 : 30_000, 700);
  result.afterReload = { autoRebuilt: Boolean(rebuilt), hostPending: (await pending(app, sid)).approvals.length,
    view: await app.ev(page("return view();")),
    ...(CONTINUE ? {} : { bootListPending: (await ipc(app, "list_pending_requests")).filter((c) => c.args?.sessionId === sid).length }) };
  const readsBeforeSync = (await ipc(app, "list_pending_requests")).length;
  if (!rebuilt) {
    // The recovery row of a turn with no visible progress: Sync now re-reads the host's fold.
    result.syncNow = await app.ev(page("const b = q('.stream-health button').find((n) => n.innerText.trim() === 'Sync now'); if (b) b.click(); return { clicked: !!b };"));
    rebuilt = await waitFor(hasCard, 30_000, 700);
  }
  result.rebuilt = { msFromStart: rebuilt ? Date.now() - t0 : null, card: rebuilt?.cards[0] ?? null, health: rebuilt?.health ?? null,
    listPendingBySync: (await ipc(app, "list_pending_requests")).slice(readsBeforeSync).map((c) => ({ ok: c.ok, sameSession: c.args?.sessionId === sid })) };
  result.shot = await shot(app, CONTINUE ? "m0-05-f-sync-rebuilt" : "m0-05-f-reload-rebuilt");
  const snap = await pending(app, sid);
  const allowLabel = labelOf(snap, true);
  result.stages = rebuilt && !rebuilt.cards[0].noChoices ? await decideAll(app, sid, allowLabel) : [];
  result.after = await untilIdle(app, sid);
  result.decide = (await ipc(app, "approve")).map((d) => ({ choiceId: d.args?.choiceId, pinned: d.args?.requirementId ?? null, ok: d.ok, result: d.result }));
  result.transcript = await tail(app, sid, 4);
  result.verdict = {
    f_cardBackWithoutAction: result.afterReload.autoRebuilt,
    f_cardRebuiltFromListPending: Boolean(rebuilt) && (result.afterReload.autoRebuilt ? result.afterReload.bootListPending > 0 : result.rebuilt.listPendingBySync.some((c) => c.ok && c.sameSession)),
    f_rebuiltCardHasHostChoices: Boolean(rebuilt) && snap.approvals[0]?.choices.every((c) => rebuilt.cards[0].buttons.some((b) => b.text === c.label)),
    f_decisionWorks: result.decide.length >= 1 && result.decide.every((d) => d.ok === true) && result.after.idle,
  };
  return result;
}

async function two(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const a = await startIn(app, state().projects.A, recipe("m05-two-a"));
  const cardA = await waitCard(app, a.sid);
  const b = await startIn(app, state().projects.B, recipe("m05-two-b"));
  const cardB = await waitCard(app, b.sid);
  if (!cardA || !cardB) throw new Error("both cards were not pending");
  saveState({ twoSids: { A: a.sid, B: b.sid } });
  const result = { liveTurns: 2, approvalIds: { A: cardA.snap.approvals[0].approvalId, B: cardB.snap.approvals[0].approvalId } };
  result.bothPending = { A: (await pending(app, a.sid)).approvals.length, B: (await pending(app, b.sid)).approvals.length };
  if (process.argv.includes("--reload")) {
    // (f) the renderer restarts with both cards pending; the bridge and hosts live on.
    await app.send("Page.enable");
    const { identifier } = await app.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_IPC_TRACE });
    await app.send("Page.reload", { ignoreCache: false });
    await sleep(2_000);
    await app.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 700);
    await sleep(3_000);
    const boot = await ipc(app, "list_pending_requests");
    result.reload = { bootListPending: { A: boot.filter((c) => c.args?.sessionId === a.sid && c.ok).length, B: boot.filter((c) => c.args?.sessionId === b.sid && c.ok).length } };
  }
  await select(app, a.sid);
  result.viewA = await app.ev(page("return view();"));
  if (result.reload) result.reload.cardAWithoutAction = result.viewA.cards.length === 1 && !result.viewA.cards[0].noChoices;
  const allowLabel = labelOf(cardA.snap, true);
  result.stagesA = await decideAll(app, a.sid, allowLabel);
  result.afterA = await untilIdle(app, a.sid);
  const bWhileA = await pending(app, b.sid);
  result.bAfterA = { pending: bWhileA.approvals.length, sameApproval: bWhileA.approvals[0]?.approvalId === result.approvalIds.B,
    requirementUnchanged: JSON.stringify(bWhileA.approvals[0]?.requirement) === JSON.stringify(cardB.snap.approvals[0].requirement) };
  result.decideA = (await ipc(app, "approve")).map((d) => ({ sessionIsA: d.args?.sessionId === a.sid, sessionIsB: d.args?.sessionId === b.sid, ok: d.ok, result: d.result }));
  await select(app, b.sid);
  result.viewB = await app.ev(page("return view();"));
  if (result.reload) result.reload.cardBWithoutAction = result.viewB.cards.length === 1 && !result.viewB.cards[0].noChoices;
  result.stagesB = await decideAll(app, b.sid, allowLabel);
  result.afterB = await untilIdle(app, b.sid);
  const all = await ipc(app, "approve");
  result.decideB = all.slice(result.decideA.length).map((d) => ({ sessionIsB: d.args?.sessionId === b.sid, ok: d.ok, result: d.result }));
  result.verdict = {
    g_bothPendingTogether: result.bothPending.A === 1 && result.bothPending.B === 1,
    g_decidingAReachesOnlyA: result.decideA.length >= 1 && result.decideA.every((d) => d.sessionIsA) && result.afterA.idle,
    g_bStillPendingAfterA: result.bAfterA.pending === 1 && result.bAfterA.sameApproval && result.bAfterA.requirementUnchanged,
    g_thenB: result.decideB.length >= 1 && result.decideB.every((d) => d.sessionIsB && d.ok) && result.afterB.idle,
    ...(result.reload ? { f_bothCardsBackAfterReloadWithoutAction: result.reload.cardAWithoutAction && result.reload.cardBWithoutAction
      && result.reload.bootListPending.A > 0 && result.reload.bootListPending.B > 0 } : {}),
  };
  return result;
}

/**
 * (g) Same approval id in two conversations. The host mints a fresh UUIDv7
 * per approval, so the collision is forged in the renderer: B gets a
 * tool_request carrying A's exact live payload. The Rust side is covered by
 * approval_cards_are_isolated_when_ids_repeat_between_sessions.
 */
async function forged(app) {
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(INSTALL_FORGE);
  await setPosture(app, "ask");
  const bSid = state().twoSids.B;
  // Open B first: a cold conversation is resumed on open, and the resume
  // replaces its cards with the host's pending list.
  await select(app, bSid);
  const bResumed = await waitFor(async () => (await ipc(app, "list_pending_requests")).find((c) => c.args?.sessionId === bSid && c.ok !== undefined), 60_000, 700);
  const a = await startIn(app, state().projects.A, recipe("m05-forged-a"));
  saveState({ forgedSids: { A: a.sid, B: bSid } });
  const cardA = await waitCard(app, a.sid);
  if (!cardA) throw new Error("no approval card for A within the bound");
  const live = await waitFor(() => app.ev(`window.__forge.seen.filter((e) => e.session_id === ${JSON.stringify(a.sid)})[0] || null`), 10_000, 300);
  if (!live) throw new Error("A's tool_request was not seen on poll_events");
  const result = { liveTurns: 1, startSession: a.startSession, bResumedOk: bResumed?.ok ?? null,
    approvalIdA: cardA.snap.approvals[0].approvalId, livePayloadA: JSON.parse(live.payload) };
  await app.ev(`(window.__forge.queue.push({ session_id: ${JSON.stringify(bSid)}, kind: 'tool_request', payload: ${JSON.stringify(live.payload)} }), true)`);
  result.forgedApplied = Boolean(await waitFor(() => app.ev("window.__forge.applied.length > 0"), 10_000, 200));
  await sleep(800);
  await select(app, bSid);
  result.bBefore = await cardsWithKeys(app);
  await select(app, a.sid);
  result.aBefore = await cardsWithKeys(app);
  result.stagesA = await decideAll(app, a.sid, labelOf(cardA.snap, true));
  result.afterA = await untilIdle(app, a.sid);
  await select(app, bSid);
  result.bAfter = await cardsWithKeys(app);
  result.decide = (await ipc(app, "approve")).map((d) => ({ sessionIsA: d.args?.sessionId === a.sid, sessionIsB: d.args?.sessionId === bSid,
    approvalId: d.args?.approvalId, pinned: d.args?.requirementId ?? null, ok: d.ok, result: d.result }));
  result.bridgePendingB = (await pending(app, bSid)).approvals.length;
  result.shot = await shot(app, "m0-05-g-forged-b-kept");
  // Clean up: a reload drops the forged card (B runs nothing, so boot has no
  // card to re-read for it), and B's live host means no restart notice either.
  await app.send("Page.enable");
  await app.send("Page.reload", { ignoreCache: false });
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 700);
  await sleep(3_000);
  await select(app, bSid);
  result.afterReload = { cardsB: (await app.ev(page("return view();"))).cards.length,
    noticeB: (await fullLog(app, bSid)).some((e) => e.role === "system" && /^Approval cancelled:/.test(e.text)),
    marker: await app.ev(page(`return store(${JSON.stringify(PENDING_KEY)}, '[]');`)) };
  const keyB = `${bSid}:${result.approvalIdA}`;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  result.verdict = {
    g_forgedCardHasAsId: result.forgedApplied && result.bBefore.length === 1 && result.bBefore[0].key === keyB,
    g_decidingAUsesOnlyA: result.decide.length >= 1 && result.decide.every((d) => d.sessionIsA && !d.sessionIsB),
    g_aWentThroughItsStages: result.stagesA.length >= 1 && result.afterA.idle,
    g_bStillPendingUntouched: result.bAfter.length === 1 && same(result.bAfter[0], result.bBefore[0]),
    g_forgedNeverReachedBridge: result.bridgePendingB === 0,
    cleanup_noCardNoNoticeAfterReload: result.afterReload.cardsB === 0 && !result.afterReload.noticeB,
  };
  return result;
}

async function posture(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const target = state().userPosture === "workspace" || state().userPosture === "yolo" ? state().userPosture : "yolo";
  const { sid } = await startIn(app, state().projects.B, recipe("m05-posture"));
  saveState({ postureSid: sid });
  const card = await waitCard(app, sid);
  if (!card) throw new Error("no approval card within the bound");
  const before = card.snap.approvals[0];
  const result = { liveTurns: 1, switchedTo: target, before: { approvalId: before.approvalId, requirement: before.requirement } };
  result.switch = await setPosture(app, target);
  await sleep(4_000);
  result.setApprovalMode = (await ipc(app, "set_approval_mode")).map((c) => ({ thisSession: c.args?.sessionId === sid, mode: c.args?.mode, ok: c.ok,
    effective: (() => { try { return JSON.parse(c.result)?.effectiveMode?.mode ?? null; } catch { return null; } })() }));
  const still = await pending(app, sid);
  result.afterSwitch = { pending: still.approvals.length, sameApproval: still.approvals[0]?.approvalId === before.approvalId,
    requirementUnchanged: JSON.stringify(still.approvals[0]?.requirement) === JSON.stringify(before.requirement),
    decideCalls: (await ipc(app, "approve")).length, view: await app.ev(page("return view();")) };
  result.shot = await shot(app, "m0-06-h-switched");
  result.stages = await decideAll(app, sid, labelOf(card.snap, true));
  result.after = await untilIdle(app, sid);
  result.transcript = await tail(app, sid, 6);
  // The next action, under the new posture.
  const decidedBefore = (await ipc(app, "approve")).length;
  result.next = { sent: await followUp(app, recipe("m05-next")) };
  result.liveTurns = 2;
  const t0 = Date.now();
  let sawCard = false;
  const idle = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${JSON.stringify(sid)}) };`));
    if (s.cards.length > 0) sawCard = true;
    return Date.now() - t0 > 5_000 && s.running === "false" && s.cards.length === 0 && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "") ? s : null;
  }, 150_000, 700);
  result.next.idle = Boolean(idle);
  result.next.cardShown = sawCard;
  result.next.hostPending = (await pending(app, sid)).approvals.length;
  result.next.decideCalls = (await ipc(app, "approve")).length - decidedBefore;
  result.next.transcript = await tail(app, sid, 4);
  result.probeFile = existsSync(join(ROOTS.B, "probe.txt")) ? readFileSync(join(ROOTS.B, "probe.txt"), "utf8").trim() : null;
  result.verdict = {
    h_projectedToHost: result.setApprovalMode.some((c) => c.thisSession && c.ok && c.mode === target),
    h_pendingNotDecidedRetroactively: result.afterSwitch.pending === 1 && result.afterSwitch.sameApproval && result.afterSwitch.decideCalls === 0,
    h_pendingStillDecidable: result.stages.length >= 1 && result.after.idle,
    h_nextActionFollowsNewPosture: target === "yolo" ? result.next.idle && !result.next.cardShown && result.next.decideCalls === 0 : null,
  };
  return result;
}

const openSettings = (app) => app.ev(page("const b = q('button').find((n) => /^Settings$/i.test((n.getAttribute('aria-label') || n.innerText || '').trim())); if (b) b.click(); return !!b;"));

/** Settings > Isolation, picked like a user does; returns the stored sandbox settings. */
async function setIsolation(app, label) {
  await openSettings(app);
  await sleep(1_200);
  return app.ev(page(`
    const l = q('[role="radiogroup"][aria-label="Isolation"] label').find((x) => x.querySelector('strong')?.innerText.trim() === ${JSON.stringify(label)});
    if (!l) return { clicked: false };
    l.querySelector('input').click();
    await new Promise((r) => setTimeout(r, 600));
    return { clicked: true, stored: store('muse-desktop.settings.v1', 'null') };
  `));
}

const openProjectRow = (app, name) => app.ev(page(`
  const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click();
  await new Promise((r) => setTimeout(r, 800));
  const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(name)});
  if (!row) return false;
  row.querySelector('details').open = true;
  await new Promise((r) => setTimeout(r, 400));
  return true;
`));

/** One project preference ({ label: "Project sandbox", value: "full" }), set in the project's row. */
async function setOverride(app, name, override) {
  if (!(await openProjectRow(app, name))) throw new Error(`project ${name} row not found`);
  return app.ev(page(`
    const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(name)});
    const sel = row && row.querySelector(${JSON.stringify(`select[aria-label^="${override.label}"]`)});
    if (!sel) return { select: false };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(override.value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { select: true, value: sel.value };
  `));
}

/**
 * One more folder for test project B, and one override, set through B's row in
 * the Projects panel (the projects list is capped at 5). Each folder runs its
 * own host, so the new Isolation never meets a live host of another posture.
 */
async function ensureRoot(app, key, override) {
  mkdirSync(ROOTS[key], { recursive: true });
  if (!existsSync(join(ROOTS[key], ".git"))) execFileSync("git", ["init", "-q"], { cwd: ROOTS[key] });
  const find = () => app.ev(page(`return (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAMES.B)}) || null;`));
  const roots = (p) => (p.workspaces && p.workspaces.length > 0 ? p.workspaces : [p.workspace]).filter(Boolean);
  if (!(await openProjectRow(app, NAMES.B))) throw new Error("project B row not found");
  if (!roots(await find()).includes(ROOTS[key])) {
    await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([ROOTS[key]])}), true)`);
    await app.ev(page(`
      const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(NAMES.B)});
      button('Add folder', row).click();
      await new Promise((r) => setTimeout(r, 800));
      button('Save', row).click();
      await new Promise((r) => setTimeout(r, 800));
      return true;
    `));
  }
  const set = await setOverride(app, NAMES.B, override);
  const project = await find();
  const index = roots(project).indexOf(ROOTS[key]);
  if (index < 0) throw new Error(`folder ${key} not added to project B`);
  return { id: project.id, index, set, settings: project.settings ?? null, roots: roots(project).length };
}

const NETWORK_COMMAND = "$u = 'https://example.com'; Invoke-WebRequest -Uri $u -UseBasicParsing | Select-Object -ExpandProperty StatusCode";
// Same request through Windows' own curl.exe: tells a PowerShell quirk from a sandbox block.
const CURL_COMMAND = "$u = 'https://example.com'; curl.exe -s -o NUL -w '%{http_code}' $u";

/**
 * (M0-06) The middle posture under a wider Isolation, measured in the app:
 * network = a project allowing network under the user's "Workspace and
 * network"; elevated = a "Full access" project under "Elevated access".
 */
async function isolation(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const kind = TAG?.startsWith("elevated") ? "elevated" : "network";
  const result = { liveTurns: 1, kind };
  result.project = await ensureRoot(app, kind, kind === "network"
    ? { label: "Project network", value: "allow" }
    : { label: "Project sandbox", value: "full" });
  if (kind === "elevated") {
    result.isolationBefore = await app.ev(page("return store('muse-desktop.settings.v1', 'null');"));
    result.setElevated = await setIsolation(app, "Elevated access");
  }
  mkdirSync(OUTSIDE, { recursive: true });
  const marker = join(OUTSIDE, `elevated-${Date.now().toString(36)}.txt`);
  const network = TAG?.endsWith("-curl") ? CURL_COMMAND : NETWORK_COMMAND;
  const command = kind === "network" ? network : `$p = '${marker}'; Set-Content -Path $p -Value 'm06'; ${network}`;
  result.command = command;
  result.setPosture = await setPosture(app, "workspace");
  await sleep(3_000);
  // Every conversation connected right now gets the new posture.
  result.postureProjection = (await wireModes(app)).setApprovalMode;
  try {
    const { sid, startSession } = await startIn(app, result.project.id,
      `Use your PowerShell tool to run exactly this one command, unchanged, a single time, then answer in one short line: ${command}`, result.project.index);
    saveState({ isolationSids: { ...(state().isolationSids ?? {}), [kind]: sid } });
    result.startSession = startSession;
    result.run = await allowUntilIdle(app, sid);
    const log = (await fullLog(app, sid)).filter((e) => e.role !== "user");
    result.transcript = log.slice(-8).map((e) => ({ role: e.role, text: e.text.slice(0, 260) }));
    // The shell output lane is logged as its own entry (assistant role): a bare "200" is the status code itself.
    result.statusCode200 = log.some((e) => /^\s*200\s*$/.test(e.text));
    if (kind === "elevated") result.outsideWrite = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
    result.wire = await wireModes(app, [sid]);
  } finally {
    if (kind === "elevated") result.isolationRestored = await setIsolation(app, "Workspace and network");
  }
  result.cell = {
    posture: "workspace (onRequest)",
    isolation: kind,
    asked: result.run.stages.length > 0,
    stages: result.run.stages.length,
    network: result.statusCode200 ? "completed" : "failed",
    ...(kind === "elevated" ? { writeOutsideRoot: result.outsideWrite === "m06" ? "completed" : "failed" } : {}),
  };
  result.verdict = {
    startedUnderMiddlePosture: result.startSession?.authorizationMode === "workspace" && result.startSession?.hostApprovalMode === "onRequest",
    startedWithIsolation: result.startSession?.sandboxMode === kind,
    turnTerminal: result.run.idle,
    ...(kind === "elevated" ? { isolationRestored: result.isolationRestored?.stored?.mode === "network" } : {}),
  };
  if (existsSync(marker)) rmSync(marker);
  return result;
}

/** Decision D1: what still works under the default isolation on Windows (YOLO, so no card). */
async function d1(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const tag = Date.now().toString(36);
  const files = { tool: join(ROOTS.A, `d1-tool-${tag}.txt`), absolute: join(ROOTS.A, `d1-abs-${tag}.txt`) };
  const result = { liveTurns: 1, setPosture: await setPosture(app, "yolo") };
  const { sid, startSession } = await startIn(app, state().projects.A,
    `Do exactly these two steps, once each, unchanged, then answer in one short line. ` +
    `1) Use your write_file tool to create the file d1-tool-${tag}.txt in the workspace with the content m06. ` +
    `2) Use your PowerShell tool to run exactly: Set-Content -Path '${files.absolute}' -Value 'm06'`);
  saveState({ d1Sid: sid });
  result.startSession = startSession;
  result.run = await allowUntilIdle(app, sid);
  const log = (await fullLog(app, sid)).filter((e) => e.role !== "user");
  result.transcript = log.slice(-8).map((e) => ({ role: e.role, text: e.text.slice(0, 260) }));
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : null);
  result.files = { writeFileTool: read(files.tool), absolutePowerShell: read(files.absolute) };
  for (const p of Object.values(files)) if (existsSync(p)) rmSync(p);
  result.verdict = {
    startedUnderYolo: startSession.authorizationMode === "yolo" && startSession.hostApprovalMode === "allowAll",
    noCard: result.run.stages.length === 0,
    writeFileToolWorks: result.files.writeFileTool === "m06",
    absolutePathWorks: result.files.absolutePowerShell === "m06",
    turnTerminal: result.run.idle,
  };
  return result;
}

/** Close the app the way a user does (window close), then start it again from PowerShell. */
async function relaunch(app) {
  app.close();
  const pid = readFileSync(PID_FILE, "utf8").trim();
  try { execFileSync("taskkill", ["/PID", pid], { stdio: "ignore" }); } catch { /* already gone */ }
  const gone = await waitFor(() => {
    try { execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], { stdio: "ignore" }); return false; } catch { return true; }
  }, 20_000, 1_000);
  if (!gone) execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
  await sleep(3_000);
  launchApp();
  let next = null;
  await waitFor(async () => { try { next = await openPage(); return true; } catch { return false; } }, 60_000, 1_000);
  if (!next) throw new Error("relaunched app has no CDP page");
  await waitFor(() => next.ev(page("return Boolean(document.querySelector('li.session-item'));")), 60_000, 1_000);
  await sleep(3_000);
  return next;
}

/**
 * Open a conversation and, when that resumes it (cold after a launch), wait
 * for the whole reconnect: resume, then the posture re-projection.
 */
async function openAndSettle(app, sid) {
  const before = (await ipc(app, "resume_session")).length;
  await select(app, sid);
  await sleep(2_000);
  if (!(await ipc(app, "resume_session")).slice(before).some((c) => c.args?.sessionId === sid)) return false;
  await waitFor(async () => (await ipc(app, "set_approval_mode")).some((c) => c.args?.sessionId === sid && c.ok !== undefined), 60_000, 700);
  return true;
}

/**
 * (M0-06) Ask -> promptUnmatched on the wire. Each round loads the measured
 * conversations, selects one posture (setApprovalMode answers kept), closes
 * the app and starts it again; reopening them then resumes them cold, and
 * resume answers with the posture the host persisted. Another conversation is
 * left open at each close: the boot resumes the open one before any trace.
 */
async function wire(app) {
  const st = state();
  const measured = [st.restartSid, st.isolationSids?.network, st.d1Sid].filter(Boolean);
  const parking = st.forgedSids?.A;
  const expected = { ask: "promptUnmatched", workspace: "onRequest", yolo: "allowAll" };
  const result = { liveTurns: 0, measured, rounds: [] };
  let cur = app;
  for (const mode of ["ask", "workspace", "yolo"]) {
    await cur.ev(INSTALL_IPC_TRACE);
    for (const sid of measured) await openAndSettle(cur, sid);
    const before = (await ipc(cur, "set_approval_mode")).length;
    const picked = await setPosture(cur, mode);
    await sleep(4_000);
    const round = { selected: mode, stored: picked.stored, expected: expected[mode],
      setApprovalMode: (await wireModes(cur)).setApprovalMode.slice(before) };
    if (parking) await select(cur, parking);
    cur = await relaunch(cur);
    await cur.ev(INSTALL_IPC_TRACE);
    round.selectorAtLaunch = await cur.ev(page("return localStorage.getItem('muse-desktop.authorization-mode.v1');"));
    round.resumedCold = [];
    for (const sid of measured) round.resumedCold.push(await openAndSettle(cur, sid));
    round.reopen = await wireModes(cur, measured);
    result.rounds.push(round);
  }
  result.consoleErrors = cur.errors.slice(0, 10);
  if (cur !== app) cur.close();
  result.verdict = {
    everySwitchConfirmedByTheHost: result.rounds.every((r) => measured.every((sid) => r.setApprovalMode
      .some((x) => x.sessionId === sid && x.ok && x.status === "accepted" && x.effectiveMode === r.expected))),
    resumeAnswersThePersistedPosture: result.rounds.every((r) => r.reopen.resume.length === measured.length
      && r.reopen.resume.every((x) => x.ok && x.hostApprovalMode === r.expected)),
  };
  return result;
}

/**
 * The Settings texts, read from the running app, checked claim by claim
 * against the 1.4.2 matrix and the isolation / d1 phases of this record.
 */
async function texts(app) {
  await openSettings(app);
  await sleep(1_200);
  const ui = await app.ev(page(`
    const read = (group) => q('[role="radiogroup"][aria-label="' + group + '"] label').map((l) => ({
      label: l.querySelector('strong')?.innerText.trim(), text: l.querySelector('.authorization-mode-copy > span')?.innerText.trim() }));
    const note = (h) => q('.settings-group').find((g) => g.querySelector('h3')?.innerText.trim() === h)?.querySelector('.settings-note')?.innerText.replace(/\\s+/g, ' ').trim() || null;
    return { postures: read('Global authorization mode'), isolation: read('Isolation'), isolationNote: note('Isolation'),
      composer: [...document.querySelectorAll('button[role="menuitemradio"]')].map((b) => ({ label: b.querySelector('strong')?.textContent.trim(), text: b.querySelector('small')?.textContent.trim() })) };
  `));
  const matrix = readJson(MATRIX, null);
  const record = readJson(OUT, { phases: {} });
  const net = record.phases["isolation-network"]?.cell;
  const netCurl = record.phases["isolation-network-curl"]?.cell;
  const netStart = record.phases["isolation-network"]?.startSession;
  const elev = record.phases["isolation-elevated"]?.cell;
  const d1run = record.phases.d1?.verdict;
  const cells = (posture, mode) => matrix.runs.find((r) => r.posture === posture)?.modes.find((m) => m.mode === mode)?.cells ?? [];
  const cell = (posture, mode, action) => cells(posture, mode).find((c) => c.action === action);
  const offProfile = matrix.workspaceOutsideProfile.cells.map((c) => ({ mode: c.mode, ...c.cell }));
  const text = (list, label) => list.find((x) => x.label === label)?.text ?? null;
  const onRequest = [...cells("workspace", "onRequest"), ...cells("elevated", "onRequest")];
  const allowAll = [...cells("workspace", "allowAll"), ...offProfile.filter((c) => c.mode === "allowAll")];
  const workspaceCells = [...cells("workspace", "promptUnmatched"), ...cells("workspace", "onRequest"), ...cells("workspace", "allowAll"), ...offProfile];
  const outcomes = (action) => workspaceCells.filter((c) => c.action === action).map((c) => c.outcome);
  const middle = text(ui.postures, POSTURE_LABEL.workspace);
  const middleWire = (record.phases.wire?.rounds ?? []).filter((r) => r.expected === "onRequest").flatMap((r) => r.setApprovalMode);
  const shellAsked = [...onRequest.map((c) => c.approvalRequested), net?.asked, netCurl?.asked, elev?.asked].filter((x) => typeof x === "boolean");
  const claims = [
    { text: text(ui.postures, POSTURE_LABEL.ask), claim: "asks before any action the engine's own rules do not allow",
      measured: cells("workspace", "promptUnmatched").map((c) => `${c.action}: asked=${c.approvalRequested}`),
      contradiction: !cells("workspace", "promptUnmatched").every((c) => c.approvalRequested) },
    { text: middle, claim: "the engine's sandbox decides: the posture is the host's onRequest mode",
      measured: [`wire: ${middleWire.filter((x) => x.ok && x.effectiveMode === "onRequest").length}/${middleWire.length} setApprovalMode confirmed onRequest`],
      contradiction: middleWire.length === 0 ? null : !middleWire.every((x) => x.ok && x.effectiveMode === "onRequest") },
    { text: middle, claim: "on Windows it asks for shell commands",
      measured: [`matrix onRequest: ${onRequest.filter((c) => c.approvalRequested).length}/${onRequest.length} asked`,
        `in app, network isolation: asked=${net?.asked}, stages=${net?.stages}; curl variant asked=${netCurl?.asked}, stages=${netCurl?.stages}`,
        `in app, elevated isolation: asked=${elev?.asked}, stages=${elev?.stages}`],
      contradiction: !shellAsked.every(Boolean) },
    { text: middle, claim: "no promise that anything runs without asking",
      measured: [`label: ${POSTURE_LABEL.workspace}`], contradiction: /without asking|on my behalf|runs what/i.test(`${middle} ${ui.isolationNote}`) },
    { text: text(ui.postures, "YOLO"), claim: "never asks; Isolation still limits what an action reaches",
      measured: allowAll.map((c) => `${c.action}: asked=${c.approvalRequested}, outcome=${c.outcome}`).concat([`d1 (in app): card=${d1run ? !d1run.noCard : "n/a"}`]),
      contradiction: allowAll.some((c) => c.approvalRequested) || d1run?.noCard === false || !allowAll.some((c) => c.outcome === "failed") },
    { text: text(ui.isolation, "Workspace only"), claim: "writes stay inside the folder, no network, reads reach other folders",
      measured: [`writeOutsideRoot: ${outcomes("writeOutsideRoot").join(",")}`, `network: ${outcomes("network").join(",")}`,
        `readOutsideRoot: ${outcomes("readOutsideRoot").join(",")}`, `readThroughJunction: ${outcomes("readThroughJunction").join(",")}`],
      contradiction: outcomes("writeOutsideRoot").includes("completed") || outcomes("network").includes("completed")
        || !outcomes("readOutsideRoot").includes("completed") },
    { text: text(ui.isolation, "Workspace and network"), claim: "asks the engine to allow outbound network (a request, not a promise)",
      measured: [`in app: start_session sandboxMode=${netStart?.sandboxMode} (host flag --sandbox-network enabled)`],
      contradiction: netStart ? netStart.sandboxMode !== "network" || /^Adds outbound network/i.test(text(ui.isolation, "Workspace and network") ?? "") : null },
    { text: ui.isolationNote, claim: "Windows 1.4.2: the sandboxed shell got no network at either level; only Elevated access reached it",
      measured: [`workspace isolation (matrix): network ${outcomes("network").join(",")}`,
        `network isolation (in app): Invoke-WebRequest ${net?.network ?? "not measured"}, curl.exe ${netCurl?.network ?? "not measured"}`,
        `elevated isolation (in app): ${elev?.network ?? "not measured"}`],
      contradiction: !net || !elev ? null : outcomes("network").includes("completed") || net.network === "completed"
        || netCurl?.network === "completed" || elev.network !== "completed" },
    { text: text(ui.isolation, "Elevated access"), claim: "adds files and commands outside the folder",
      measured: [`in app, elevated isolation, onRequest, Allow once: writeOutsideRoot=${elev?.writeOutsideRoot ?? "not measured"}, network=${elev?.network ?? "not measured"}`,
        `matrix elevated writeInsideRoot (onRequest): ${cell("elevated", "onRequest", "writeInsideRoot")?.outcome}`],
      contradiction: elev ? elev.writeOutsideRoot !== "completed" : null },
    { text: ui.isolationNote, claim: "Windows 1.4.2: relative PowerShell paths fail; absolute paths and Muse's file tools work",
      measured: [`writeInsideRoot, relative path (matrix, workspace isolation): ${outcomes("writeInsideRoot").join(",")}`,
        `d1 (in app, YOLO, workspace isolation): absolutePathWorks=${d1run?.absolutePathWorks}, writeFileToolWorks=${d1run?.writeFileToolWorks}`],
      contradiction: !d1run ? null : outcomes("writeInsideRoot").includes("completed") || !d1run.absolutePathWorks || !d1run.writeFileToolWorks },
    { text: ui.isolationNote, claim: "applied when a new engine starts", measured: ["not measured here (M2-02)"], contradiction: null },
  ];
  return { liveTurns: 0, ui, claims, contradictions: claims.filter((c) => c.contradiction === true).length,
    unmeasured: claims.filter((c) => c.contradiction === null).length };
}

/** Put back the posture and isolation the user had before the proof. */
async function restore(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const { userPosture, userIsolation } = state();
  const posture = await setPosture(app, userPosture ?? "ask");
  const settings = await app.ev(page("return store('muse-desktop.settings.v1', 'null');"));
  // Test project B back to its own folder and the global preferences.
  if (!(await openProjectRow(app, NAMES.B))) throw new Error("project B row not found");
  await app.ev(page(`
    const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(NAMES.B)});
    for (const prefix of ['Project network', 'Project sandbox']) {
      const sel = row.querySelector('select[aria-label^="' + prefix + '"]');
      const global = sel && (sel.getAttribute('aria-label').match(/global ([^)]+)\\)/) || [])[1];
      if (!global || sel.value === global) continue;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, global);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
    for (const extra of ${JSON.stringify([ROOTS.network, ROOTS.elevated])}) {
      const li = [...row.querySelectorAll('.workspace-root-row')].find((x) => x.querySelector('.workspace-path')?.getAttribute('title') === extra);
      if (li) { li.querySelector('button').click(); await new Promise((r) => setTimeout(r, 300)); }
    }
    const save = button('Save', row);
    if (save && !save.disabled) { save.click(); await new Promise((r) => setTimeout(r, 800)); }
    return true;
  `));
  const projectB = await app.ev(page(`const p = (store('muse-desktop.projects.v1', '[]') || []).find((x) => x.name === ${JSON.stringify(NAMES.B)});
    return p ? { roots: (p.workspaces && p.workspaces.length ? p.workspaces : [p.workspace]).length, settings: p.settings || null } : null;`));
  return { liveTurns: 0, posture, isolation: settings?.mode ?? null, projectB,
    verdict: { postureRestored: posture.stored === userPosture, isolationRestored: settings?.mode === userIsolation,
      projectBRestored: projectB?.roots === 1 && Object.keys(projectB?.settings ?? {}).length === 0 } };
}

// ---- M0-06, policy in force: the isolated app -----------------------------

/** The app's engines as the OS runs them (its `serve` children): pid -> argv, the exe redacted. */
function engines() {
  if (!TEST_DATA) return {};
  const pid = Number(readFileSync(join(TEST_DATA, "test-mode.pid"), "utf8").trim());
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CommandLine -match ' serve( |$)' } | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }`],
  { encoding: "utf8" });
  return Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, cmd] = line.split("|");
    return [id, cmd.replace(/^("[^"]*"|\S+)/, "<engine>")];
  }));
}

/** The engine a start spawned, or the reuse of a running one. */
const engineSince = (before) => {
  const fresh = Object.entries(engines()).filter(([id]) => !(id in before)).map(([, argv]) => argv);
  return fresh.length > 0 ? fresh.join(" | ") : "reused a running engine";
};

/** The project's row > "New conversation here": a conversation, no message, no turn. */
async function startBare(app, key) {
  const before = (await ipc(app, "start_session")).length;
  const running = engines();
  if (!(await openProjectRow(app, NAMES[key]))) throw new Error(`project ${key} row not found`);
  const clicked = await app.ev(page(`
    const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(NAMES[key])});
    const b = row && button('New conversation here', row);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  `));
  if (!clicked) throw new Error(`no "New conversation here" in project ${key}`);
  const started = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > before && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
  let meta = null;
  try { meta = JSON.parse(started?.result ?? "null"); } catch { /* an error string */ }
  return {
    ok: Boolean(started?.ok), sessionId: meta?.session_id ?? null,
    requested: { authorizationMode: started?.args?.authorizationMode ?? null, sandboxMode: started?.args?.sandboxMode ?? null },
    hostApprovalMode: meta?.approval_mode ?? null,
    engine: engineSince(running),
    ...(started?.ok ? {} : { error: String(meta ?? started?.result ?? "no answer").slice(0, 300) }),
  };
}

/**
 * (M0-06) Which Isolation a project conversation really gets, with no turn.
 * A keeps the default project preferences (Sandbox "Project", Network "Ask"),
 * N allows network. Then A asks for Elevated while its engine runs Workspace
 * only: the running engine keeps its posture.
 */
async function scope(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const result = { liveTurns: 0, cases: [] };
  result.overrideN = await setOverride(app, NAMES.N, { label: "Project network", value: "allow" });
  for (const [isolation, key] of [["Workspace and network", "A"], ["Workspace and network", "N"], ["Elevated access", "A"], ["Elevated access", "N"]]) {
    const set = await setIsolation(app, isolation);
    result.cases.push({ isolation, project: key, stored: set.stored?.mode ?? null, ...(await startBare(app, key)) });
  }
  // Still under Elevated access: A's preferences now allow it, A's engine runs Workspace only.
  result.overrideA = await setOverride(app, NAMES.A, { label: "Project sandbox", value: "full" });
  result.change = { isolation: "Elevated access", project: "A (Sandbox Full access)", ...(await startBare(app, "A")) };
  result.resetA = await setOverride(app, NAMES.A, { label: "Project sandbox", value: "workspace" });
  result.restored = await setIsolation(app, "Workspace only");
  const mode = (isolation, key) => result.cases.find((c) => c.isolation === isolation && c.project === key)?.requested.sandboxMode;
  result.verdict = {
    defaultProjectStaysWorkspace: mode("Workspace and network", "A") === "workspace" && mode("Elevated access", "A") === "workspace",
    networkProjectGetsNetwork: mode("Workspace and network", "N") === "network" && mode("Elevated access", "N") === "network",
    engineArgvMatches: result.cases.every((c) => c.engine === "reused a running engine"
      || c.engine.includes(c.requested.sandboxMode === "network" ? "--sandbox-network enabled" : "--sandbox-network restricted")),
    runningEngineKeepsItsPosture: !result.change.ok && /restart the workspace host/.test(result.change.error ?? ""),
  };
  return result;
}

/** One write outside the folder, then one HTTPS call; each prints its own outcome. */
const policyCommand = (file) => `$p = '${file}'; try { Set-Content -Path $p -Value 'm06' -ErrorAction Stop; 'write=ok' } catch { 'write=' + $_.Exception.GetType().Name }; ` +
  "$u = 'https://example.com'; try { 'net=' + (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15).StatusCode } catch { 'net=' + $_.Exception.Status }";

/**
 * (M0-06) The middle posture in a test project: workspace = the default
 * Isolation in project A; elevated = "Elevated access" in project B, whose
 * Sandbox is "Full access" (the scope phase shows why). The first card is read
 * in the DOM against the host's choices (no client rule button, no rules list).
 */
async function policy(app) {
  await app.ev(INSTALL_IPC_TRACE);
  const kind = TAG === "elevated" ? "elevated" : "workspace";
  const key = kind === "elevated" ? "B" : "A";
  const result = { liveTurns: 1, kind, project: key };
  result.setIsolation = await setIsolation(app, kind === "elevated" ? "Elevated access" : "Workspace only");
  if (kind === "elevated") result.override = await setOverride(app, NAMES.B, { label: "Project sandbox", value: "full" });
  result.setPosture = await setPosture(app, "workspace");
  mkdirSync(OUTSIDE, { recursive: true });
  const marker = join(OUTSIDE, `${kind}-${Date.now().toString(36)}.txt`);
  result.command = policyCommand(marker);
  const running = engines();
  const { sid, startSession } = await startIn(app, state().projects[key],
    `Use your PowerShell tool to run exactly this one command, unchanged, a single time, then answer in one short line: ${result.command}`);
  saveState({ policySids: { ...(state().policySids ?? {}), [kind]: sid } });
  result.startSession = startSession;
  result.engine = engineSince(running);
  const card = await waitCard(app, sid);
  if (card) {
    result.card = {
      msToCard: card.msToCard,
      hostChoices: card.snap.approvals[0].choices,
      dom: card.ui.cards[0],
      panel: await app.ev(page(`const p = q('.approvals')[0]; return p ? { text: p.innerText.replace(/\\s+/g, ' ').slice(0, 800),
        controls: [...p.querySelectorAll('button, input, select, a[href]')].map((n) => n.tagName.toLowerCase() + ':' + (n.innerText || n.getAttribute('aria-label') || '').trim()) } : null;`)),
      shot: await shot(app, `m0-06-card-${kind}`),
    };
  }
  result.run = await allowUntilIdle(app, sid);
  const log = (await fullLog(app, sid)).filter((e) => e.role !== "user");
  result.transcript = log.slice(-8).map((e) => ({ role: e.role, text: e.text.slice(0, 260) }));
  // Assistant entries only: the command's echo (a tool entry) also holds "write=" and "net=".
  const said = log.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
  result.write = said.match(/write=(\w+)/)?.[1] ?? null;
  result.net = said.match(/net=(\w+)/)?.[1] ?? null;
  result.outsideFile = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  if (existsSync(marker)) rmSync(marker);
  result.cell = {
    posture: "Ask only for more access (onRequest)", isolation: kind, project: key,
    hostSandboxMode: startSession.sandboxMode, hostApprovalMode: startSession.hostApprovalMode, engine: result.engine,
    asked: result.run.stages.length > 0, stages: result.run.stages.length,
    writeOutside: result.outsideFile === "m06" ? "completed" : "failed", writeError: result.write === "ok" ? null : result.write,
    network: result.net === "200" ? "completed" : "failed", networkStage: result.net === "200" ? "ok" : WEB_STAGE[result.net] ?? result.net,
  };
  const labels = (result.card?.hostChoices ?? []).map((c) => c.label);
  result.verdict = {
    startedUnderMiddlePosture: startSession.authorizationMode === "workspace" && startSession.hostApprovalMode === "onRequest",
    startedWithIsolation: startSession.sandboxMode === kind,
    turnTerminal: result.run.idle,
    cardButtonsAreTheHostChoices: Boolean(result.card) && JSON.stringify(result.card.dom.buttons.map((b) => b.text)) === JSON.stringify(labels),
    cardHasNoOtherControl: Boolean(result.card?.panel) && result.card.panel.controls.length === labels.length,
    cardHasNoClientRule: Boolean(result.card?.panel) && !/allow in workspace|authorization rules|\brules?\b/i.test(result.card.panel.text),
  };
  return result;
}

/**
 * Each sentence Settings (and the composer's posture menu) shows, by exact
 * text, with what it claims and the measured cells behind it. A sentence
 * that changes must be mapped again here: an unmapped one fails the phase.
 * `e` holds the evidence: msp (this campaign's matrix), m05 and appr (the
 * 05/10 matrix and in-app records), rec (this record's phases).
 */
const SENTENCES = [
  { text: "Muse asks before any action the engine's own rules do not allow.",
    claim: "under promptUnmatched nothing outside the engine's rules runs without a card",
    check: (e) => {
      const shell = [...e.m05Cells("workspace", "promptUnmatched"), ...e.mspCells(null, "promptUnmatched", "writeThroughJunction")];
      const writeFile = e.mspCells(null, "promptUnmatched", "writeThroughJunction").map((c) => c.landedOutsideRoot);
      return { measured: [...shell.map((c) => `${c.src} ${c.action}: asked=${c.approvalRequested}`),
        ...writeFile.map((l) => `msp write_file outside the root: refused by the engine, landed=${l.writeFileThroughJunction || l.writeFileThroughPrivateJunction}`)],
      contradiction: shell.some((c) => !c.approvalRequested) || writeFile.some((l) => l.writeFileThroughJunction || l.writeFileThroughPrivateJunction) };
    } },
  { text: "The engine's sandbox decides when Muse asks.",
    claim: "the middle posture is the host's own onRequest mode",
    check: (e) => {
      const modes = [...["workspace", "elevated"].map((k) => `app policy-${k}: session/start approvalMode=${e.rec[`policy-${k}`]?.startSession?.hostApprovalMode}`),
        ...e.mspModes("onRequest").map((m) => `${m.src}: setApprovalMode effective=${m.modeSet?.effectiveMode}`)];
      return { measured: modes, contradiction: modes.length === 0 || modes.some((m) => !m.endsWith("onRequest")) };
    } },
  { text: "On Windows it asks for shell commands.",
    claim: "every shell command under onRequest raised a card",
    check: (e) => {
      const cells = [...e.mspCells(null, "onRequest", null), ...e.m05Cells("workspace", "onRequest"), ...e.m05Cells("elevated", "onRequest")];
      const app = ["workspace", "elevated"].map((k) => e.rec[`policy-${k}`]?.cell).filter(Boolean);
      return { measured: [`msp and 05/10 matrix, onRequest: ${cells.filter((c) => c.approvalRequested).length}/${cells.length} asked`,
        ...app.map((c) => `app policy-${c.isolation}: asked=${c.asked}, stages=${c.stages}`)],
      contradiction: cells.some((c) => !c.approvalRequested) || app.some((c) => !c.asked) };
    } },
  { text: "Muse never asks.",
    claim: "allowAll raised no card",
    check: (e) => {
      const cells = [...e.m05Cells("workspace", "allowAll"), ...e.m05OffProfile("allowAll")];
      return { measured: [...cells.map((c) => `${c.src} ${c.action}: asked=${c.approvalRequested}`), `05/10 app d1: card=${!e.appr?.phases?.d1?.verdict?.noCard}`],
        contradiction: cells.some((c) => c.approvalRequested) || e.appr?.phases?.d1?.verdict?.noCard === false };
    } },
  { text: "Your Isolation setting still limits what an action can reach.",
    claim: "under allowAll the sandbox still blocked an out-of-root write and the network",
    check: (e) => {
      const cells = e.m05Cells("workspace", "allowAll").filter((c) => c.action !== "writeInsideRoot");
      return { measured: cells.map((c) => `${c.src} ${c.action}: ${c.outcome}`), contradiction: cells.length === 0 || cells.some((c) => c.outcome === "completed") };
    } },
  // Isolation levels, 05/10 wording (read before the change).
  { text: "Writes stay inside the conversation's folder, with no network.",
    claim: "no write outside the folder and no network at all",
    check: (e) => {
      const w = e.writesOutside();
      const net = e.mspNetwork("workspace");
      return { measured: [...w.measured, ...net.map((n) => `msp restricted: dns=${n.dns}, tcp 80/443=${n.tcp_80}/${n.tcp_443}`)],
        contradiction: w.landed || net.some((n) => n.dns === "ok"), why: "names resolve: DNS is network, so 'no network' overstates it" };
    } },
  { text: "Reads can reach other folders.",
    claim: "a read outside the folder, and through a junction, succeeds",
    check: (e) => {
      const cells = [...e.m05Cells("workspace", "promptUnmatched"), ...e.m05Cells("workspace", "onRequest")].filter((c) => /^read/.test(c.action));
      return { measured: cells.map((c) => `${c.src} ${c.action}: ${c.outcome}`), contradiction: !cells.some((c) => c.outcome === "completed") };
    } },
  { text: "Also asks the engine to allow outbound network: package installs, API calls, downloads.",
    claim: "package installs, API calls and downloads (HTTPS) get through",
    check: (e) => {
      const net = e.mspNetwork("network");
      return { measured: net.map((n) => `msp enabled: https iwr=${n.iwr_https}, curl=${n.curl_https} (${n.curl_https_detail})`),
        contradiction: net.length === 0 ? null : net.some((n) => n.iwr_https !== "ok" || n.curl_https !== "ok"), why: "HTTPS fails at the TLS stage" };
    } },
  { text: "Adds files and commands outside the folder.",
    claim: "an approved write outside the folder lands, with the sandbox off",
    check: (e) => {
      const c = e.rec["policy-elevated"]?.cell;
      return { measured: [`app policy-elevated: writeOutside=${c?.writeOutside}, engine ${c?.engine}`],
        contradiction: !c ? null : c.writeOutside !== "completed" || !/--disable-sandbox/.test(c.engine) };
    } },
  { text: "Grant it to a workspace you trust.",
    claim: "it is granted per project: only a project whose Sandbox is Full access gets it",
    check: (e) => {
      const a = e.scopeCase("Elevated access", "A");
      const b = e.rec["policy-elevated"];
      return { measured: [`app scope: project A (default Sandbox) under Elevated access -> ${a?.requested.sandboxMode}`,
        `app policy-elevated: project B (Sandbox Full access) -> ${b?.startSession?.sandboxMode}`],
      contradiction: !a || !b ? null : a.requested.sandboxMode !== "workspace" || b.startSession.sandboxMode !== "elevated" };
    } },
  // Isolation note.
  { text: "How far Muse's engine can reach.",
    claim: "the level is the engine's own sandbox flags",
    check: (e) => {
      const argv = [...e.rec.scope?.cases ?? [], { requested: e.rec["policy-elevated"]?.startSession, engine: e.rec["policy-elevated"]?.engine }]
        .filter((c) => c.engine && c.engine !== "reused a running engine").map((c) => `${c.requested?.sandboxMode}: ${c.engine}`);
      const flags = { workspace: "--sandbox-network restricted", network: "--sandbox-network enabled", elevated: "--disable-sandbox --sandbox-network enabled" };
      return { measured: argv.map((a) => `app engine argv, ${a}`),
        contradiction: argv.length === 0 || argv.some((a) => !a.includes(flags[a.split(":")[0]])) };
    } },
  { text: "Applied when a new engine starts: a running conversation keeps its own until it is restarted.",
    claim: "a running engine keeps its flags; another posture for its folder is refused until a restart",
    check: (e) => {
      const change = e.rec.scope?.change;
      return { measured: [`app scope: Elevated access asked for folder A while its engine runs Workspace only -> ${change?.ok ? "started" : change?.error}`],
        contradiction: !change ? null : change.ok || !/restart the workspace host/.test(change.error ?? "") };
    } },
  { text: "On Windows with Muse 1.4.2, sandboxed PowerShell commands fail on relative paths (Set-Content -Path notes.txt), while absolute paths and Muse's own file tools work.",
    claim: "relative PowerShell writes fail in the sandbox; absolute paths and write_file work in the folder",
    check: (e) => {
      const rel = [...e.m05Cells("workspace", "promptUnmatched"), ...e.m05Cells("workspace", "onRequest")].filter((c) => c.action === "writeInsideRoot");
      const d1 = e.appr?.phases?.d1?.verdict;
      return { measured: [...rel.map((c) => `${c.src} writeInsideRoot (relative): ${c.outcome}`),
        `05/10 app d1: absolutePathWorks=${d1?.absolutePathWorks}, writeFileToolWorks=${d1?.writeFileToolWorks}`],
      contradiction: rel.some((c) => c.outcome === "completed") || !d1?.absolutePathWorks || !d1?.writeFileToolWorks };
    } },
  { text: "The sandboxed shell got no network at either level, Workspace and network included; only Elevated access reached it.",
    claim: "no connection at all under Workspace and network",
    check: (e) => {
      const net = e.mspNetwork("network");
      return { measured: net.map((n) => `msp enabled: tcp 80/443=${n.tcp_80}/${n.tcp_443}, http iwr=${n.iwr_http}, curl=${n.curl_http}`),
        contradiction: net.length === 0 ? null : net.some((n) => n.tcp_443 === "ok" || n.iwr_http === "ok"), why: "connections open and plain HTTP works" };
    } },
  // 06/10 wording, written from the cells above and below.
  { text: "Writes stay inside the conversation's folder, and commands cannot connect out.",
    claim: "no write outside the folder (junctions included, either tool); every connect refused",
    check: (e) => {
      const w = e.writesOutside();
      const net = e.mspNetwork("workspace");
      const app = e.rec["policy-workspace"]?.cell;
      const connects = (n) => [n.tcp_80, n.tcp_443, n.iwr_http, n.iwr_https, n.tnc_443];
      return { measured: [...w.measured, ...net.map((n) => `msp restricted: tcp 80/443=${n.tcp_80}/${n.tcp_443}, iwr http/https=${n.iwr_http}/${n.iwr_https}, tnc=${n.tnc_443}`),
        `app policy-workspace: https=${app?.networkStage}`],
      contradiction: w.landed || net.length === 0 || net.some((n) => connects(n).includes("ok")) || app?.network !== "failed" };
    } },
  { text: "Also lets commands connect out.",
    claim: "connects succeed under --sandbox-network enabled",
    check: (e) => {
      const net = e.mspNetwork("network");
      return { measured: net.map((n) => `msp enabled: tcp 80/443=${n.tcp_80}/${n.tcp_443}, tnc=${n.tnc_443}, http iwr=${n.iwr_http}`),
        contradiction: net.length === 0 ? null : net.some((n) => n.tcp_80 !== "ok" || n.tcp_443 !== "ok") };
    } },
  { text: "In a project, its preferences must allow it too: networkDefault Allow for network, sandbox Full access for Elevated access.",
    claim: "a project conversation gets network only with networkDefault Allow, Elevated access only with sandbox Full access",
    check: (e) => {
      const cases = e.rec.scope?.cases ?? [];
      const b = e.rec["policy-elevated"];
      const got = (c) => `app scope: ${c.isolation}, project ${c.project} -> ${c.requested.sandboxMode}`;
      const expect = { A: "workspace", N: "network" };
      return { measured: [...cases.map(got), `app policy-elevated: Elevated access, project B (sandbox Full access) -> ${b?.startSession?.sandboxMode}`],
        contradiction: cases.length === 0 || !b ? null : cases.some((c) => c.requested.sandboxMode !== expect[c.project]) || b.startSession.sandboxMode !== "elevated" };
    } },
  { text: "Under Workspace only, names still resolve.",
    claim: "DNS answers under --sandbox-network restricted",
    check: (e) => {
      const net = e.mspNetwork("workspace");
      return { measured: net.map((n) => `msp restricted: dns=${n.dns}, tnc dns resolved=${n.tnc_443 !== "dns"}`),
        contradiction: net.length === 0 ? null : net.some((n) => n.dns !== "ok") };
    } },
  { text: "Under Workspace and network, HTTPS fails in Windows' TLS layer (PowerShell, curl.exe); plain HTTP works.",
    claim: "with --sandbox-network enabled, HTTPS stops at TLS for PowerShell and curl.exe while HTTP gets its 200",
    check: (e) => {
      const net = e.mspNetwork("network");
      return { measured: net.map((n) => `msp enabled: https iwr=${n.iwr_https}, curl=${n.curl_https} (${n.curl_https_detail}); http iwr=${n.iwr_http}, curl=${n.curl_http}`),
        contradiction: net.length === 0 ? null : net.some((n) => n.iwr_https !== "tls" || n.curl_https !== "tls" || n.iwr_http !== "ok" || n.curl_http !== "ok") };
    } },
  { text: "Elevated access reaches HTTPS.",
    claim: "an HTTPS call returns 200 with the sandbox off",
    check: (e) => {
      const c = e.rec["policy-elevated"]?.cell;
      return { measured: [`app policy-elevated: https=${c?.networkStage} (${e.rec["policy-elevated"]?.net}), engine ${c?.engine}`],
        contradiction: !c ? null : c.network !== "completed" };
    } },
];

/**
 * (M0-06) Every sentence of the posture and Isolation texts, read from the
 * running app, against its measured cells.
 */
async function sentences(app) {
  await openSettings(app);
  await sleep(1_200);
  const ui = await app.ev(page(`
    const read = (group) => q('[role="radiogroup"][aria-label="' + group + '"] label').map((l) => ({
      label: l.querySelector('strong')?.innerText.trim(), text: l.querySelector('.authorization-mode-copy > span')?.innerText.trim() }));
    const note = (h) => q('.settings-group').find((g) => g.querySelector('h3')?.innerText.trim() === h)?.querySelector('.settings-note')?.innerText.replace(/\\s+/g, ' ').trim() || null;
    return { postures: read('Global authorization mode'), isolation: read('Isolation'), isolationNote: note('Isolation'),
      headings: q('.settings-group h3').map((h) => h.innerText.trim()),
      ruleControls: q('button, h3, label').map((n) => n.innerText.trim()).filter((t) => /allow in workspace|authorization rules/i.test(t)) };
  `));
  // The composer's posture menu: rendered (closed) with the welcome composer.
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  ui.composer = await app.ev(page(`return [...document.querySelectorAll('button[role="menuitemradio"]')].map((b) => ({ label: b.querySelector('strong')?.textContent.trim(), text: b.querySelector('small')?.textContent.trim() }));`));

  const msp = readJson(MSP, null);
  const m05 = readJson(MATRIX, null);
  const tag = (src) => (c) => ({ ...c, src });
  const e = {
    msp, m05, appr: readJson(APPROVALS, null), rec: readJson(OUT, { phases: {} }).phases,
    mspCells: (posture, mode, action) => (msp?.runs ?? []).filter((r) => !posture || r.posture === posture)
      .flatMap((r) => r.modes.filter((m) => !mode || m.mode === mode).flatMap((m) => m.cells.map(tag(`msp ${r.posture}/${m.mode}`))))
      .filter((c) => !action || c.action === action),
    mspModes: (mode) => (msp?.runs ?? []).flatMap((r) => r.modes.filter((m) => m.mode === mode).map((m) => ({ ...m, src: `msp ${r.posture}/${m.mode}` }))),
    mspNetwork: (posture) => (msp?.runs ?? []).filter((r) => r.posture === posture).flatMap((r) => r.modes.flatMap((m) => m.cells)).map((c) => c.network).filter(Boolean),
    m05Cells: (posture, mode) => (m05?.runs.find((r) => r.posture === posture)?.modes.find((m) => m.mode === mode)?.cells ?? []).map(tag(`05/10 matrix ${posture}/${mode}`)),
    m05OffProfile: (mode) => (m05?.workspaceOutsideProfile?.cells ?? []).filter((c) => c.mode === mode).map((c) => ({ ...c.cell, src: `05/10 matrix off-profile/${mode}` })),
    scopeCase: (isolation, key) => readJson(OUT, { phases: {} }).phases.scope?.cases.find((c) => c.isolation === isolation && c.project === key),
  };
  // Shell writes outside the folder: this campaign's junction cells (both levels), the app run, the 05/10 temp-folder cells.
  e.writesOutside = () => {
    const cells = e.mspCells(null, null, "writeThroughJunction");
    const app = e.rec["policy-workspace"]?.cell;
    const temp = [...e.m05Cells("workspace", "promptUnmatched"), ...e.m05Cells("workspace", "onRequest")].filter((c) => c.action === "writeOutsideRoot");
    return {
      measured: [...cells.map((c) => `${c.src} junction cell: landed outside=${Object.entries(c.landedOutsideRoot).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}`),
        `app policy-workspace: write outside=${app?.writeOutside} (${app?.writeError})`, ...temp.map((c) => `${c.src} writeOutsideRoot: ${c.outcome}`)],
      landed: cells.some((c) => Object.values(c.landedOutsideRoot).some(Boolean)) || app?.writeOutside === "completed" || temp.some((c) => c.outcome === "completed"),
    };
  };

  const split = (text) => (text ?? "").split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  const shown = [
    ...ui.postures.flatMap((p) => split(p.text).map((s) => ({ where: `posture ${p.label}`, sentence: s }))),
    ...ui.composer.flatMap((p) => split(p.text).map((s) => ({ where: `composer ${p.label}`, sentence: s }))),
    ...ui.isolation.flatMap((p) => split(p.text).map((s) => ({ where: `isolation ${p.label}`, sentence: s }))),
    ...split(ui.isolationNote).map((s) => ({ where: "isolation note", sentence: s })),
  ];
  const rows = shown.map(({ where, sentence }) => {
    const entry = SENTENCES.find((x) => x.text === sentence);
    if (!entry) return { where, sentence, unmapped: true, contradiction: null };
    const { measured, contradiction, why } = entry.check(e);
    return { where, sentence, claim: entry.claim, measured, contradiction, ...(contradiction ? { why } : {}) };
  });
  return {
    liveTurns: 0, ui, rows,
    contradictions: rows.filter((r) => r.contradiction === true).length,
    unmapped: rows.filter((r) => r.unmapped).length,
    unmeasured: rows.filter((r) => !r.unmapped && r.contradiction === null).length,
    verdict: {
      everySentenceMapped: rows.every((r) => !r.unmapped),
      noContradiction: rows.every((r) => r.contradiction === false),
      noClientRuleInSettings: ui.ruleControls.length === 0 && !ui.headings.some((h) => /rules/i.test(h)),
    },
  };
}

const PHASES = { setup, reject, allow, restart, reload, two, forged, posture, isolation, d1, wire, texts, restore, scope, policy, sentences };
if (!PHASES[PHASE]) {
  process.stderr.write(`usage: cdp-m0-05-06-approvals.mjs <${Object.keys(PHASES).join("|")}> [--base dir] [--replay-stale]\n`);
  process.exit(1);
}
// These phases change Isolation and project preferences: never on a real profile.
if (["scope", "policy", "sentences"].includes(PHASE) && !TEST_DATA) {
  process.stderr.write(`${PHASE} runs on the isolated app only: pass --test-data <its MUSE_DESKTOP_TEST_DATA_DIR>\n`);
  process.exit(1);
}
mkdirSync(BASE, { recursive: true });
const app = await openPage();
// Before driving anything: the WebView2 browser on this port runs on the test profile.
if (TEST_DATA && !under(webviewProfile(), TEST_DATA)) {
  app.close();
  process.stderr.write(`the WebView2 browser on CDP is not on the profile under ${TEST_DATA}: stopped before driving the app\n`);
  process.exit(1);
}
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
