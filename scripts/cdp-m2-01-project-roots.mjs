#!/usr/bin/env node

/**
 * M2-01 native acceptance, no model turn: a project keeps several persistent
 * folders. Phases, run in order on the CDP-enabled build (one app instance):
 *
 *   setup   create a 4-root project through the Projects panel, then an
 *           old-format project with no root and migrate it through the
 *           "N project(s) need a folder" notice; Check folders -> Available.
 *   check   "New conversation here" in root A (start_session only, no turn),
 *           then move root C away and replace root D by a file on disk:
 *           Check folders -> Available / Missing / Not a folder.
 *   verify  after an app restart: roots, migration, observations and the
 *           project's conversations are unchanged; the welcome picker still
 *           offers projectId:rootIndex for every root.
 *   cleanup delete the two test projects through the UI; the user's own
 *           projects must be byte-identical to the setup snapshot.
 *
 * The welcome-screen start through projectId:rootIndex with a real turn is
 * cdp-m0-08-engine-run.mjs (run it between setup and check).
 *
 * The OS folder dialog cannot be driven over CDP: the harness answers
 * plugin:dialog|open with the folder a user would pick (see cdp-harness.mjs).
 *
 * Usage:
 *   node scripts/cdp-m2-01-project-roots.mjs <setup|check|verify|cleanup>
 *     [--base G:\muse-proofs\baseline\m2-01] [--name baseline-m2-01]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m2-01-project-roots.json]
 * Each phase merges its result into --out (path-free).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const PHASE = process.argv[2];
const BASE = argValue("--base", "G:\\muse-proofs\\baseline\\m2-01");
const NAME = argValue("--name", "baseline-m2-01");
const LEGACY = `${NAME}-legacy`;
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m2-01-project-roots.json");
const STATE = join(BASE, "harness-state.json");
const ROOTS = { A: join(BASE, "root-a"), B: join(BASE, "root-b"), C: join(BASE, "root-c"), D: join(BASE, "root-d"), E: join(BASE, "legacy-root") };
const redact = redactor([...Object.entries(ROOTS).map(([label, path]) => [path, `<root ${label}>`]), [BASE, "<proof>"]]);
const sha = (text) => createHash("sha256").update(text ?? "").digest("hex").slice(0, 16);

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const projectRow = (name) => q('li.project-item').find((li) => (li.querySelector('.project-name')?.innerText || '').trim() === name) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const openProjects = () => { const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b; };
  const rowState = (name) => {
    const row = projectRow(name);
    if (!row) return null;
    const details = row.querySelector('details');
    if (details && !details.open) details.open = true;
    return {
      summary: (row.querySelector('summary')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      folders: [...row.querySelectorAll('li.workspace-root-row')].map((li) => ({
        path: li.querySelector('.workspace-path')?.getAttribute('title') || '',
        health: li.querySelector('.workspace-health')?.innerText.trim() || null,
        reason: li.querySelector('.workspace-health')?.getAttribute('title') || null,
      })),
    };
  };
`;

const page = (body) => `(async () => { ${H} ${body} })()`;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function merge(phaseResult) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m2-01-project-roots.v1",
    ticket: "M2-01",
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.phases[PHASE] = redact(phaseResult);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[PHASE];
}

async function gotoProjects(app) {
  await app.ev(page("return openProjects();"));
  return waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
}

/** Click Check folders and wait for one fresh inspect_workspace_root answer per root. */
async function checkFolders(app, name) {
  const count = "window.__baselineIpc.calls.filter((c) => c.cmd === 'inspect_workspace_root' && c.result !== undefined).length";
  const before = await app.ev(count);
  const roots = await app.ev(page(`const row = projectRow(${JSON.stringify(name)}); if (!row) return 0; row.querySelector('details').open = true; const b = button('Check folders', row); if (b) b.click(); return b ? row.querySelectorAll('li.workspace-root-row').length : 0;`));
  await waitFor(async () => (await app.ev(count)) >= before + roots, 15_000);
  await sleep(400);
  return app.ev(page(`return rowState(${JSON.stringify(name)});`));
}

