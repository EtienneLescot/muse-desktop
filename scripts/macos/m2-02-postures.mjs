#!/usr/bin/env node
/**
 * M2-02 native macOS proof: project settings really apply, read on the live
 * engine processes (argv with ps, folder with lsof). The Windows record is
 * scripts/cdp-m2-02-postures.mjs (26/09, before the 06/10 rule "a project
 * follows Settings unless its own preferences restrict it"); this one follows
 * the current rule. No model turn: every conversation is started with
 * "New conversation here" (start_session only).
 *
 *   1. Settings: global Isolation = Elevated access.
 *   2. Three projects, three folders: P1 restricted to "No Elevated access",
 *      P2 following Settings, P3 "Read only, no commands". The panel's diff
 *      says what each project changes. One conversation each -> three engines
 *      at once: P1 `--sandbox-network enabled`, P2 `--disable-sandbox
 *      --sandbox-network enabled`, P3 `--sandbox-network restricted
 *      --disable-write --disable-shell`; P3's conversation says it is read only.
 *   3. Removing an override on a live engine: P1 back to Follow Settings, a new
 *      conversation in P1 is refused ("This folder's engine is running with
 *      Workspace and network; restart it to apply Elevated access.") with the
 *      banner's Restart workspace host; confirmed -> P1's engine respawns
 *      elevated, P2 and P3 untouched (same pids).
 *   4. Durable reconnection: P1's engine killed (SIGKILL); reopening P1's
 *      conversation respawns an engine with P1's posture and resumes the same
 *      session.
 *   5. Settings' own Restart workspace host: global lowered to Workspace only,
 *      P2's conversation active -> its engine respawns `--sandbox-network
 *      restricted`, P3 untouched.
 *   6. macOS: P4 Read only, its folder given in the /var spelling (a symlink
 *      to /private/var): the engine starts read only, and after Settings'
 *      restart on P4's conversation it is still read only.
 *
 *   node scripts/macos/m2-02-postures.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9452] [--base $TMPDIR/muse-proofs-g5/m2-02]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-02-postures.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";

const BUILD = argValue("--build-commit", "08b291d");
const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9452"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-02")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-02-postures.json");
mkdirSync(BASE_ARG, { recursive: true });
const BASE = realpathSync(BASE_ARG);
const R = { P1: join(BASE, "p1"), P2: join(BASE, "p2"), P3: join(BASE, "p3"), P4: join(BASE, "p4") };
// P4 is handed to the app through the /var symlink, not its resolved path.
const P4_SPELLED = R.P4.replace(/^\/private\/var\//, "/var/");
const NAMES = { P1: `m202-p1-${ID}`, P2: `m202-p2-${ID}`, P3: `m202-p3-${ID}`, P4: `m202-p4-${ID}` };
const redact = redactor([
  ...Object.entries(R).map(([k, p]) => [p, `<${k}>`]), [P4_SPELLED, "<P4 via /var>"],
  [BASE, "<proof>"], [BASE_ARG, "<proof>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"],
]);

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const projectRow = (name) => q('li.project-item').find((li) => (li.querySelector('.project-name')?.innerText || '').trim() === name) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const openProjects = () => { const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b; };
  const openRow = (name) => { const row = projectRow(name); if (row) row.querySelector('details').open = true; return row; };
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/** Every engine under the app: pid, flags and folder. */
function engines(pid) {
  return processTree(pid).filter((p) => /muse-bin/.test(p.command)).map((p) => {
    let cwd = null;
    try { cwd = execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null; } catch { /* gone */ }
    return { pid: p.pid, flags: p.command.replace(/^.*muse-bin\s*/, ""), cwd };
  });
}
const engineIn = (list, root) => list.filter((e) => e.cwd === root);
const flagsOf = (list, root) => engineIn(list, root).map((e) => e.flags);

async function gotoProjects(app) {
  await app.ev(page("return openProjects();"));
  return waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
}

/** Settings is a page, not a dialog: the next navigation (Projects, a conversation) leaves it. */
async function closeSettings() { return "left by the next navigation"; }

