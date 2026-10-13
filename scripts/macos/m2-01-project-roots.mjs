#!/usr/bin/env node
/**
 * M2-01 native macOS proof: a project keeps several persistent folders.
 * The Windows record is scripts/cdp-m2-01-project-roots.mjs (four phases on
 * one running app); here the same criteria run on isolated instances
 * (scripts/macos/test-instance.mjs), the restart being a real one: the first
 * instance is closed, the second opens the same data folder and store.
 *
 *   run 1  a 4-root project through the Projects panel (folder dialog answered
 *          by the IPC trace) · a root-less project in the old format migrated
 *          through the "N project(s) need a folder" notice · Check folders ->
 *          Available x4 · "New conversation here" in root A (start only) · a
 *          live turn started from the welcome picker in root B
 *          (projectId:1), the engine's cwd read with lsof · root C moved
 *          away, root D replaced by a file -> Available / Missing / Not a folder,
 *          roots never rewritten.
 *   run 2  after the restart: roots, migration, observations and attached
 *          conversations unchanged; the picker still offers projectId:rootIndex
 *          for every root; a start in the missing root fails honestly (send
 *          blocked by the harness), the choice and the draft are kept.
 *
 * macOS observation (no verdict): the probe on the /var and /private/var
 * spellings and on a case-changed spelling of root A (APFS is case-insensitive).
 *
 *   node scripts/macos/m2-01-project-roots.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9451] [--base $TMPDIR/muse-proofs-g5/m2-01]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-01-project-roots.json]
 *
 * One live turn.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { transcript } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9451"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-01")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-01-project-roots.json");
mkdirSync(BASE_ARG, { recursive: true });
// The folder a macOS open panel hands back is the resolved one (/private/var/...).
const BASE = realpathSync(BASE_ARG);
const NAME = "macos-m2-01";
const LEGACY = `${NAME}-legacy`;
const ROOTS = { A: join(BASE, "root-a"), B: join(BASE, "root-b"), C: join(BASE, "root-c"), D: join(BASE, "root-d"), E: join(BASE, "legacy-root") };
const DATA = join(BASE, "data");
const TOKEN = `ROOT-B-${ID.toUpperCase()}`;
const redact = redactor([
  ...Object.entries(ROOTS).map(([label, path]) => [path, `<root ${label}>`]),
  [BASE, "<proof>"], [BASE_ARG, "<proof>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"],
]);

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
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
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

async function gotoProjects(app) {
  await app.ev(page("return openProjects();"));
  return waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
}

async function checkFolders(app, name) {
  const count = "window.__baselineIpc.calls.filter((c) => c.cmd === 'inspect_workspace_root' && c.result !== undefined).length";
  const before = await app.ev(count);
  const roots = await app.ev(page(`const row = projectRow(${JSON.stringify(name)}); if (!row) return 0; row.querySelector('details').open = true; const b = button('Check folders', row); if (b) b.click(); return b ? row.querySelectorAll('li.workspace-root-row').length : 0;`));
  await waitFor(async () => (await app.ev(count)) >= before + roots, 15_000);
  await sleep(400);
  return app.ev(page(`return rowState(${JSON.stringify(name)});`));
}

/** The working directory of every engine process under the app (lsof). */
function engineCwds(pid) {
  return processTree(pid).filter((p) => /muse-bin/.test(p.command)).map((p) => {
    let cwd = null;
    try { cwd = execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null; } catch { /* gone */ }
    return { argv: p.command.replace(/^.*\//, "").slice(0, 160), cwd };
  });
}

async function run1(inst) {
  const { app } = inst;
  const r = {};
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  // 1. A multi-folder project through the real panel.
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D])}), true)`);
  r.create = await app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(NAME)});
    button('Choose project folders').click();
    await new Promise((r) => setTimeout(r, 800));
    const picked = q('.project-workspace-picker span')[0]?.innerText || null;
    button('+ Add project').click();
    await new Promise((r) => setTimeout(r, 800));
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAME)});
    return { pickerSays: picked, stored: row ? { id: row.id, workspace: row.workspace, workspaces: row.workspaces, workspaceReviewed: row.workspaceReviewed } : null,
      panel: rowState(${JSON.stringify(NAME)}) };
  `));
  const projectId = r.create.stored?.id;
  // 2. An old project with no root, then a reload.
  const legacyId = `macos-legacy-${ID}`;
  await app.ev(page(`
    const rows = store('muse-desktop.projects.v1', '[]') || [];
    rows.push({ id: ${JSON.stringify(legacyId)}, name: ${JSON.stringify(LEGACY)}, createdAt: Date.now() });
    localStorage.setItem('muse-desktop.projects.v1', JSON.stringify(rows));
    return true;
  `));
  await inst.app.send("Page.reload", {});
  await sleep(1_000);
  await waitFor(() => app.ev(`document.readyState === 'complete' && document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`).catch(() => false), 30_000);
  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  await sleep(500);
  r.legacyBefore = await app.ev(page(`return { notice: (q('.project-migration strong')[0]?.innerText || null), row: rowState(${JSON.stringify(LEGACY)}) };`));
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOTS.E)}), true)`);
  await app.ev(page("button('Choose next folder').click(); return true;"));
  await sleep(1_200);
  r.legacyAfter = await app.ev(page(`
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(LEGACY)});
    return { notice: (q('.project-migration strong')[0]?.innerText || null),
      stored: row ? { workspace: row.workspace, workspaces: row.workspaces, workspaceReviewed: row.workspaceReviewed } : null,
      panel: rowState(${JSON.stringify(LEGACY)}) };
  `));
  // 3. The native probe on the four roots.
  r.checkAllPresent = await checkFolders(app, NAME);
  r.inspectCalls = (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'inspect_workspace_root')"))
    .map((c) => ({ path: c.args?.path ?? null, ok: c.ok, result: JSON.parse(c.result ?? "null") }));

  // 4. "New conversation here" in root A: start_session only, no turn.
  r.startHere = await app.ev(page(`
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
  const startedA = await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.result)")).at(-1), 60_000);
  const sidA = startedA?.ok ? JSON.parse(startedA.result).session_id : null;
  r.startHere.startSession = startedA ? { workspacePath: startedA.args?.workspacePath, ok: startedA.ok, sessionId: sidA } : null;
  await sleep(1_500);
  r.startHere.after = await app.ev(page(`
    const sid = ${JSON.stringify(sidA ?? "")};
    const session = (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid);
    const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
    return { attachedTo: tp[sid] || null, workspace: session ? session.workspace : null, logEntries: (store('muse-desktop.log.v1.' + sid, '[]') || []).length };
  `));

  // 5. A live turn from the welcome picker in root B (projectId:1).
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  r.welcomeB = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    if (!details) return { picked: false, why: 'no picker' };
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const options = q('[role="option"].project-option').map((o) => ({ el: o, id: fiberKey(o) }));
    const target = options.find((o) => o.id === ${JSON.stringify(`${projectId}:1`)});
    if (!target) return { picked: false, ids: options.map((o) => o.id) };
    target.el.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('textarea[aria-label="Your first message"]').focus();
    return { picked: true, note: document.querySelector('.welcome-project-note')?.innerText || null };
  `));
  const text = `Reply with exactly ${TOKEN} and nothing else.`;
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const startedB = await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.result)")).at(-1), 60_000);
  const sidB = startedB?.ok ? JSON.parse(startedB.result).session_id : null;
  r.welcomeB.startSession = startedB ? { workspacePath: startedB.args?.workspacePath, projectId: startedB.args?.projectId ?? null, ok: startedB.ok, sessionId: sidB } : null;
  r.welcomeB.replyStored = Boolean(sidB && await waitFor(async () => (await transcript(app, sidB)).some((e) => e.role === "assistant" && String(e.text).includes(TOKEN)), 180_000, 1_000));
  r.welcomeB.after = await app.ev(page(`
    const sid = ${JSON.stringify(sidB ?? "")};
    const session = (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid);
    const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
    return { attachedTo: tp[sid] || null, workspace: session ? session.workspace : null };
  `));
  r.engineProcesses = engineCwds(inst.pid);

  // 6. Root C moved away, root D replaced by a file, outside the app.
  renameSync(ROOTS.C, `${ROOTS.C}-moved`);
  rmSync(ROOTS.D, { recursive: true, force: true });
  writeFileSync(ROOTS.D, "not a folder\n");
  await app.ev(INSTALL_IPC_TRACE);
  await gotoProjects(app);
  r.checkAfterMove = await checkFolders(app, NAME);
  r.storedRoots = await app.ev(page(`
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(NAME)});
    return row ? { workspace: row.workspace, workspaces: row.workspaces } : null;
  `));

  // macOS observation: the same folder under other spellings.
  const varSpelling = ROOTS.A.replace(/^\/private\/var\//, "/var/");
  r.macosSpellings = await app.ev(`(async () => {
    const inv = (path) => window.__TAURI_INTERNALS__.invoke('inspect_workspace_root', { path }).then((v) => v, (e) => ({ error: String(e) }));
    return { varSpelling: await inv(${JSON.stringify(varSpelling)}), caseChanged: await inv(${JSON.stringify(ROOTS.A.replace(/root-a$/, "ROOT-A"))}) };
  })()`);
  // The redaction is case-insensitive: keep the exact comparisons as booleans.
  r.macosSpellings.varSpellingGiven = varSpelling.startsWith("/var/");
  r.macosSpellings.varSpellingCanonicalIsRootA = r.macosSpellings.varSpelling?.canonical_path === ROOTS.A;
  r.macosSpellings.caseChangedAvailable = r.macosSpellings.caseChanged?.is_directory === true;
  r.macosSpellings.caseChangedCanonicalExactlyRootA = r.macosSpellings.caseChanged?.canonical_path === ROOTS.A;
  r.macosSpellings.caseChangedPathKeptAsGiven = r.macosSpellings.caseChanged?.path === ROOTS.A.replace(/root-a$/, "ROOT-A");

  const created = r.create.stored;
  const health = Object.fromEntries((r.checkAfterMove?.folders ?? []).map((f) => [f.path, f.health]));
  const cwdB = r.engineProcesses.map((p) => p.cwd).filter(Boolean);
  r.verdict = {
    multiRootStored: JSON.stringify(created?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]) && created?.workspace === ROOTS.A && created?.workspaceReviewed === true,
    panelListsFourRoots: r.create.panel?.folders.length === 4,
    legacyNoticeShown: /1 project need/.test(r.legacyBefore.notice ?? "") && /folder needed/.test(r.legacyBefore.row?.summary ?? ""),
    legacyMigrated: r.legacyAfter.stored?.workspace === ROOTS.E && r.legacyAfter.stored?.workspaceReviewed === true && r.legacyAfter.notice === null,
    allAvailable: r.checkAllPresent?.folders.length === 4 && r.checkAllPresent.folders.every((f) => f.health === "Available"),
    startHereInRootA: r.startHere.startSession?.workspacePath === ROOTS.A && r.startHere.startSession?.ok === true && r.startHere.after.attachedTo === projectId && r.startHere.after.logEntries === 0,
    welcomeStartInRootB: r.welcomeB.startSession?.workspacePath === ROOTS.B && r.welcomeB.startSession?.ok === true && r.welcomeB.after.attachedTo === projectId,
    liveTurnAnsweredInRootB: r.welcomeB.replyStored,
    engineRunsInRootB: cwdB.includes(ROOTS.B),
    observationsDistinct: health[ROOTS.A] === "Available" && health[ROOTS.B] === "Available" && health[ROOTS.C] === "Missing" && health[ROOTS.D] === "Not a folder",
    rootsNotRewritten: JSON.stringify(r.storedRoots?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]),
  };
  return { r, projectId, legacyId, sidA, sidB };
}

async function run2(inst, { projectId, sidA, sidB }) {
  const { app } = inst;
  const r = {};
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  r.stored = await app.ev(page(`
    const rows = store('muse-desktop.projects.v1', '[]') || [];
    const pick = (name) => { const r = rows.find((p) => p.name === name); return r ? { id: r.id, workspace: r.workspace, workspaces: r.workspaces, workspaceReviewed: r.workspaceReviewed } : null; };
    const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
    const sessions = store('muse-desktop.sessions.v1', '[]') || [];
    const attached = Object.entries(tp).filter(([, pid]) => pid === ${JSON.stringify(projectId)}).map(([sid]) => {
      const s = sessions.find((x) => x.session_id === sid);
      return { sid, workspace: s ? s.workspace : null };
    });
    return { project: pick(${JSON.stringify(NAME)}), legacy: pick(${JSON.stringify(LEGACY)}), attached };
  `));
  await gotoProjects(app);
  await sleep(500);
  r.panel = await app.ev(page(`return { notice: (q('.project-migration strong')[0]?.innerText || null), project: rowState(${JSON.stringify(NAME)}), legacy: rowState(${JSON.stringify(LEGACY)}) };`));
  r.checkAfterRestart = await checkFolders(app, NAME);
  await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
  await sleep(1_200);
  r.picker = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    if (!details) return null;
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const options = q('[role="option"].project-option').map((o) => ({ optionId: fiberKey(o), label: o.querySelector('strong')?.innerText || '', workspace: o.querySelector('small')?.innerText || '' }))
      .filter((o) => o.optionId && o.optionId.startsWith(${JSON.stringify(projectId + ":")}));
    details.open = false;
    return options;
  `));
  // A start in the moved root C must fail honestly; send_input is blocked.
  await app.ev("(window.__baselineIpc.block = ['send_input'], window.__baselineIpc.calls = [], true)");
  r.startInMissingRoot = await app.ev(page(`
    const details = document.querySelector('details.project-picker-control');
    details.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const target = q('[role="option"].project-option').find((o) => fiberKey(o) === ${JSON.stringify(`${projectId}:2`)});
    if (!target) return { picked: false };
    target.click();
    await new Promise((r) => setTimeout(r, 300));
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    setValue(field, 'missing-root probe');
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
  r.startInMissingRoot.calls = calls;
  await app.ev("(window.__baselineIpc.block = [], true)");
  const health = Object.fromEntries((r.checkAfterRestart?.folders ?? []).map((f) => [f.path, f.health]));
  const attachedSids = r.stored.attached.map((a) => a.sid);
  r.verdict = {
    rootsPersisted: JSON.stringify(r.stored.project?.workspaces) === JSON.stringify([ROOTS.A, ROOTS.B, ROOTS.C, ROOTS.D]),
    migrationPersisted: r.stored.legacy?.workspace === ROOTS.E && r.stored.legacy?.workspaceReviewed === true && r.panel.notice === null,
    observationsAfterRestart: health[ROOTS.A] === "Available" && health[ROOTS.B] === "Available" && health[ROOTS.C] === "Missing" && health[ROOTS.D] === "Not a folder",
    conversationsStillAttached: attachedSids.includes(sidA) && attachedSids.includes(sidB),
    pickerOptionIds: (r.picker ?? []).map((o) => o.optionId.replace(projectId, "<projectId>")),
    pickerOffersEveryRoot: [0, 1, 2, 3].every((i) => (r.picker ?? []).some((o) => o.optionId === `${projectId}:${i}`)),
    missingRootStartRefused: r.startInMissingRoot.sessionsAdded === 0
      && calls.some((c) => c.cmd === "start_session" && c.ok === false)
      && !calls.some((c) => c.cmd === "send_input" && !c.blockedByHarness),
    choiceKeptAfterFailedStart: /Runs in root-c\b/.test(r.startInMissingRoot.note ?? "") && r.startInMissingRoot.draftKept,
  };
  return r;
}

const record = {
  schema: "muse-desktop.m2-01-project-roots.macos.v1",
  ticket: "M2-01",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon; debug build 08b291d with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  liveTurns: 1,
  harness: `scripts/macos/m2-01-project-roots.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  method: "Two isolated instances on the same data folder and WKWebView store (a real restart: the first window closed, the process gone). The OS folder dialog is answered by the IPC trace (plugin:dialog|open) with the folder a user would pick; the root-less project is written in the pre-root format to localStorage, then the page reloads. Roots live under the resolved temp folder (/private/var/...), the spelling a macOS open panel returns.",
};
let inst = null;
try {
  for (const path of Object.values(ROOTS)) mkdirSync(path, { recursive: true });
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const first = await run1(inst);
  record.run1 = first.r;
  record.consoleErrorsRun1 = inst.app.errors.slice(0, 20);
  record.stopRun1 = await inst.stop({ keepStore: true });
  inst = null;
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  record.run2 = await run2(inst, first);
  record.consoleErrorsRun2 = inst.app.errors.slice(0, 20);
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 800);
  if (error?.appOutput) record.appOutput = error.appOutput;
} finally {
  if (inst) record.stopRun2 = await inst.stop();
}
const v1 = record.run1?.verdict ?? {};
const v2 = record.run2?.verdict ?? {};
const { pickerOptionIds, ...v2Bool } = v2;
record.verdicts = { ...v1, ...Object.fromEntries(Object.entries(v2Bool).map(([k, v]) => [`afterRestart.${k}`, v])) };
record.checks = { pickerOptionIds };
record.passed = !record.failure && Object.values(record.verdicts).length > 15 && Object.values(record.verdicts).every((v) => v === true)
  && record.stopRun1?.leftAfterQuit?.length === 0 && record.stopRun2?.leftAfterQuit?.length === 0
  && record.stopRun2?.defaultStoresUnchangedAtEnd === true;
record.limits = [
  "The folder dialog is answered by the harness: the native NSOpenPanel is not driven (no Accessibility grant); the paths given are those it would return.",
  "Engine session store and Keychain are shared with the user, as on Windows (ADR 0003 amendment).",
];
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, verdicts: out.verdicts, failure: out.failure, macosSpellings: out.run1?.macosSpellings }, null, 2));
process.exit(out.passed ? 0 : 1);
