#!/usr/bin/env node
/**
 * M2-04 + M2-06 native macOS proof, through Settings' Worktree tools. The
 * Windows record is scripts/cdp-m2-04-06-setup-cleanup.mjs. No model turn:
 * conversations are started with "New conversation here" (start_session).
 *
 * Fixture: a fresh Git repository; worktrees A (made by the app, the active
 * conversation runs in it), B (dirty), C (clean), D (clean, ten days old) and
 * E (clean, ten days old, attached to a second conversation; created with
 * the git CLI through the /var spelling of the temp folder, a macOS symlink).
 *
 * M2-04, on A: the setup surface is shown; a command runs in A (proof file,
 * pwd); a failing one reports failed + exit 5; a retry is ready; `sleep`
 * cancelled through Cancel setup, simple and compound (`sleep; echo`), with
 * the time to "cancelled" and the processes left; readiness detects
 * package.json and git/node; the runner refuses the main checkout and a
 * command over 2,000 characters; the command is kept per workspace; what
 * the runner passes on of the app's environment (a planted variable).
 *
 * M2-06: Inspect all lists the main checkout and every worktree with branch,
 * clean/dirty and age; the native removal refuses B (dirty), the main
 * checkout and a folder outside the repository; Remove on C removes it; with
 * "Keep 7 days", Clean up removes D only (B dirty, A active, E attached kept);
 * the retention persists per repository across a reload.
 * Then two probes of the per-row buttons: Force remove on B, Remove on A.
 *
 *   node scripts/macos/m2-04-06-setup-cleanup.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9454] [--base $TMPDIR/muse-proofs-g5/m2-04-06]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-04-06-setup-cleanup.json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";

const BUILD = argValue("--build-commit", "08b291d");
const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9454"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-04-06")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-04-06-setup-cleanup.json");
mkdirSync(BASE_ARG, { recursive: true });
const BASE = realpathSync(BASE_ARG);
const VAR_BASE = BASE.replace(/^\/private\/var\//, "/var/");
const REPO = join(BASE, "repo");
const WT = (n) => join(REPO, ".muse", "worktrees", n);
const PLANTED = "M2_04_PLANTED_SECRET";
const redact = redactor([[REPO, "<repo>"], [join(VAR_BASE, "repo"), "<repo via /var>"], [BASE, "<proof>"], [VAR_BASE, "<proof via /var>"], [BASE_ARG, "<proof>"],
  [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]);
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const worktrees = () => git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
const old = (path) => { const t = (Date.now() - 10 * 86_400_000) / 1000; utimesSync(path, t, t); };

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
  const tools = () => document.querySelector('[aria-label="Worktree tools"]');
  const rows = () => [...document.querySelectorAll('.worktree-inspections li')].map((li) => ({ path: li.querySelector('code')?.innerText || '', text: li.querySelector('span')?.innerText || '', button: li.querySelector('button')?.innerText || null }));
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

async function openSettings(app) {
  await app.ev(page("document.querySelector('button[aria-label=\"Settings\"]').click(); return true;"));
  return waitFor(() => app.ev(page("return Boolean(tools());")), 10_000);
}

async function selectConversation(app, sid) {
  const title = await app.ev(`(JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').find((s) => s.session_id === ${JSON.stringify(sid)}) || {}).title || null`);
  await app.ev(page(`const row = q('button.session-select').find((b) => (b.getAttribute('title') || '') === ${JSON.stringify(title)}); if (row) row.click(); return Boolean(row);`));
  await sleep(1_500);
}

/** Types the command, clicks Run setup, waits for an outcome; optionally cancels after `cancelAfterMs`. */
async function runSetup(app, command, cancelAfterMs = null, afterCancel = null) {
  await app.ev(page(`setValue(tools().querySelector('textarea[aria-label="Worktree setup command"]'), ${JSON.stringify(command)}); return true;`));
  await sleep(300);
  const t0 = Date.now();
  await app.ev(page("button('Run setup', tools()).click(); return true;"));
  let cancelClickedAt = null;
  if (cancelAfterMs !== null) {
    await sleep(cancelAfterMs);
    const clicked = await waitFor(() => app.ev(page("const b = button('Cancel setup', tools()); if (b) b.click(); return Boolean(b);")), 5_000, 100);
    cancelClickedAt = clicked ? Date.now() : null;
  }
  const during = afterCancel ? await afterCancel() : undefined;
  const status = await waitFor(() => app.ev(page("const s = [...tools().querySelectorAll('[role=status]')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).find((t) => /^Setup (ready|failed|timedOut|cancelled)/.test(t)); return s || null;")), 60_000, 200);
  return { command, status, uiMs: Date.now() - t0, cancelToOutcomeMs: cancelClickedAt ? Date.now() - cancelClickedAt : null, ...(during === undefined ? {} : { during }) };
}