async function openSettings(app) {
  await app.ev(page("document.querySelector('button[aria-label=\"Settings\"]').click(); return true;"));
  return waitFor(() => app.ev(page("return Boolean(document.querySelector('section.settings-panel'));")), 10_000);
}

async function setGlobalIsolation(app, mode) {
  await openSettings(app);
  const out = await app.ev(page(`
    const radio = document.querySelector('input[name="sandbox-mode"][value="${mode}"]');
    radio.click();
    await wait(400);
    return { selected: document.querySelector('input[name="sandbox-mode"]:checked')?.value ?? null,
      current: [...document.querySelectorAll('.authorization-status')].map((n) => n.innerText.trim()) };
  `));
  out.closed = await closeSettings(app);
  return out;
}

/** Settings: default folder picked (dialog answered), optional global level, then Restart workspace host. */
async function settingsRestart(app, folder, level) {
  await openSettings(app);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), window.__baselineIpc.messageQueue.push("Ok"), true)`);
  const out = await app.ev(page(`
    document.querySelector(".settings-panel .workspace-button").click();
    await wait(800);
    ${level ? `document.querySelector(\`input[name="sandbox-mode"][value="${level}"]\`).click(); await wait(400);` : ""}
    const b = button("Restart workspace host");
    if (b) b.click();
    await wait(4000);
    return { clicked: Boolean(b), defaultFolder: document.querySelector(".settings-panel .workspace-button")?.innerText.trim() ?? null,
      status: [...document.querySelectorAll(".settings-host-restart [role=status]")].map((n) => n.innerText.trim()),
      current: [...document.querySelectorAll(".authorization-status")].map((n) => n.innerText.trim()) };
  `));
  out.closed = await closeSettings(app);
  return out;
}

async function createProject(app, name, folder) {
  await gotoProjects(app);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([folder])}), true)`);
  return app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(name)});
    button('Choose project folders').click();
    await wait(800);
    button('+ Add project').click();
    await wait(800);
    const row = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(name)});
    return row ? { id: row.id, workspace: row.workspace } : null;
  `));
}

async function setIsolation(app, name, value) {
  await gotoProjects(app);
  return app.ev(page(`
    const row = openRow(${JSON.stringify(name)});
    const select = row.querySelector('select[aria-label="Project isolation"]');
    setValue(select, ${JSON.stringify(value)});
    await wait(500);
    const fresh = openRow(${JSON.stringify(name)});
    const stored = (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(name)});
    return { select: fresh.querySelector('select[aria-label="Project isolation"]').value,
      selectText: fresh.querySelector('select[aria-label="Project isolation"]').selectedOptions[0]?.innerText ?? null,
      diff: [...fresh.querySelectorAll('ul.project-diff li')].map((li) => li.innerText.trim()),
      inherits: [...fresh.querySelectorAll('p.muted')].some((p) => /inherits the global preferences/.test(p.innerText)),
      storedSettings: stored?.settings ?? null };
  `));
}

/** "New conversation here" in the project's first folder; the start_session call it made. */
async function startHere(app, name) {
  await gotoProjects(app);
  const before = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session').length");
  await app.ev(page(`const row = openRow(${JSON.stringify(name)}); const go = button('New conversation here', row); if (go && !go.disabled) go.click(); return Boolean(go && !go.disabled);`));
  const call = await waitFor(async () => {
    const calls = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session')");
    const last = calls.length > before ? calls.at(-1) : null;
    return last && last.ok !== undefined ? last : null;
  }, 60_000);
  await sleep(1_500);
  const sid = call?.ok ? JSON.parse(call.result).session_id : null;
  return {
    ok: call?.ok ?? null, sid,
    request: call ? { workspacePath: call.args?.workspacePath, sandboxMode: call.args?.sandboxMode, sandboxDisableWrite: call.args?.sandboxDisableWrite, sandboxDisableShell: call.args?.sandboxDisableShell } : null,
    error: call && !call.ok ? String(call.result).slice(0, 300) : null,
    banner: await app.ev(page("return q('.error-banner').map((n) => n.innerText.replace(/\\s+/g, ' ').trim());")),
    notes: await app.ev(page("return q('.composer-posture-note, .posture-note, [class*=posture]').map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 4);")),
  };
}

async function selectConversation(app, sid) {
  const title = await app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').find((s) => s.session_id === ${JSON.stringify(sid)}) || {}).title || null`);
  return app.ev(page(`
    const rows = q('button.session-select');
    const row = rows.find((b) => (b.getAttribute('title') || '') === ${JSON.stringify(title)}) || rows.find((b) => b.closest('[data-session-id="${sid}"]'));
    if (row) row.click();
    return Boolean(row);
  `));
}

