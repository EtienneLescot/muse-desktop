/**
 * Shared page actions of the macOS M0-05 and M0-06 proofs (approval and
 * question cards, postures, Isolation, projects), ported from
 * scripts/cdp-m0-05-06-approvals.mjs and scripts/cdp-m0-05-questions.mjs for
 * an isolated test instance (scripts/macos/test-instance.mjs) on WKWebView,
 * whose IPC transport is ipc://localhost.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { INSTALL_IPC_TRACE, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { processTree } from "./test-instance.mjs";

export const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); let f = k ? el[k] : null;
    for (let i = 0; f && i < 4; i++, f = f.return) if (f.key) return f.key; return null; };
  const approvalCards = () => q('.approvals .approval').filter((g) => !/^Input needed/.test(g.getAttribute('aria-label') || '')).map((g) => ({
    key: fiberKey(g),
    title: g.querySelector('.approval-title-row strong, strong')?.innerText.trim() || null,
    command: g.querySelector('.approval-details pre')?.innerText.slice(0, 300) || null,
    buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()),
    noChoices: /No choices supplied/.test(g.innerText),
  }));
  const inputCards = () => q('.approval').filter((g) => /^Input needed/.test(g.getAttribute('aria-label') || '')).map((g) => ({
    key: fiberKey(g),
    questions: [...g.querySelectorAll('.input-question')].map((x) => x.getAttribute('aria-label')),
    options: [...g.querySelectorAll('.input-question button, .input-question label.check')].map((b) => b.innerText.trim()),
    error: g.querySelector('[role="alert"]')?.innerText.trim() || null,
  }));
  const health = () => { const h = document.querySelector('.stream-health'); return h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160) : null; };
  const alerts = () => q('.error, [role="alert"], .error-banner').map((n) => n.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 4);
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const running = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"] .dot')?.getAttribute('data-running') || null;
  const view = () => ({ activeSid: activeSid(), health: health(), cards: approvalCards(), inputs: inputCards(), alerts: alerts() });
`;
export const page = (body) => `(async () => { ${H} ${body} })()`;

export const ipc = (app, cmd, max = 2000) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})
  .map((c) => ({ atMs: c.atMs, args: c.args, ok: c.ok, result: c.result ? c.result.slice(0, ${max}) : c.result }))`);

export const POSTURE_LABEL = { ask: "Ask for approval", workspace: "Ask only for more access", yolo: "YOLO" };

/** Host pending rows (approvals and questions) for `sid`. */
export async function pending(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${JSON.stringify(sid)} })`);
  const rows = Array.isArray(res?.approvals) ? res.approvals : [];
  const inputs = Array.isArray(res?.userInputs) ? res.userInputs : Array.isArray(res?.inputs) ? res.inputs : [];
  return {
    approvals: rows.map((r) => ({
      approvalId: r.approvalId ?? r.request_id,
      requirement: r.currentRequirementId ?? r.requirementId ?? null,
      toolName: r.toolName ?? r.tool_name ?? null,
      choices: (r.choices ?? r.availableChoices ?? []).map((c) => ({ choiceId: c.choiceId, label: c.label ?? null, decision: c.decision?.kind ?? c.decision })),
    })),
    inputs: inputs.map((r) => ({ id: r.inputId ?? r.request_id ?? r.userInputId ?? null, questions: (r.questions ?? []).map((x) => x.id) })),
    rawKeys: Object.keys(res ?? {}),
  };
}

/** The composer's posture menu (or Settings' radio when the menu is not shown). */
export async function setPosture(app, mode) {
  const label = POSTURE_LABEL[mode];
  return app.ev(page(`
    let item = [...document.querySelectorAll('button[role="menuitemradio"]')].find((b) => (b.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(label)});
    let via = 'composer menu';
    if (!item) {
      document.querySelector('button.account[aria-label="Settings"]')?.click();
      await new Promise((r) => setTimeout(r, 900));
      item = q('[role="radiogroup"][aria-label="Global authorization mode"] label').find((l) => l.querySelector('strong')?.innerText.trim() === ${JSON.stringify(label)})?.querySelector('input');
      via = 'Settings';
    }
    if (!item) return { clicked: false };
    item.click();
    await new Promise((r) => setTimeout(r, 600));
    return { clicked: true, via, stored: localStorage.getItem('muse-desktop.authorization-mode.v1') };
  `));
}

export async function openSettings(app) {
  return app.ev(page(`if (!document.querySelector('.settings-panel')) document.querySelector('button.account[aria-label="Settings"]')?.click(); await new Promise((r) => setTimeout(r, 900)); return Boolean(document.querySelector('.settings-panel'));`));
}

export async function setIsolation(app, label) {
  await openSettings(app);
  return app.ev(page(`
    const l = q('[role="radiogroup"][aria-label="Isolation"] label').find((x) => x.querySelector('strong')?.innerText.trim() === ${JSON.stringify(label)});
    if (!l) return { clicked: false };
    l.querySelector('input').click();
    await new Promise((r) => setTimeout(r, 600));
    return { clicked: true, stored: (store('muse-desktop.settings.v1', 'null') || {}).mode || null,
      status: document.querySelector('.settings-panel .authorization-status strong')?.innerText || null };
  `));
}

/** Projects panel: one project per folder (the folder dialog answered by the trace). */
export async function addProject(app, name, folder) {
  await app.ev(page("const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  return app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(name)});
    (button('Choose project folders') || button('Add project folders')).click();
    await new Promise((r) => setTimeout(r, 900));
    button('+ Add project').click();
    await new Promise((r) => setTimeout(r, 900));
    return (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(name)})?.id || null;
  `));
}