const record = {
  schema: "muse-desktop.m2-04-06-setup-cleanup.macos.v1",
  tickets: ["M2-04", "M2-06"],
  date: new Date().toISOString().slice(0, 10),
  commit: BUILD,
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon, APFS; debug build ${BUILD} with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  liveTurns: 0,
  harness: `scripts/macos/m2-04-06-setup-cleanup.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  method: `One isolated instance, started with an extra variable ${PLANTED} in its environment. Settings' Worktree tools are driven through their DOM (values set, buttons clicked). Worktrees B to E are made with the git CLI as a user would outside the app; ages are set with utimes (ten days back). Native commands are called through the Tauri IPC only for the refusals the UI cannot ask for. The folder dialog and the confirmation boxes go through the IPC trace; every plugin:dialog call is recorded.`,
  m204: {}, m206: {},
};
let inst = null;
try {
  mkdirSync(REPO, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", REPO]);
  git("config", "user.email", "proof@local");
  git("config", "user.name", "Proof Local");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(REPO, "README.md"), "# M2-04/06 macOS proof\n");
  git("add", "-A");
  git("commit", "-qm", "initial");

  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data"), env: { [PLANTED]: "visible-to-setup" } });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const { app } = inst;
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);

  // Worktree A by the app's own command; E with the git CLI through /var.
  const a = await app.ev(`window.__TAURI_INTERNALS__.invoke('git_worktree_create_for_workspace', { workspace: ${JSON.stringify(REPO)}, branch: 'muse/wt-a', relativePath: '.muse/worktrees/wt-a', baseRef: 'HEAD' })`);
  const A = a.path;
  execFileSync("git", ["-C", join(VAR_BASE, "repo"), "worktree", "add", "-q", "-b", "muse/wt-e", ".muse/worktrees/wt-e"]);
  const E = WT("wt-e");
  // One project, two roots (A, E); one conversation in each.
  await app.ev(page("q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)).click(); return true;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify([A, E])}), true)`);
  await app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], 'm2-04-06-${ID}');
    button('Choose project folders').click(); await wait(800);
    button('+ Add project').click(); await wait(800); return true;`));
  const sids = {};
  for (const [k, root] of [["E", E], ["A", A]]) {
    await app.ev(page("q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)).click(); return true;"));
    await sleep(800);
    const n = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session').length");
    await app.ev(page(`
      const row = q('li.project-item').find((li) => /m2-04-06-${ID}/.test(li.innerText));
      row.querySelector('details').open = true;
      setValue(row.querySelector('select[aria-label^="Conversation folder for"]'), ${JSON.stringify(root)});
      await wait(300);
      button('New conversation here', row).click();
      return true;`));
    const call = await waitFor(async () => { const c = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session')"); return c.length > n && c.at(-1).ok !== undefined ? c.at(-1) : null; }, 60_000);
    sids[k] = call?.ok ? JSON.parse(call.result).session_id : null;
    await sleep(1_000);
  }
  record.fixture = { sids, sessionWorkspaces: await app.ev(`JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').map((s) => s.workspace)`) };

  // ---- M2-04 on A (the active conversation).
  await selectConversation(app, sids.A);
  await openSettings(app);
  const m4 = record.m204;
  m4.surface = await app.ev(page("return { setup: Boolean(tools().querySelector('textarea[aria-label=\"Worktree setup command\"]')), readiness: Boolean(button('Check readiness', tools())), note: (tools().querySelector('.worktree-setup .settings-note')?.innerText || '').slice(0, 200) };"));
  m4.ready = await runSetup(app, `echo M2-04-SETUP-PROOF > setup-proof.txt; pwd > setup-pwd.txt; env | cut -d= -f1 | sort > setup-env.txt`);
  m4.proofFile = existsSync(join(A, "setup-proof.txt")) ? readFileSync(join(A, "setup-proof.txt"), "utf8").trim() : null;
  m4.pwd = existsSync(join(A, "setup-pwd.txt")) ? readFileSync(join(A, "setup-pwd.txt"), "utf8").trim() : null;
  // Only what the proof needs of the environment: names are not recorded.
  const envKeys = existsSync(join(A, "setup-env.txt")) ? readFileSync(join(A, "setup-env.txt"), "utf8").trim().split("\n") : [];
  m4.environment = { count: envKeys.length, planted: envKeys.includes(PLANTED), kept: ["PATH", "HOME", "TMPDIR", "LANG", "USER"].filter((k) => envKeys.includes(k)),
    testSwitches: envKeys.filter((k) => /^MUSE_DESKTOP_TEST_/.test(k)).length };
  m4.proofNotInMain = !existsSync(join(REPO, "setup-proof.txt"));
  m4.failed = await runSetup(app, "exit 5");
  m4.retry = await runSetup(app, "echo retry > setup-retry.txt");
  m4.retry.fileWritten = existsSync(join(A, "setup-retry.txt"));
  const sleepsLeft = (n) => execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.trim() === `sleep ${n}`).length;
  m4.cancelSimple = await runSetup(app, "sleep 29", 1_500);
  await sleep(500);
  m4.cancelSimple.sleepLeft = sleepsLeft(29);
  m4.cancelCompound = await runSetup(app, "sleep 27; echo late > setup-late.txt", 1_500, async () => {
    await sleep(2_000);
    return { sleepAlive2sAfterCancel: sleepsLeft(27), uiStillRunning: await app.ev(page("return Boolean(button('Running setup…', tools()));")) };
  });
  await sleep(500);
  m4.cancelCompound.sleepLeft = sleepsLeft(27);
  writeFileSync(join(A, "package.json"), "{}\n");
  await app.ev(page("button('Check readiness', tools()).click(); return true;"));
  m4.readiness = await waitFor(() => app.ev(page("return [...tools().querySelectorAll('[role=status]')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).find((t) => /^Readiness:/.test(t)) || null;")), 20_000);
  m4.refuseMain = await app.ev(`window.__TAURI_INTERNALS__.invoke('git_worktree_setup_run', { workspace: ${JSON.stringify(REPO)}, path: ${JSON.stringify(REPO)}, command: 'echo nope > refused.txt', token: 'refusal-probe' }).then((v) => ({ ran: v }), (e) => ({ error: String(e) }))`);
  m4.refuseLong = await app.ev(`window.__TAURI_INTERNALS__.invoke('git_worktree_setup_run', { workspace: ${JSON.stringify(REPO)}, path: ${JSON.stringify(A)}, command: 'echo ' + 'x'.repeat(2001), token: 'long-probe' }).then((v) => ({ ran: v.status }), (e) => ({ error: String(e) }))`);
  m4.storedCommand = await app.ev(`JSON.parse(localStorage.getItem('muse-desktop.worktree-setup.v1') || '{}')[${JSON.stringify(A)}] ?? null`);
  // A compound sleep cancelled from the UI lets its tail run once the sleep ends.
  await sleep(27_000);
  m4.cancelCompound.tailRanAfterCancel = existsSync(join(A, "setup-late.txt"));

  // ---- M2-06.
  const m6 = record.m206;
  git("worktree", "add", "-q", "-b", "muse/wt-b", ".muse/worktrees/wt-b");
  writeFileSync(join(WT("wt-b"), "uncommitted.txt"), "work not committed\n");
  git("worktree", "add", "-q", "-b", "muse/wt-c", ".muse/worktrees/wt-c");
  git("worktree", "add", "-q", "-b", "muse/wt-d", ".muse/worktrees/wt-d");
  // A's own setup files make it dirty: commit them there so A is clean too.
  execFileSync("git", ["-C", A, "add", "-A"]);
  execFileSync("git", ["-C", A, "-c", "user.email=proof@local", "-c", "user.name=Proof Local", "commit", "-qm", "setup files"]);
  for (const p of [A, WT("wt-d"), E]) old(p);
  m6.gitList = worktrees();
  await app.ev(page("button('Inspect all', tools()).click(); return true;"));
  await waitFor(() => app.ev(page("return rows().length >= 6;")), 20_000);
  m6.inspect = await app.ev(page("return rows();"));
  const native = (path, force = false) => app.ev(`window.__TAURI_INTERNALS__.invoke('git_worktree_remove', { workspace: ${JSON.stringify(REPO)}, path: ${JSON.stringify(path)}, force: ${force} }).then(() => ({ removed: true }), (e) => ({ error: String(e) }))`);
  mkdirSync(join(BASE, "outside"), { recursive: true });
  m6.refusals = { dirty: await native(WT("wt-b")), mainCheckout: await native(REPO), outsideRepository: await native(join(BASE, "outside")) };
  m6.afterRefusals = { list: worktrees(), dirtyFileKept: existsSync(join(WT("wt-b"), "uncommitted.txt")) };
  const dialogsBefore = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd.startsWith('plugin:dialog')).length");
  m6.removeC = await app.ev(page(`const li = [...document.querySelectorAll('.worktree-inspections li')].find((x) => x.querySelector('code')?.innerText.endsWith('/wt-c')); const b = li?.querySelector('button'); const label = b?.innerText; b?.click(); await wait(2500); return { label, status: [...tools().querySelectorAll('[role=status]')].map((n) => n.innerText.trim()).filter((t) => /^Removed|error|refused/i.test(t)) };`));
  m6.removeC.onDisk = existsSync(WT("wt-c"));
  m6.removeC.listed = worktrees().includes(WT("wt-c"));
  await app.ev(page("setValue(tools().querySelector('select[aria-label=\"Worktree retention\"]'), '7'); await wait(300); button('Inspect all', tools()).click(); await wait(2500); return true;"));
  m6.cleanUp = await app.ev(page("button('Clean up', tools()).click(); await wait(4000); return { status: [...tools().querySelectorAll('[role=status]')].map((n) => n.innerText.trim()).filter((t) => /^Removed/.test(t)), rows: rows() };"));
  m6.afterCleanUp = { list: worktrees(), A: existsSync(A), B: existsSync(WT("wt-b")), D: existsSync(WT("wt-d")), E: existsSync(E) };
  m6.retentionStored = await app.ev("JSON.parse(localStorage.getItem('muse-desktop.worktree-retention.v1') || '{}')");
  await app.send("Page.reload", {});
  await sleep(1_500);
  await waitFor(() => app.ev(`document.readyState === 'complete' && document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`).catch(() => false), 30_000);
  await app.ev(INSTALL_IPC_TRACE);
  await selectConversation(app, sids.A);
  await openSettings(app);
  m6.retentionAfterReload = await app.ev(page("return tools().querySelector('select[aria-label=\"Worktree retention\"]').value;"));
  m6.dialogsDuringRemoveAndCleanUp = dialogsBefore;

  // Probes of the per-row buttons (sandbox data only).
  await app.ev(page("button('Inspect all', tools()).click(); await wait(2500); return true;"));
  m6.rowsBeforeProbes = await app.ev(page("return rows();"));
  // Force remove on the dirty row: a confirmation box first (answered Cancel,
  // then OK through the IPC trace, as the user's click would).
  const clickRow = (suffix) => app.ev(page(`const li = [...document.querySelectorAll('.worktree-inspections li')].find((x) => x.querySelector('code')?.innerText.endsWith(${JSON.stringify(suffix)})); const b = li?.querySelector('button'); const label = b?.innerText; const disabled = Boolean(b?.disabled); const title = b?.title || null; b?.click(); await wait(2500); return { label, disabled, title, rowText: li?.querySelector('span')?.innerText };`));
  const dialogs = () => app.ev("window.__baselineIpc.calls.filter((c) => c.cmd.startsWith('plugin:dialog')).map((c) => ({ cmd: c.cmd, message: c.args?.message ?? null, answered: Boolean(c.answeredByHarness) }))");
  const dialogsAtProbe = (await dialogs()).length;
  await app.ev("(window.__baselineIpc.messageQueue.push('Cancel'), true)");
  m6.probeForceRemoveDirty = await clickRow("/wt-b");
  m6.probeForceRemoveDirty.dialogCalls = (await dialogs()).slice(dialogsAtProbe);
  m6.probeForceRemoveDirty.worktreeGone = !existsSync(WT("wt-b"));
  m6.probeForceRemoveDirty.uncommittedFileLost = !existsSync(join(WT("wt-b"), "uncommitted.txt"));
  const dialogsAtYes = (await dialogs()).length;
  await app.ev("(window.__baselineIpc.messageQueue.push('Ok'), true)");
  m6.probeForceRemoveConfirmed = await clickRow("/wt-b");
  m6.probeForceRemoveConfirmed.dialogCalls = (await dialogs()).slice(dialogsAtYes);
  m6.probeForceRemoveConfirmed.worktreeGone = !existsSync(WT("wt-b"));
  const dialogsAtActive = (await dialogs()).length;
  m6.probeRemoveActive = await clickRow("/wt-a");
  m6.probeRemoveActive.dialogCalls = (await dialogs()).slice(dialogsAtActive).map((d) => d.cmd);
  m6.probeRemoveActive.worktreeGone = !existsSync(A);
  m6.probeRemoveActive.engineCwds = processTree(inst.pid).filter((p) => /muse-bin/.test(p.command)).map((p) => { try { return execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1); } catch { return null; } });

  const row = (suffix) => m6.inspect.find((r) => r.path.endsWith(suffix)) ?? null;
  record.verdicts = {
    "M2-04.setupSurfaceInWorktree": m4.surface.setup && m4.surface.readiness,
    "M2-04.setupRunsInWorktree": /^Setup ready/.test(m4.ready.status ?? "") && m4.proofFile === "M2-04-SETUP-PROOF" && m4.pwd === A && m4.proofNotInMain,
    "M2-04.failureCarriesExitCode": /^Setup failed .*exit 5/.test(m4.failed.status ?? ""),
    "M2-04.retryAfterFailure": /^Setup ready/.test(m4.retry.status ?? "") && m4.retry.fileWritten,
    "M2-04.cancelSimpleCommand": /^Setup cancelled/.test(m4.cancelSimple.status ?? "") && m4.cancelSimple.cancelToOutcomeMs < 5_000 && m4.cancelSimple.sleepLeft === 0,
    "M2-04.readinessDetects": /package\.json/.test(m4.readiness ?? "") && /git available/.test(m4.readiness ?? "") && /node (available|missing)/.test(m4.readiness ?? ""),
    "M2-04.refusesMainCheckout": /under \.muse\/worktrees/.test(m4.refuseMain.error ?? "") && !existsSync(join(REPO, "refused.txt")),
    "M2-04.refusesOverlongCommand": /2000 character limit/.test(m4.refuseLong.error ?? ""),
    "M2-04.commandKeptPerWorkspace": typeof m4.storedCommand === "string" && m4.storedCommand.length > 0,
    "M2-06.inspectListsAll": m6.inspect.some((r) => r.text === "main checkout") && ["/wt-a", "/wt-b", "/wt-c", "/wt-d", "/wt-e"].every((s) => row(s)),
    "M2-06.realStatusAndAge": /muse\/wt-b · dirty · today/.test(row("/wt-b")?.text ?? "") && /muse\/wt-c · clean · today/.test(row("/wt-c")?.text ?? "") && /muse\/wt-d · clean · 10 days/.test(row("/wt-d")?.text ?? ""),
    "M2-06.attachedShown": /attached to a conversation/.test(row("/wt-a")?.text ?? "") && /attached to a conversation/.test(row("/wt-e")?.text ?? ""),
    "M2-06.dirtyRemovalRefused": /uncommitted changes/.test(m6.refusals.dirty.error ?? "") && m6.afterRefusals.dirtyFileKept,
    "M2-06.outsideTargetsRefused": /\.muse\/worktrees/.test(m6.refusals.mainCheckout.error ?? "") && /\.muse\/worktrees/.test(m6.refusals.outsideRepository.error ?? ""),
    "M2-06.cleanRemovedFromPanel": m6.removeC.label === "Remove" && !m6.removeC.onDisk && !m6.removeC.listed,
    "M2-06.cleanUpRemovesOnlyEligible": !m6.afterCleanUp.D && m6.afterCleanUp.B && m6.afterCleanUp.A,
    "M2-06.cleanUpSparesAttachedViaSymlinkSpelling": m6.afterCleanUp.E,
    "M2-06.retentionPersistsPerRepository": m6.retentionAfterReload === "7" && Object.values(m6.retentionStored).includes(7),
    "M2-06.forceRemoveAsksAndCancelKeeps": m6.probeForceRemoveDirty.label === "Force remove" && m6.probeForceRemoveDirty.dialogCalls.length === 1
      && /uncommitted changes/.test(m6.probeForceRemoveDirty.dialogCalls[0]?.message ?? "") && !m6.probeForceRemoveDirty.worktreeGone && !m6.probeForceRemoveDirty.uncommittedFileLost,
    "M2-06.forceRemoveOnlyAfterYes": m6.probeForceRemoveConfirmed.dialogCalls.length === 1 && m6.probeForceRemoveConfirmed.worktreeGone,
    "M2-06.attachedRowNotRemovable": m6.probeRemoveActive.disabled && /attached to a conversation/.test(m6.probeRemoveActive.rowText ?? "") && !m6.probeRemoveActive.worktreeGone && m6.probeRemoveActive.dialogCalls.length === 0,
  };
  record.findings = {
    setupEnvironmentPassesAppVariables: m4.environment.planted,
    compoundCancelLeavesChildRunning: (m4.cancelCompound.during?.sleepAlive2sAfterCancel ?? 0) > 0,
    compoundCancel: m4.cancelCompound,
    forceRemoveWithoutConfirmation: m6.probeForceRemoveDirty.label === "Force remove" && m6.probeForceRemoveDirty.uncommittedFileLost && m6.probeForceRemoveDirty.dialogCalls.length === 0,
    removeActiveConversationWorktree: m6.probeRemoveActive.worktreeGone,
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
const f = record.findings ?? {};
record.defects = [
  f.forceRemoveWithoutConfirmation && {
    ticket: "M2-06", severity: "data loss",
    what: "Settings > Worktrees: the per-row \"Force remove\" of a dirty worktree removes it with its uncommitted files in one click, with no confirmation box (no plugin:dialog call recorded). The native refusal (\"worktree has uncommitted changes; inspect it and confirm the forced removal\") only applies when force is false, and the button always sends force: true for a dirty row.",
    where: "src/components/WorktreeTools.tsx: onClick={() => void removeWorktree(inspection.path, !inspection.clean)}; src-tauri/src/git.rs remove_worktree.",
    platform: "shared code, not specific to macOS",
  },
  f.removeActiveConversationWorktree && {
    ticket: "M2-06", severity: "work removed from under a conversation (clean checkout: no uncommitted loss here)",
    what: "The per-row \"Remove\" removes a clean worktree that the panel itself labels \"attached to a conversation\", including the active conversation's own worktree, while its engine still runs there (lsof cwd). Only the bulk Clean up skips attached worktrees; the native command does not check attachment.",
    where: "src/components/WorktreeTools.tsx removeWorktree (no attachedWorktree check, no confirmation); git_worktree_remove in src-tauri/src/main.rs.",
    platform: "shared code, not specific to macOS",
  },
  f.compoundCancelLeavesChildRunning && {
    ticket: "M2-04", severity: "cancellation not effective",
    what: "Cancel setup kills only the `sh` process: a command with more than one step (here `sleep 27; echo …`, as `npm install && …` would be) keeps its running child, the UI stays on \"Running setup…\" and reports \"cancelled\" only when that child ends (the output pipes stay open). The same kill is used for the ten-minute timeout.",
    where: "src-tauri/src/git.rs run_worktree_setup, #[cfg(not(target_os = \"windows\"))] branch: Command::new(\"sh\") without a process group, child.kill() on cancel and timeout, then reader.join() on the inherited pipes.",
    platform: "the non-Windows code path (macOS and Linux)",
  },
  f.setupEnvironmentPassesAppVariables && {
    ticket: "M2-04", severity: "low",
    what: "The setup command inherits the app's whole environment (a variable planted in the app's environment is visible to it); the roadmap's \"purges the inherited environment\" does not match the code (no env_clear).",
    where: "src-tauri/src/git.rs run_worktree_setup",
    platform: "shared code",
  },
].filter(Boolean);
record.proposedMacosState = {
  "M2-04": record.defects.some((d) => d.ticket === "M2-04" && d.severity !== "low") ? "◐ (verdicts pass; cancellation of a multi-step command is not effective on the non-Windows path)" : "☑",
  "M2-06": record.defects.some((d) => d.ticket === "M2-06") ? "◐ (verdicts pass; the per-row buttons remove dirty or attached worktrees without the refusal the ticket requires)" : "☑",
};
record.notProved = [
  "M2-06 persistent cleanup intent resumed after an interruption: muse-desktop.worktree-cleanup.v1 is loaded and saved by useMuseSessions but nothing writes an intent and no Retry cleanup action exists at 08b291d, so there is nothing to resume.",
];
record.limits = [
  "The ten-minute kill (timedOut) is not waited for; it is covered by the Rust tests only.",
  "Ages are set with utimes on the worktree folder, the value the inspection reads.",
  "Engine session store and Keychain shared with the user (ADR 0003 amendment).",
];
record.passed = !record.failure && Object.values(record.verdicts ?? {}).every((v) => v === true) && record.stop?.leftAfterQuit?.length === 0;
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, verdicts: out.verdicts, findings: out.findings, failure: out.failure }, null, 2));
process.exit(out.passed ? 0 : 1);