const ipcSince = async (app, from) => (await app.ev("window.__baselineIpc.calls")).slice(from)
  .filter((c) => !/^plugin:event|^plugin:window|read_|list_|git_|probe|inspect|rules_scan|diagnos/.test(c.cmd))
  .map((c) => ({ cmd: c.cmd, ok: c.ok, args: c.cmd === "restart_host" || c.cmd === "start_session" ? { workspacePath: c.args?.workspacePath, sandboxMode: c.args?.sandboxMode, sandboxDisableWrite: c.args?.sandboxDisableWrite } : undefined, result: c.ok === false ? String(c.result).slice(0, 200) : undefined }));

const record = {
  schema: "muse-desktop.m2-02-postures.macos.v1",
  ticket: "M2-02",
  date: new Date().toISOString().slice(0, 10),
  commit: BUILD,
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon; debug build ${BUILD} with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m2-02-postures.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  method: "One isolated instance. Postures are read on the live engine processes: flags from ps, folder from lsof (cwd). Conversations are started with the Projects panel's New conversation here (start_session, no turn). The OS folder dialog and the restart confirmation are answered by the IPC trace (plugin:dialog|open, plugin:dialog|message) as the user's choice would be.",
  steps: {},
};
const step = (name, data) => { record.steps[name] = data; };
let inst = null;
try {
  for (const p of Object.values(R)) mkdirSync(p, { recursive: true });
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const { app } = inst;
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);

  // 1-2. Global elevated; three projects with three postures.
  step("globalElevated", await setGlobalIsolation(app, "elevated"));
  const ids = {};
  for (const k of ["P1", "P2", "P3"]) ids[k] = (await createProject(app, NAMES[k], R[k]))?.id ?? null;
  ids.P4 = (await createProject(app, NAMES.P4, P4_SPELLED))?.id ?? null;
  step("projects", { ids, p4StoredWorkspace: await app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.projects.v1') || '[]').find((p) => p.id === ${JSON.stringify(ids.P4)}) || {}).workspace || null`) });
  step("overrides", {
    P1: await setIsolation(app, NAMES.P1, "workspace"),
    P2: await setIsolation(app, NAMES.P2, ""),
    P3: await setIsolation(app, NAMES.P3, "read-only"),
    P4: await setIsolation(app, NAMES.P4, "read-only"),
  });
  const conv = {};
  for (const k of ["P1", "P2", "P3"]) conv[k] = await startHere(app, NAMES[k]);
  const three = engines(inst.pid);
  step("threeProjects", { conversations: conv, engines: three });

  // 3. Removing P1's override while its engine runs.
  step("p1FollowSettings", await setIsolation(app, NAMES.P1, ""));
  const p1PidBefore = engineIn(three, R.P1).map((e) => e.pid);
  const otherPidsBefore = [...engineIn(three, R.P2), ...engineIn(three, R.P3)].map((e) => e.pid).sort();
  const mark = (await app.ev("window.__baselineIpc.calls.length"));
  const refused = await startHere(app, NAMES.P1);
  await app.ev("(window.__baselineIpc.messageQueue.push('Ok'), true)");
  const restartClicked = await app.ev(page("const b = q('.error-banner button').find((x) => /Restart workspace host/.test(x.innerText)); if (b) b.click(); return Boolean(b);"));
  await waitFor(async () => flagsOf(engines(inst.pid), R.P1).some((f) => /--disable-sandbox/.test(f)), 30_000, 500);
  await sleep(1_000);
  const afterRestart = engines(inst.pid);
  step("p1RefusalAndRestart", { refused, restartClicked, ipc: await ipcSince(app, mark), engines: afterRestart });

  // 4. Durable reconnection after a kill.
  const p1Engine = engineIn(afterRestart, R.P1)[0];
  if (p1Engine) process.kill(p1Engine.pid, "SIGKILL");
  await sleep(3_000);
  const mark4 = await app.ev("window.__baselineIpc.calls.length");
  await selectConversation(app, conv.P2.sid);
  await sleep(1_500);
  const reopened = await selectConversation(app, conv.P1.sid);
  await waitFor(async () => engineIn(engines(inst.pid), R.P1).some((e) => e.pid !== p1Engine?.pid), 30_000, 500);
  await sleep(3_000);
  const afterKill = engines(inst.pid);
  const ipc4 = await ipcSince(app, mark4);
  const resumeCalls = (await app.ev("window.__baselineIpc.calls")).slice(mark4).filter((c) => /resume|reconnect|attach|start_session/.test(c.cmd))
    .map((c) => ({ cmd: c.cmd, ok: c.ok, sessionId: c.args?.sessionId ?? null, result: String(c.result ?? "").slice(0, 200) }));
  step("p1KillAndResume", { killedPid: p1Engine?.pid ?? null, reopened, engines: afterKill, ipc: ipc4, resumeCalls,
    activeHeader: await app.ev(page("return (document.querySelector('.session-header, header.conversation-header, .thread-header')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200);")),
    banner: await app.ev(page("return q('.error-banner').map((n) => n.innerText.replace(/\\s+/g, ' ').trim());")) });

  // 5. Settings' Restart workspace host acts on Settings' default folder:
  // P2's folder picked there, global lowered to Workspace only.
  const p3PidsBefore5 = engineIn(afterKill, R.P3).map((e) => e.pid);
  const settings5 = await settingsRestart(app, R.P2, "workspace");
  await waitFor(async () => flagsOf(engines(inst.pid), R.P2).some((f) => /--sandbox-network restricted/.test(f)), 30_000, 500);
  const after5 = engines(inst.pid);
  step("settingsRestartP2", { settings: settings5, engines: after5 });

  // 6. macOS: P4 Read only, its folder given through the /var symlink.
  await setGlobalIsolation(app, "elevated");
  conv.P4 = await startHere(app, NAMES.P4);
  const p4Start = engines(inst.pid);
  // 6a. Settings' restart with the default folder spelled as the project spells it.
  const settings6a = await settingsRestart(app, P4_SPELLED, null);
  await sleep(2_000);
  const p4AfterA = engines(inst.pid);
  // 6b. The same folder, resolved (/private/var), as the conversation stores it.
  const settings6b = await settingsRestart(app, R.P4, null);
  await sleep(2_000);
  const p4AfterB = engines(inst.pid);
  step("p4VarSpelling", { start: conv.P4, enginesAtStart: p4Start,
    sameSpelling: { settings: settings6a, engines: engineIn(p4AfterA, R.P4) },
    resolvedSpelling: { settings: settings6b, engines: engineIn(p4AfterB, R.P4) },
    conversationWorkspace: await app.ev(`(JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]").find((s) => s.session_id === ${JSON.stringify(conv.P4.sid)}) || {}).workspace || null`) });

  const has = (list, root, re, not) => flagsOf(list, root).some((f) => re.test(f) && !(not && not.test(f)));
  record.verdicts = {
    diffShowsRestrictions: /No Elevated access/.test(record.steps.overrides.P1.diff.join(" ")) && /Read only, no commands/.test(record.steps.overrides.P3.diff.join(" ")) && record.steps.overrides.P2.inherits,
    threeConversationsStarted: ["P1", "P2", "P3"].every((k) => conv[k].ok === true),
    p1NoElevated: has(three, R.P1, /--sandbox-network enabled/, /--disable-sandbox/),
    p2FollowsElevated: has(three, R.P2, /--disable-sandbox --sandbox-network enabled/),
    p3ReadOnly: has(three, R.P3, /--sandbox-network restricted.*--disable-write --disable-shell/, /--disable-sandbox/),
    threePosturesAtOnce: engineIn(three, R.P1).length === 1 && engineIn(three, R.P2).length === 1 && engineIn(three, R.P3).length === 1,
    overrideRemovedRefusedOnLiveEngine: refused.ok === false && /engine is running with Workspace and network; restart it to apply Elevated access/.test(`${refused.error} ${refused.banner.join(" ")}`),
    restartOfferedAndApplied: restartClicked && has(afterRestart, R.P1, /--disable-sandbox --sandbox-network enabled/) && !engineIn(afterRestart, R.P1).some((e) => p1PidBefore.includes(e.pid)),
    otherEnginesUntouched: JSON.stringify([...engineIn(afterRestart, R.P2), ...engineIn(afterRestart, R.P3)].map((e) => e.pid).sort()) === JSON.stringify(otherPidsBefore),
    killedEngineRespawnedWithPosture: has(afterKill, R.P1, /--disable-sandbox --sandbox-network enabled/) && !engineIn(afterKill, R.P1).some((e) => e.pid === p1Engine?.pid),
    sameSessionResumed: resumeCalls.some((c) => c.ok === true && c.sessionId === conv.P1.sid),
    settingsRestartAppliesGlobal: settings5.clicked && has(after5, R.P2, /--sandbox-network restricted/, /--disable-sandbox/),
    settingsRestartLeavesOthers: JSON.stringify(engineIn(after5, R.P3).map((e) => e.pid)) === JSON.stringify(p3PidsBefore5),
  };
  // macOS spelling checks: not exit criteria of the ticket, kept apart.
  record.macosSpelling = {
    varSpellingStartsReadOnly: conv.P4.ok === true && has(p4Start, R.P4, /--disable-write --disable-shell/),
    sameSpellingSettingsRestartKeepsReadOnly: settings6a.clicked && engineIn(p4AfterA, R.P4).length > 0 && engineIn(p4AfterA, R.P4).every((e) => /--disable-write --disable-shell/.test(e.flags)),
    resolvedSpellingSettingsRestartKeepsReadOnly: settings6b.clicked && engineIn(p4AfterB, R.P4).length > 0 && engineIn(p4AfterB, R.P4).every((e) => /--disable-write --disable-shell/.test(e.flags)),
    resolvedSpellingFlags: engineIn(p4AfterB, R.P4).map((e) => e.flags),
  };
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 800);
  if (error?.appOutput) record.appOutput = error.appOutput;
} finally {
  if (inst) {
    record.consoleErrors = inst.app.errors.slice(0, 20);
    record.stop = await inst.stop();
  }
}
record.limits = [
  "The restart confirmation and the folder dialog are answered by the IPC trace; the native NSAlert and NSOpenPanel are not driven.",
  "Engine session store and Keychain shared with the user (ADR 0003 amendment).",
];
if (record.macosSpelling && !record.macosSpelling.resolvedSpellingSettingsRestartKeepsReadOnly) {
  record.defects = [{
    severity: "security (posture widened)",
    what: "Settings' Restart workspace host looks the project up by spelling (projectOfFolder -> pathKey: lower case and separators, no symlink resolution). A Read only project whose folder is stored through a symlink (/var/...) is not recognised when Settings' default folder is the resolved spelling (/private/var/..., the one start_session canonicalises and the conversation stores): the folder's engine is respawned at the global level, here --disable-sandbox --sandbox-network enabled instead of --sandbox-network restricted --disable-write --disable-shell.",
    where: "src/hooks/useMuseSessions.ts restartHost (posture = hostSandboxConfigForProject(sandbox, projectOfFolder(projects, target))); src/lib/paths.ts pathKey",
    trigger: "a project root and Settings' default folder naming the same folder through two spellings (symlink). The harness supplied the /var spelling as the folder dialog's answer; whether NSOpenPanel itself ever returns a symlinked spelling is not verified here. The conversation's own paths (error-banner restart, resume after a kill) take the posture from the project id and are not affected.",
    notFixed: "app code untouched (src/, src-tauri/), as instructed",
  }];
}
record.passed = !record.failure && Object.values(record.verdicts ?? {}).every((v) => v === true) && record.stop?.leftAfterQuit?.length === 0;
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, verdicts: out.verdicts, failure: out.failure }, null, 2));
process.exit(out.passed ? 0 : 1);
