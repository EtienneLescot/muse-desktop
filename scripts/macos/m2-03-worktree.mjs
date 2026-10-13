#!/usr/bin/env node
/**
 * M2-03 native macOS proof: create a worktree automatically. The Windows
 * records are scripts/cdp-m2-03-worktree.mjs (Create & open from the welcome
 * screen, live turn) and scripts/ux-start-worktree.mjs (native command and a
 * refused path).
 *
 *   A. Welcome screen, project from a fresh Git repository, Worktree switch on,
 *      first message typed and sent with Enter: the conversation starts inside
 *      <repo>/.muse/worktrees/<name> on a muse/<name> branch (git worktree list,
 *      engine cwd read with lsof), the live turn answers there, and the main
 *      checkout is unchanged (HEAD, branch, status).
 *   B. Refusals of the native command (git_worktree_create_for_workspace,
 *      called as the renderer calls it): traversal, absolute path, a path
 *      outside .muse/worktrees, an existing path, the same path in another
 *      case (APFS is case-insensitive), option-shaped branch and base, a
 *      missing base ref; nothing is left behind (worktrees, branches, folders).
 *   C. Two simultaneous creations in the same repository: both succeed, on
 *      distinct folders and branches; removed afterwards with the app's own
 *      git_worktree_remove.
 *   D. A start that fails after the worktree was created (start_session
 *      refused by the harness): what remains, and what the user is told.
 *
 *   node scripts/macos/m2-03-worktree.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9453] [--base $TMPDIR/muse-proofs-g5/m2-03]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-03-worktree.json]
 *
 * One live turn.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, transcript } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9453"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-03")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-03-worktree.json");
mkdirSync(BASE_ARG, { recursive: true });
const BASE = realpathSync(BASE_ARG);
const REPO = join(BASE, "repo");
const TOKEN = `TREE-MAC-${ID.toUpperCase()}`;
const redact = redactor([[REPO, "<repo>"], [BASE, "<proof>"], [BASE_ARG, "<proof>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]);

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const branches = () => git("branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
const worktrees = () => git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
const managedDirs = () => { try { return readdirSync(join(REPO, ".muse", "worktrees")).sort(); } catch { return []; } };
const mainState = () => ({ head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), status: git("status", "--porcelain") });
function engineCwds(pid) {
  return processTree(pid).filter((p) => /muse-bin/.test(p.command)).map((p) => {
    try { return execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null; } catch { return null; }
  });
}
const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((v) => ({ ok: v }), (e) => ({ error: String(e).slice(0, 300) }))`);

const record = {
  schema: "muse-desktop.m2-03-worktree.macos.v1",
  ticket: "M2-03",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon, APFS (case-insensitive); debug build 08b291d with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  liveTurns: 1,
  harness: `scripts/macos/m2-03-worktree.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  method: "One isolated instance on a fresh Git repository (local user config, no global config touched). The project is created from the welcome screen (folder dialog answered by the IPC trace); the first message is typed with Input.insertText and sent with a real Enter. The refusals and the simultaneous creations call the app's native command through the Tauri IPC, as the renderer does. In D the harness refuses start_session (window.__baselineIpc.block) to stand for a failed admission.",
};
let inst = null;
try {
  mkdirSync(REPO, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", REPO]);
  git("config", "user.email", "proof@local");
  git("config", "user.name", "Proof Local");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(REPO, "README.md"), "# M2-03 macOS proof\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  const before = mainState();

  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  const { app } = inst;

  // A. Create & open from the welcome screen.
  const A = {};
  A.start = await newProjectConversation(app, REPO);
  A.switch = await app.ev(`(async () => {
    const box = document.querySelector('label.welcome-worktree input');
    if (!box) return { present: false };
    // The switch is enabled once the new project is the selected environment.
    for (let t = 0; t < 8000 && box.disabled; t += 100) await new Promise((r) => setTimeout(r, 100));
    const wasChecked = box.checked, disabled = box.disabled;
    if (!box.checked && !box.disabled) box.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('textarea[aria-label="Your first message"]').focus();
    return { present: true, wasChecked, disabled, checked: box.checked, note: document.querySelector('.welcome-project-note')?.innerText || null };
  })()`);
  const text = `Reply with exactly ${TOKEN} and nothing else.`;
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const started = await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.result)")).at(-1), 90_000);
  const created = (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'git_worktree_create_for_workspace')")).map((c) => ({ args: c.args, ok: c.ok, result: JSON.parse(c.result ?? "null") }));
  A.createCall = created;
  const sid = started?.ok ? JSON.parse(started.result).session_id : null;
  A.startSession = started ? { workspacePath: started.args?.workspacePath, ok: started.ok, sid } : null;
  A.replyStored = Boolean(sid && await waitFor(async () => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(TOKEN)), 180_000, 1_000));
  const wt = A.startSession?.workspacePath ?? "";
  A.worktreeBranch = wt && existsSync(wt) ? execFileSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).trim() : null;
  A.worktreeList = worktrees();
  A.engineCwds = engineCwds(inst.pid);
  A.header = await app.ev(`[...document.querySelectorAll('.task-metadata span[title]')].map((n) => n.getAttribute('title')).filter((t) => /worktrees/.test(t))`);
  A.mainAfter = mainState();
  A.mainBefore = before;
  record.A = A;

  // B. Refusals of the native command.
  const existingRel = `.muse/worktrees/${wt.split("/").at(-1)}`;
  const snapshot = () => ({ worktrees: worktrees(), branches: branches(), dirs: managedDirs() });
  const beforeB = snapshot();
  const cases = {
    traversal: { branch: `muse/t-${ID}`, relativePath: "../outside", baseRef: "HEAD" },
    absolutePath: { branch: `muse/a-${ID}`, relativePath: join(BASE, "abs"), baseRef: "HEAD" },
    outsideManaged: { branch: `muse/o-${ID}`, relativePath: "elsewhere/wt", baseRef: "HEAD" },
    traversalInsideManaged: { branch: `muse/i-${ID}`, relativePath: ".muse/worktrees/../../escape", baseRef: "HEAD" },
    existingPath: { branch: `muse/e-${ID}`, relativePath: existingRel, baseRef: "HEAD" },
    existingPathOtherCase: { branch: `muse/c-${ID}`, relativePath: existingRel.replace(/[^/]+$/, (n) => n.toUpperCase()), baseRef: "HEAD" },
    optionShapedBranch: { branch: "--orphan", relativePath: `.muse/worktrees/opt-${ID}`, baseRef: "HEAD" },
    optionShapedBase: { branch: `muse/ob-${ID}`, relativePath: `.muse/worktrees/optb-${ID}`, baseRef: "--detach" },
    missingBaseRef: { branch: `muse/m-${ID}`, relativePath: `.muse/worktrees/missing-${ID}`, baseRef: "no-such-branch" },
    existingBranchOtherCase: { branch: A.worktreeBranch ? A.worktreeBranch.toUpperCase().replace(/^MUSE\//, "muse/") : `muse/X-${ID}`, relativePath: `.muse/worktrees/bcase-${ID}`, baseRef: "HEAD" },
  };
  const B = {};
  for (const [name, args] of Object.entries(cases)) B[name] = await invoke(app, "git_worktree_create_for_workspace", { workspace: REPO, ...args });
  const afterB = snapshot();
  record.B = { cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { request: v, answer: B[k] }])), before: beforeB, after: afterB };

  // C. Two simultaneous creations.
  const pair = await app.ev(`Promise.all([1, 2].map((n) => window.__TAURI_INTERNALS__.invoke('git_worktree_create_for_workspace',
    { workspace: ${JSON.stringify(REPO)}, branch: 'muse/sim' + n + '-${ID}', relativePath: '.muse/worktrees/sim' + n + '-${ID}', baseRef: 'HEAD' })
    .then((v) => ({ ok: v }), (e) => ({ error: String(e).slice(0, 300) }))))`);
  const C = { answers: pair, worktrees: worktrees(), branches: branches() };
  C.removed = [];
  for (const answer of pair) if (answer.ok?.path) C.removed.push(await invoke(app, "git_worktree_remove", { workspace: REPO, path: answer.ok.path, force: false }));
  C.afterRemove = { worktrees: worktrees(), dirs: managedDirs() };
  record.C = C;

  // D. A start refused after the worktree was created.
  const beforeD = snapshot();
  await app.ev("(window.__baselineIpc.calls = [], window.__baselineIpc.block = ['start_session'], true)");
  await app.ev(`(async () => { const n = document.querySelector('.primary-nav button[aria-label="New conversation"]'); n.click(); return true; })()`);
  await sleep(1_500);
  const D = {};
  D.screen = await app.ev(`(async () => {
    const picker = document.querySelector('details.project-picker-control');
    picker.open = true;
    await new Promise((r) => setTimeout(r, 300));
    const option = [...picker.querySelectorAll('[role="option"].project-option')].find((o) => /\\brepo\\b/.test(o.innerText));
    if (option) option.click();
    await new Promise((r) => setTimeout(r, 400));
    const box = document.querySelector('label.welcome-worktree input');
    for (let t = 0; t < 8000 && box && box.disabled; t += 100) await new Promise((r) => setTimeout(r, 100));
    if (box && !box.checked && !box.disabled) box.click();
    await new Promise((r) => setTimeout(r, 300));
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'admission probe');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { worktreeOn: box?.checked ?? null, note: document.querySelector('.welcome-project-note')?.innerText || null };
  })()`);
  await app.ev("document.querySelector('button.welcome-send').click(), true");
  await sleep(6_000);
  D.calls = (await app.ev("window.__baselineIpc.calls.filter((c) => /worktree|start_session|send_input/.test(c.cmd))")).map((c) => ({ cmd: c.cmd, ok: c.ok, blockedByHarness: c.blockedByHarness === true, path: c.cmd.startsWith('git_worktree') ? (JSON.parse(c.result ?? "null")?.path ?? null) : undefined }));
  D.shown = await app.ev(`[...document.querySelectorAll('[role="alert"], .error-banner')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)`);
  D.draftKept = await app.ev(`document.querySelector('textarea[aria-label="Your first message"]')?.value === 'admission probe'`);
  D.after = snapshot();
  D.before = beforeD;
  D.leftBehind = { worktrees: D.after.worktrees.filter((w) => !beforeD.worktrees.includes(w)), branches: D.after.branches.filter((b) => !beforeD.branches.includes(b)) };
  await app.ev("(window.__baselineIpc.block = [], true)");
  record.D = D;

  const refusedAll = Object.values(B).every((a) => typeof a.error === "string" && !a.ok);
  record.verdicts = {
    worktreeSwitchOffered: A.switch.present === true && A.switch.checked === true,
    createdUnderMuseWorktrees: created.length === 1 && created[0].ok === true && wt.startsWith(join(REPO, ".muse", "worktrees") + "/"),
    conversationStartsInWorktree: A.startSession?.ok === true && created[0]?.result?.path === wt,
    museBranch: /^muse\//.test(A.worktreeBranch ?? ""),
    gitListsWorktree: A.worktreeList.includes(wt),
    engineRunsInWorktree: A.engineCwds.includes(wt),
    liveTurnAnsweredInWorktree: A.replyStored,
    mainCheckoutUnchanged: JSON.stringify(A.mainAfter) === JSON.stringify(before),
    refusalsAll: refusedAll,
    refusalsLeaveNothing: JSON.stringify(afterB) === JSON.stringify(beforeB),
    otherCasePathRefused: typeof B.existingPathOtherCase.error === "string",
    twoSimultaneousCreations: pair.every((a) => a.ok?.path) && new Set(pair.map((a) => a.ok?.path)).size === 2 && pair.every((a) => C.worktrees.includes(a.ok.path)),
    simultaneousRemovedByApp: C.removed.every((r) => !("error" in r)) && pair.every((a) => !C.afterRemove.worktrees.includes(a.ok?.path)),
    // "atomic Create & open with admission rollback" (ROADMAP M2-03).
    failedStartRollsBackWorktree: D.calls.some((c) => c.cmd === "git_worktree_create_for_workspace" && c.ok) && D.leftBehind.worktrees.length === 0 && D.leftBehind.branches.length === 0,
  };
  record.observations = { failedStartDraftKept: D.draftKept, failedStartMessage: D.shown };
  if (!record.verdicts.failedStartRollsBackWorktree) {
    record.defects = [{
      what: "A conversation whose start fails after the welcome screen created its worktree leaves that worktree and its muse/ branch behind, and the message does not mention them; each retry creates another one (a new name per attempt).",
      where: "src/App.tsx, welcome onStart: createWorktreeForWorkspace then startSessionInWorkspace; on a null id it returns false with no git_worktree_remove. The native one-step Create & open with rollback that the roadmap describes no longer exists (no such command in src-tauri/src/main.rs at 08b291d).",
      platform: "shared code, not specific to macOS; the Windows record does not exercise this path.",
      loss: "none: the leftover is a clean checkout of the base, removable from the cleanup surface (M2-06).",
    }];
  }
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
  "The folder dialog is answered by the IPC trace; in D the start refusal is forged by the harness (no real admission failure was available on demand).",
  "Disk-full failures are not exercised.",
];
record.passed = !record.failure && Object.values(record.verdicts ?? {}).every((v) => v === true) && record.stop?.leftAfterQuit?.length === 0;
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, verdicts: out.verdicts, observations: out.observations, failure: out.failure }, null, 2));
process.exit(out.passed ? 0 : 1);