const openProjectRow = (app, name) => app.ev(page(`
  if (!document.querySelector('.projects-panel')) { const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); }
  await new Promise((r) => setTimeout(r, 800));
  const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(name)});
  if (!row) return false;
  row.querySelector('details').open = true;
  await new Promise((r) => setTimeout(r, 400));
  return true;
`));

/** One project preference: { label: "Project network", value: "deny" }; value "" follows Settings. */
export async function setOverride(app, name, override) {
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

/** Every `muse-bin serve` under the app: pid -> argv after the binary. */
export function engines(appPid) {
  return Object.fromEntries(processTree(appPid).filter((p) => /muse-bin serve/.test(p.command)).map((p) => [p.pid, p.command.replace(/^\S*muse-bin /, "")]));
}

/** The project's row > "New conversation here": a conversation, no message, no turn. */
export async function startBare(app, name, appPid) {
  const before = (await ipc(app, "start_session")).length;
  const running = engines(appPid);
  if (!(await openProjectRow(app, name))) throw new Error(`project ${name} row not found`);
  const clicked = await app.ev(page(`
    const row = q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(name)});
    const b = row && button('New conversation here', row);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  `));
  if (!clicked) throw new Error(`no "New conversation here" in project ${name}`);
  const started = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > before && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
  let meta = null;
  try { meta = JSON.parse(started?.result ?? "null"); } catch { /* an error string */ }
  await sleep(500);
  const fresh = Object.entries(engines(appPid)).filter(([pid]) => !(pid in running)).map(([, argv]) => argv);
  return {
    ok: Boolean(started?.ok), sessionId: meta?.session_id ?? null,
    requested: { authorizationMode: started?.args?.authorizationMode ?? null, sandboxMode: started?.args?.sandboxMode ?? null, sandbox: started?.args?.sandbox ?? null },
    hostApprovalMode: meta?.approval_mode ?? null,
    engine: fresh.length > 0 ? fresh.join(" | ") : "reused a running engine",
    ...(started?.ok ? {} : { error: String(meta ?? started?.result ?? "no answer").slice(0, 300) }),
  };
}

/** Welcome screen -> project option -> first message (typed, Enter) -> start_session; returns the new session id. */
export async function startIn(app, projectId, text) {
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  const before = (await ipc(app, "start_session")).length;
  const picked = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    if (!details) return { found: false };
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const target = q('[role="option"].project-option').find((o) => fiberKey(o) === ${JSON.stringify(`${projectId}:0`)});
    if (!target) return { found: false, keys: q('[role="option"].project-option').map(fiberKey) };
    target.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('textarea[aria-label="Your first message"]').focus();
    return { found: true };
  `));
  if (!picked.found) throw new Error(`project ${projectId} not in the picker: ${JSON.stringify(picked)}`);
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const started = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > before && calls.at(-1).result ? calls.at(-1) : null;
  }, 90_000);
  const meta = started?.result ? JSON.parse(started.result) : null;
  if (!meta?.session_id) throw new Error(`start_session failed: ${JSON.stringify(started)?.slice(0, 300)}`);
  return { sid: meta.session_id, startSession: { ok: started.ok, authorizationMode: started.args?.authorizationMode ?? null, sandboxMode: started.args?.sandboxMode ?? null, hostApprovalMode: meta.approval_mode ?? null } };
}

export async function select(app, sid) {
  await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${JSON.stringify(sid)};`)), 15_000, 300);
  await sleep(800);
}

/** Wait until the host lists a pending approval (or question) for `sid` and its card is painted. */
export async function waitCard(app, sid, { kind = "approval", timeoutMs = 150_000 } = {}) {
  const t0 = Date.now();
  const hit = await waitFor(async () => {
    const snap = await pending(app, sid);
    if ((kind === "approval" ? snap.approvals : snap.inputs).length === 0) return null;
    const ui = await app.ev(page("return view();"));
    const painted = kind === "approval" ? ui.cards.length > 0 : ui.inputs.length > 0;
    return ui.activeSid !== sid || painted ? { snap, ui } : null;
  }, timeoutMs, 700);
  return hit ? { ...hit, msToCard: Date.now() - t0 } : null;
}