async function setup(app) {
  if (existsSync(BASE) && existsSync(STATE)) throw new Error(`${BASE} already holds a run; remove it or pass another --base`);
  for (const path of Object.values(ROOTS)) mkdirSync(path, { recursive: true });
  const result = {};
  const before = await app.ev(page(`return { raw: localStorage.getItem('muse-desktop.projects.v1'), names: (store('muse-desktop.projects.v1', '[]') || []).map((p) => p.name) };`));
  if (before.names.includes(NAME) || before.names.includes(LEGACY)) throw new Error("test projects already exist in the profile");
  writeFileSync(STATE, JSON.stringify({ userProjectsRaw: before.raw }));
  result.userProjects = { count: before.names.length, sha: sha(before.raw) };

  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  // 1. A multi-folder project through the real panel (dialog answered with 4 roots).
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D])}), true)`);
  result.create = await app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(NAME)});
    button('Choose project folders').click();
    await new Promise((r) => setTimeout(r, 800));
    const picked = q('.project-workspace-picker span')[0]?.innerText || null;
    button('+ Add project').click();
    await new Promise((r) => setTimeout(r, 800));
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAME)});
    return { pickerSays: picked, stored: row ? { id: row.id, workspace: row.workspace, workspaces: row.workspaces, workspaceReviewed: row.workspaceReviewed } : null,
      panel: rowState(${JSON.stringify(NAME)}), quota: (q('.projects-panel .session-list-header span')[0]?.innerText || '').trim() };
  `));

  // 2. An old project with no root: written in the pre-root format, then reloaded.
  const traceBeforeReload = await app.ev("window.__baselineIpc.calls");
  const legacyId = `baseline-legacy-${Date.now().toString(36)}`;
  await app.ev(page(`
    const rows = store('muse-desktop.projects.v1', '[]') || [];
    rows.push({ id: ${JSON.stringify(legacyId)}, name: ${JSON.stringify(LEGACY)}, createdAt: Date.now() });
    localStorage.setItem('muse-desktop.projects.v1', JSON.stringify(rows));
    setTimeout(() => location.reload(), 50);
    return true;
  `));
  await sleep(9_000);
  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  result.legacyBefore = await app.ev(page(`
    return { notice: (q('.project-migration strong')[0]?.innerText || null), row: rowState(${JSON.stringify(LEGACY)}) };
  `));
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOTS.E)}), true)`);
  await app.ev(page("button('Choose next folder').click(); return true;"));
  await sleep(1_200);
  result.legacyAfter = await app.ev(page(`
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(LEGACY)});
    return { notice: (q('.project-migration strong')[0]?.innerText || null),
      stored: row ? { workspace: row.workspace, workspaces: row.workspaces, workspaceReviewed: row.workspaceReviewed } : null,
      panel: rowState(${JSON.stringify(LEGACY)}) };
  `));

  // 3. The native probe on the four roots, all present.
  result.checkAllPresent = await checkFolders(app, NAME);
  const trace = [...traceBeforeReload, ...(await app.ev("window.__baselineIpc.calls"))];
  result.ipc = trace.filter((c) => /dialog|inspect_workspace_root/.test(c.cmd))
    .map((c) => ({ cmd: c.cmd, options: c.args?.options ?? null, path: c.args?.path ?? null, answeredByHarness: c.answeredByHarness === true, ok: c.ok, result: c.cmd === "inspect_workspace_root" ? JSON.parse(c.result ?? "null") : undefined }));
  const created = result.create.stored;
  result.verdict = {
    multiRootStored: JSON.stringify(created?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]) && created?.workspace === ROOTS.A && created?.workspaceReviewed === true,
    panelListsFourRoots: result.create.panel?.folders.length === 4,
    legacyNoticeShown: /1 project need/.test(result.legacyBefore.notice ?? "") && /folder needed/.test(result.legacyBefore.row?.summary ?? ""),
    legacyMigrated: result.legacyAfter.stored?.workspace === ROOTS.E && result.legacyAfter.stored?.workspaceReviewed === true && result.legacyAfter.notice === null,
    allAvailable: result.checkAllPresent?.folders.every((f) => f.health === "Available") === true,
  };
  writeFileSync(STATE, JSON.stringify({ userProjectsRaw: before.raw, projectId: created?.id, legacyId }));
  return result;
}

async function check(app) {
  const state = readJson(STATE, null);
  if (!state?.projectId) throw new Error("run setup first");
  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  const result = {};
  // 1. "New conversation here" in root A: start_session only, no turn.
  result.startHere = await app.ev(page(`
    const row = projectRow(${JSON.stringify(NAME)});
    row.querySelector('details').open = true;
    const select = row.querySelector('select[aria-label^="Conversation folder for"]');
    setValue(select, ${JSON.stringify(ROOTS.A)});
    await new Promise((r) => setTimeout(r, 300));
    const go = button('New conversation here', row);
    const disabled = go ? go.disabled : null;
    if (go && !go.disabled) go.click();
    return { selected: select.value, clicked: Boolean(go && !disabled) };
  `));
  const started = await waitFor(async () => {
    const calls = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.result)");
    return calls.length > 0 ? calls[calls.length - 1] : null;
  }, 60_000);
  const meta = started ? JSON.parse(started.result) : null;
  result.startHere.startSession = started ? { workspacePath: started.args?.workspacePath, ok: started.ok, sessionId: meta?.session_id ?? null } : null;
  await sleep(1_500);
  result.startHere.after = await app.ev(page(`
    const sid = ${JSON.stringify(meta?.session_id ?? "")};
    const session = (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid);
    const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
    const log = store('muse-desktop.log.v1.' + sid, '[]') || [];
    return { attachedTo: tp[sid] || null, workspace: session ? session.workspace : null, logEntries: log.length };
  `));
  writeFileSync(STATE, JSON.stringify({ ...state, sessionA: meta?.session_id ?? null }));

  // 2. Move root C away and replace root D by a file, outside the app.
  renameSync(ROOTS.C, `${ROOTS.C}-moved`);
  rmSync(ROOTS.D, { recursive: true, force: true });
  writeFileSync(ROOTS.D, "not a folder\n");
  await gotoProjects(app);
  result.checkAfterMove = await checkFolders(app, NAME);
  result.storedRoots = await app.ev(page(`
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAME)});
    return row ? { workspace: row.workspace, workspaces: row.workspaces } : null;
  `));
  const health = Object.fromEntries((result.checkAfterMove?.folders ?? []).map((f) => [f.path, f.health]));
  result.verdict = {
    startedInChosenRoot: result.startHere.startSession?.workspacePath === ROOTS.A && result.startHere.startSession?.ok === true,
    attachedToProject: result.startHere.after.attachedTo === state.projectId,
    noModelTurn: result.startHere.after.logEntries === 0,
    rootA: health[ROOTS.A], rootB: health[ROOTS.B], rootC: health[ROOTS.C], rootD: health[ROOTS.D],
    observationsDistinct: health[ROOTS.A] === "Available" && health[ROOTS.C] === "Missing" && health[ROOTS.D] === "Not a folder",
    rootsNotRewritten: JSON.stringify(result.storedRoots?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]),
  };
  return result;
}

async function verify(app) {
  const state = readJson(STATE, null);
  if (!state?.projectId) throw new Error("run setup first");
  await app.ev(INSTALL_IPC_TRACE);
  const result = {};
  const previousBoot = readJson(OUT, {}).phases?.check?.boot?.timeOrigin ?? null;
  result.stored = await app.ev(page(`
    const rows = store('muse-desktop.projects.v1', '[]') || [];
    const pick = (name) => { const r = rows.find((p) => p.name === name); return r ? { id: r.id, workspace: r.workspace, workspaces: r.workspaces, workspaceReviewed: r.workspaceReviewed } : null; };
    const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
    const sessions = store('muse-desktop.sessions.v1', '[]') || [];
    const attached = Object.entries(tp).filter(([, pid]) => pid === ${JSON.stringify(state.projectId)}).map(([sid]) => {
      const s = sessions.find((x) => x.session_id === sid);
      return { workspace: s ? s.workspace : null, title: s ? s.title : null };
    });
    return { project: pick(${JSON.stringify(NAME)}), legacy: pick(${JSON.stringify(LEGACY)}), attached };
  `));
  await gotoProjects(app);
  result.panel = await app.ev(page(`return { notice: (q('.project-migration strong')[0]?.innerText || null), project: rowState(${JSON.stringify(NAME)}), legacy: rowState(${JSON.stringify(LEGACY)}) };`));
  result.checkAfterRestart = await checkFolders(app, NAME);
  // Welcome picker: the option keys are the projectId:rootIndex values.
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  result.picker = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    if (!details) return null;
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
    const options = q('[role="option"].project-option').map((o) => ({ optionId: fiberKey(o), label: o.querySelector('strong')?.innerText || '', workspace: o.querySelector('small')?.innerText || '' }))
      .filter((o) => o.optionId && o.optionId.startsWith(${JSON.stringify(state.projectId + ":")}));
    details.open = false;
    return options;
  `));
  // Starting in the moved root C must fail honestly. send_input is blocked by
  // the harness so that no model turn can run even if the start succeeded.
  await app.ev("(window.__baselineIpc.block = ['send_input'], window.__baselineIpc.calls = [], true)");
  result.startInMissingRoot = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
    const target = q('[role="option"].project-option').find((o) => fiberKey(o) === ${JSON.stringify(`${state.projectId}:2`)});
    if (!target) return { picked: false };
    target.click();
    await new Promise((r) => setTimeout(r, 300));
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'missing-root probe');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const sessionsBefore = (store('muse-desktop.sessions.v1', '[]') || []).length;
    document.querySelector('button.welcome-send').click();
    await new Promise((r) => setTimeout(r, 6000));
    const alerts = q('[role="alert"], .error, .banner-error').map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
    return { picked: true, note: document.querySelector('.welcome-project-note')?.innerText || null, alerts,
      sessionsAdded: (store('muse-desktop.sessions.v1', '[]') || []).length - sessionsBefore,
      draftKept: document.querySelector('textarea[aria-label="Your first message"]')?.value === 'missing-root probe' };
  `));
  const calls = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' || c.cmd === 'send_input').map((c) => ({ cmd: c.cmd, ok: c.ok, blockedByHarness: c.blockedByHarness === true, result: (c.result || '').slice(0, 300) }))");
  result.startInMissingRoot.calls = calls;
  await app.ev("(window.__baselineIpc.block = [], true)");
  await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    if (field) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ''); field.dispatchEvent(new Event('input', { bubbles: true })); }
    return true;
  `));
  const health = Object.fromEntries((result.checkAfterRestart?.folders ?? []).map((f) => [f.path, f.health]));
  result.verdict = {
    restartedSinceCheck: previousBoot !== null && (await app.ev("Math.round(performance.timeOrigin)")) > previousBoot,
    rootsPersisted: JSON.stringify(result.stored.project?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]),
    migrationPersisted: result.stored.legacy?.workspace === ROOTS.E && result.stored.legacy?.workspaceReviewed === true && result.panel.notice === null,
    observationsAfterRestart: health[ROOTS.A] === "Available" && health[ROOTS.B] === "Available" && health[ROOTS.C] === "Missing" && health[ROOTS.D] === "Not a folder",
    conversationsStillAttached: result.stored.attached.length,
    pickerOptionIds: (result.picker ?? []).map((o) => o.optionId.replace(state.projectId, "<projectId>")),
    missingRootStartRefused: result.startInMissingRoot.sessionsAdded === 0
      && calls.some((c) => c.cmd === "start_session" && c.ok === false)
      && !calls.some((c) => c.cmd === "send_input" && !c.blockedByHarness),
    // A retry must target the root the user chose, not the default folder.
    choiceKeptAfterFailedStart: /Runs in root-c\b/.test(result.startInMissingRoot.note ?? "") && result.startInMissingRoot.draftKept,
  };
  return result;
}