/** Real mouse events (isTrusted) on a button found by `finder` (page code returning an element). */
export async function mouseOn(app, finder, count = 1) {
  const box = await app.ev(page(`
    const b = (() => { ${finder} })();
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

/** A button of the approval card whose key is `cardKey` (or the first card). */
export const approvalButton = (label, cardKey = null) => `
  const cards = q('.approvals .approval').filter((g) => !/^Input needed/.test(g.getAttribute('aria-label') || ''));
  const card = ${cardKey ? `cards.find((g) => fiberKey(g) === ${JSON.stringify(cardKey)})` : "cards[0]"};
  return card ? [...card.querySelectorAll('.approval-actions button')].find((n) => n.innerText.trim() === ${JSON.stringify(label)}) : null;`;

export const labelOf = (snap, accepted) => {
  const c = snap.approvals[0]?.choices.find((x) => (x.decision === "abort" || /^denied|^reject/i.test(String(x.decision))) !== accepted);
  return c?.label ?? null;
};

/** Decide every remaining stage of `sid`'s first approval with single clicks on the accepting or refusing choice. */
export async function decideAll(app, sid, accepted, maxStages = 5) {
  const stages = [];
  for (let i = 0; i < maxStages; i++) {
    const snap = await pending(app, sid);
    if (snap.approvals.length === 0) break;
    const requirement = JSON.stringify(snap.approvals[0].requirement);
    const ui = await app.ev(page("return view();"));
    const label = labelOf(snap, accepted);
    const click = await mouseOn(app, approvalButton(label));
    stages.push({ requirement, toolName: snap.approvals[0].toolName, choices: snap.approvals[0].choices.map((c) => `${c.choiceId}/${c.decision}`),
      cardButtons: ui.cards[0]?.buttons ?? [], command: ui.cards[0]?.command ?? null, label, ...click });
    if (!click.clicked) break;
    await waitFor(async () => {
      const next = await pending(app, sid);
      return next.approvals.length === 0 || JSON.stringify(next.approvals[0].requirement) !== requirement;
    }, 30_000, 400);
    // Human pace: the card repaints from the next poll after the host moves on.
    await sleep(1_500);
  }
  return stages;
}

/** Sample the status until the turn is idle (no card, not running, no working/resuming health). */
export async function untilIdle(app, sid, timeoutMs = 180_000) {
  const samples = [];
  const t0 = Date.now();
  let last = null;
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${JSON.stringify(sid)}) };`));
    last = s;
    const sample = { atMs: Date.now() - t0, health: (s.health ?? "").replace(/Last update \d+s ago\.\s*/, ""), cards: s.cards.length + s.inputs.length, running: s.running };
    if (samples.length === 0 || samples.at(-1).health !== sample.health || samples.at(-1).cards !== sample.cards) samples.push(sample);
    return s.running === "false" && s.cards.length + s.inputs.length === 0 && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "") ? s : null;
  }, timeoutMs, 700);
  return { idle: Boolean(done), msToEnd: done ? Date.now() - t0 : null, healthSamples: samples.slice(0, 30), alerts: (done ?? last)?.alerts ?? [] };
}

/** Every entry of the persisted transcript, flattened. */
export const fullLog = (app, sid) => app.ev(page(`
  return (store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ') }));
`));

/**
 * Poll interceptor: records the tool_request / input_request events the bridge
 * delivers and appends queued forged events to the next poll_events response,
 * the path every bridge event takes to the renderer.
 */
export const INSTALL_FORGE = `(() => {
  if (window.__forge) { window.__forge.queue = []; window.__forge.applied = []; window.__forge.seen = []; return 'reset'; }
  const forge = window.__forge = { queue: [], applied: [], seen: [] };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/poll_events/.test(url)) return original(input, init);
    const response = await original(input, init);
    if (response.headers.get('Tauri-Response') !== 'ok') return response;
    const body = await response.clone().json();
    for (const e of body.events || []) if (e.kind === 'tool_request' || e.kind === 'input_request') forge.seen.push({ kind: e.kind, session_id: e.session_id, payload: e.payload });
    if (forge.queue.length === 0) return response;
    const forged = forge.queue.splice(0).map((e) => ({ seq: body.head, ...e }));
    forge.applied.push(...forged);
    body.events = [...(body.events || []), ...forged];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
  };
  return 'installed';
})()`;

export async function installTraces(app) {
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(INSTALL_FORGE);
}

export function macPlatform() {
  return `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, debug build with embedded frontend, WKWebView through the test bridge`;
}

/** Path redaction for a run: each [path, label], also under /private (realpath of /var). */
export function runRedactor(pairs) {
  return redactor(pairs.flatMap(([p, l]) => [[p, l], [`/private${p}`, l]]).concat([[homedir(), "~"]]));
}