async function cleanup(app) {
  const state = readJson(STATE, null);
  if (!state) throw new Error("run setup first");
  await gotoProjects(app);
  const result = { deleted: [] };
  for (const name of [NAME, LEGACY]) {
    const clicked = await app.ev(page(`
      const row = projectRow(${JSON.stringify(name)});
      if (!row) return false;
      row.querySelector('details').open = true;
      const del = button('Delete project', row);
      if (del) del.click();
      return !!del;
    `));
    await sleep(800);
    result.deleted.push({ name, clicked });
  }
  const after = await app.ev("localStorage.getItem('muse-desktop.projects.v1')");
  const tp = await app.ev(`(() => { const tp = JSON.parse(localStorage.getItem('muse-desktop.thread-projects.v1') || '{}'); return Object.values(tp).filter((pid) => pid === ${JSON.stringify(state.projectId)} || pid === ${JSON.stringify(state.legacyId)}).length; })()`);
  result.verdict = {
    userProjectsRestored: sha(after) === sha(state.userProjectsRaw),
    danglingAttachments: tp,
  };
  return result;
}

const PHASES = { setup, check, verify, cleanup };
if (!PHASES[PHASE]) {
  process.stderr.write("usage: cdp-m2-01-project-roots.mjs <setup|check|verify|cleanup> [--base dir] [--name project]\n");
  process.exit(1);
}
const app = await openPage();
try {
  const result = await PHASES[PHASE](app);
  result.boot = await app.ev("({ timeOrigin: Math.round(performance.timeOrigin) })");
  result.consoleErrors = app.errors.slice(0, 20);
  const written = merge(result);
  process.stdout.write(`${JSON.stringify(written.verdict ?? written, null, 2)}\n`);
} catch (error) {
  merge({ failure: String(error?.message ?? error).slice(0, 400), consoleErrors: app.errors.slice(0, 20) });
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  app.close();
}
