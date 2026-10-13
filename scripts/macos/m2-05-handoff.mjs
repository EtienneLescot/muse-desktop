#!/usr/bin/env node
/**
 * M2-05 native macOS proof: move a conversation from Local to a worktree and
 * back, in the same session. The Windows records are
 * scripts/cdp-m2-05-handoff.mjs (phases move, turn-worktree, restart, back,
 * conflict, failure; c-*; f-*). Here, one test repository and one
 * conversation, on two isolated instances (a real restart between them):
 *
 *   move      every kind of uncommitted work in Local (tracked, staged, staged
 *             new, deleted, binary, untracked text and binary, ignored); the
 *             conversation's Move to worktree, its question answered Cancel
 *             (nothing moves), then OK: same session, the worktree holds the
 *             work byte for byte, Local is clean, the ignored file stays.
 *   turn 1    in the worktree: the model's shell (pwd) and file tool (a file
 *             that only the worktree has); while the turn waits on a card,
 *             the Move action is refused.
 *   restart   the app closed from its window and started again on the same
 *             data: the conversation resumes in the worktree; turn 2: pwd.
 *   back      Move back to local: the round trip is byte-identical.
 *   conflict  Move to worktree again (3,000 extra untracked files to make the
 *             move last; a send through the composer meanwhile), then Local
 *             changes the same line: Move back is refused before the
 *             question, and handoff_move refuses it too; nothing changes.
 *   failure   macOS stand-in for Windows' file held open: a Local file the
 *             move back must rewrite is made immutable (chflags uchg). The
 *             move fails after writing; both sides restored; Local watched.
 *   held      the same flag on an untracked Local file the move to a new
 *             worktree must delete: the move fails, the worktree made for it
 *             goes with its branch.
 *   case      a staged case-only rename (APFS is case-insensitive): refused
 *             as a conflict, nothing written, the worktree made for it goes.
 *
 * Each phase compares both folders byte for byte; a phase that finds work
 * missing from both folders stops the run and says so first (dataLoss).
 *
 *   node scripts/macos/m2-05-handoff.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9455] [--base $TMPDIR/muse-proofs-g5/m2-05]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-05-handoff.json]
 *
 * Two live turns.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9455"));
const ID = Date.now().toString(36);
const BASE_ARG = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g5", "m2-05")), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-05-handoff.json");
mkdirSync(BASE_ARG, { recursive: true });
const BASE = realpathSync(BASE_ARG);
const REPO = join(BASE, "repo");
const DATA = join(BASE, "data");
const J = JSON.stringify;
const sha = (data) => createHash("sha256").update(data ?? "").digest("hex").slice(0, 16);
const lines = (t) => String(t).split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

const INITIAL = {
  "README.md": "# m2-05 macOS test repository\n",
  ".gitignore": "*.log\n",
  "src/app.txt": Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  "staged.txt": "staged v1\n",
  "deleted.txt": "this file is deleted in Local\n",
};
const BLOB_V1 = Buffer.from([0, 255, 13, 10, 137, 80, 78, 71, 0, 10, 26, 0]);
const BLOB_V2 = Buffer.from([0, 255, 13, 10, 137, 80, 78, 71, 0, 10, 26, 0, 1, 2, 3, 13, 10, 0]);
const NEW_BIN = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 13) % 256));

function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && (entry.name === ".git" || entry.name === ".muse")) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) walk(full);
      else out[rel] = entry.isFile() ? sha(readFileSync(full)) : "<not a file>";
    }
  };
  walk(root);
  const bulk = Object.entries(out).filter(([p]) => p.startsWith("bulk/"));
  const rest = Object.fromEntries(Object.entries(out).filter(([p]) => !p.startsWith("bulk/")).sort(([a], [b]) => (a < b ? -1 : 1)));
  return bulk.length === 0 ? rest : { ...rest, [`bulk/ (${bulk.length} files)`]: sha(bulk.sort().map(([p, h]) => `${p}:${h}`).join("\n")) };
}
function side(dir) {
  const status = lines(git(dir, ["status", "--porcelain=v1", "-uall"]));
  const bulk = status.filter((l) => l.slice(3).startsWith("bulk/"));
  return {
    branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: bulk.length === 0 ? status : [...status.filter((l) => !bulk.includes(l)), `${[...new Set(bulk.map((l) => l.slice(0, 2)))].join("|")} bulk/ (${bulk.length} files)`],
    staged: lines(git(dir, ["diff", "--cached", "--name-status"])),
    files: hashTree(dir),
  };
}
const handoffRefs = () => lines(git(REPO, ["for-each-ref", "--format=%(refname)", "refs/muse/handoff"]));
const museBranches = () => lines(git(REPO, ["for-each-ref", "--format=%(refname:short)", "refs/heads/muse"]));
const checkouts = () => lines(git(REPO, ["worktree", "list", "--porcelain"])).filter((l) => l.startsWith("worktree ")).length;
const canonical = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const sameMap = (a, b) => J(canonical(a)) === J(canonical(b));
const without = (map, keys) => Object.fromEntries(Object.entries(map).filter(([k]) => !keys.includes(k)));
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const samePath = (a, b) => a && b && real(a) === real(b);
const chflags = (flag, file) => execFileSync("chflags", [flag, file]);

/**
 * Data-loss guard: every file of `work` (path -> hash) must still exist with
 * that hash in at least one of `dirs`, or in Local's clean base.
 */
function lostWork(work, dirs) {
  const maps = dirs.filter((d) => d && existsSync(d)).map(hashTree);
  return Object.entries(work).filter(([p, h]) => !maps.some((m) => m[p] === h)).map(([p]) => p);
}

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label, root) => q('button', root).find((b) => (b.innerText || '').trim() === label) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const stored = (sid) => (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid) || null;
  const banner = () => text(document.querySelector('.error-banner span'));
  const headerPath = () => [...document.querySelectorAll('.task-metadata span[title]')].map((s) => s.getAttribute('title')).find((t) => t && t.startsWith('/')) || null;
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${J(cmd)}).map((c) => ({ args: c.args, ok: c.ok, blocked: c.blockedByHarness === true, answeredByHarness: c.answeredByHarness === true, result: c.result ? c.result.slice(0, 3000) : c.result }))`);
const parse = (t) => { try { return JSON.parse(t); } catch { return t ?? null; } };
async function nextIpc(app, cmd, before, timeoutMs = 60_000) {
  return waitFor(async () => { const calls = await ipc(app, cmd); return calls.length > before && calls.at(-1).result !== undefined ? calls.at(-1) : null; }, timeoutMs, 300);
}

async function select(app, sid) {
  await app.ev(page(`const b = row(${J(sid)})?.querySelector('button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${J(sid)};`)), 15_000, 300);
  await sleep(800);
}

async function clickAction(app, sid, label) {
  return app.ev(page(`
    const actions = row(${J(sid)})?.querySelector("button[aria-label^='Actions for']");
    if (!actions) return { clicked: false, reason: 'no actions button' };
    actions.click();
    await pause(500);
    const dialog = document.querySelector('dialog[open]');
    const all = dialog ? [...dialog.querySelectorAll('button')] : [];
    const b = all.find((n) => /^(Move to worktree|Move back to local)$/.test((n.innerText || '').trim()) && (n.innerText || '').trim() === ${J(label)})
      || all.find((n) => /^Move (to worktree|back to local)$/.test((n.innerText || '').trim()));
    if (!b) { dialog?.close?.(); return { clicked: false, reason: 'no such action', actions: all.map((n) => (n.innerText || '').trim()).filter(Boolean) }; }
    if (b.disabled) { const out = { clicked: false, reason: 'disabled', label: (b.innerText || '').trim(), title: b.title }; document.querySelector('dialog[open]')?.close?.(); return out; }
    setTimeout(() => b.click(), 0);
    return { clicked: true, label: (b.innerText || '').trim() };
  `));
}

/** The real Move action; its confirmation (plugin:dialog|message) answered `answer` by the IPC trace. */
async function moveThroughUi(app, sid, label, { answer = "Ok", expectMove = answer === "Ok", during = null } = {}) {
  const count = async (cmd) => (await ipc(app, cmd)).length;
  const before = { dialog: await count("plugin:dialog|message"), preview: await count("handoff_preview"), move: await count("handoff_move"), create: await count("git_worktree_create_for_workspace") };
  await app.ev(`(window.__baselineIpc.messageQueue = [${J(answer)}], true)`);
  const t0 = Date.now();
  const click = await clickAction(app, sid, label);
  if (!click.clicked) { await app.ev("(window.__baselineIpc.messageQueue = [], true)"); return { label, click }; }
  const out = { label, click };
  // Right after the click: `during` watches for the move in flight itself.
  if (during) out.during = await during();
  const preview = await nextIpc(app, "handoff_preview", before.preview, 30_000);
  out.preview = preview ? { target: preview.args?.target ?? null, ok: preview.ok, result: parse(preview.result) } : null;
  const moved = await nextIpc(app, "handoff_move", before.move, expectMove ? 120_000 : 4_000);
  out.move = moved ? { target: moved.args?.target ?? null, ok: moved.ok, result: parse(moved.result) } : null;
  out.moveCalls = (await count("handoff_move")) - before.move;
  out.questions = (await ipc(app, "plugin:dialog|message")).slice(before.dialog).map((c) => ({ text: String(c.args?.message ?? "").slice(0, 600), answeredByHarness: c.answeredByHarness, answer: parse(c.result) }));
  out.worktreeCreated = (await ipc(app, "git_worktree_create_for_workspace")).slice(before.create).map((c) => ({ ok: c.ok, result: parse(c.result) }));
  await waitFor(() => app.ev(page("return !q('button').some((b) => /^(Checking what will move|Creating a worktree|Moving the work|Starting Muse there)/.test((b.innerText || '').trim()));")), 60_000, 300);
  await sleep(1_000);
  out.ms = Date.now() - t0;
  out.banner = await app.ev(page("return banner();"));
  await app.ev("(window.__baselineIpc.messageQueue = [], true)");
  return out;
}

async function sessionView(app, sid) {
  return app.ev(page(`
    const s = stored(${J(sid)});
    const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
    return { active: activeSid(), sessions: (store('muse-desktop.sessions.v1', '[]') || []).length,
      stored: s ? { workspace: s.workspace, host_workspace: s.host_workspace ?? null } : null, header: headerPath(),
      logEntries: log.length, lastSystemNotes: log.filter((e) => e.role === 'system').slice(-2).map((e) => String(e.text || '').slice(0, 500)) };
  `));
}

async function pendingChoices(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${J(sid)} }).catch(() => null)`);
  const rows = Array.isArray(res?.approvals) ? res.approvals : [];
  return rows.map((r) => (r.choices ?? r.availableChoices ?? []).map((c) => ({ label: c.label ?? null, decision: c.decision?.kind ?? c.decision, scope: c.scope ?? null })));
}

/** Send through the composer, answer cards with the narrowest allow, wait for the end. `onCard` runs once while the first card waits. */
async function liveTurn(app, sid, prompt, { onCard = null } = {}) {
  const before = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).length;`));
  const sends = (await ipc(app, "send_input")).length;
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { sent: false, reason: 'no composer' };
    setValue(field, ${J(prompt)});
    await pause(300);
    const send = document.querySelector('button.send');
    if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
    send.click();
    return { sent: true };
  `));
  if (!sent.sent) throw new Error(`turn not sent: ${sent.reason}`);
  const t0 = Date.now();
  const approvals = [];
  let sawRunning = false;
  let hook = null;
  const done = await waitFor(async () => {
    const v = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
      return { running: running(${J(sid)}), cards: q('.approvals .approval').length, open: log.some((e) => e.open),
        assistant: log.slice(${before}).some((e) => e.role === 'assistant' && String(e.text || '').trim()) };
    `));
    if (v.running === "true") sawRunning = true;
    if (v.cards > 0 && onCard && hook === null) { hook = await onCard(); await select(app, sid); return null; }
    if (v.cards > 0) {
      const choices = (await pendingChoices(app, sid))[0] ?? [];
      const allow = choices.filter((c) => !/^(abort|denied|decline)/i.test(String(c.decision)));
      const pick = allow.find((c) => /once|turn/i.test(`${c.scope} ${c.label}`)) ?? allow[0];
      if (pick) {
        const clicked = await app.ev(page(`const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === ${J(pick.label)}); if (b) b.click(); return !!b;`));
        approvals.push({ choices: choices.map((c) => `${c.label} [${c.decision}${c.scope ? `/${c.scope}` : ""}]`), clicked: pick.label, ok: clicked });
        await sleep(2_000);
      }
      return null;
    }
    return (sawRunning || Date.now() - t0 > 15_000) && v.running === "false" && !v.open && v.assistant ? v : null;
  }, 300_000, 1_000);
  const call = (await ipc(app, "send_input")).slice(sends)[0] ?? null;
  const entries = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).slice(${before}).map((e) => ({ role: e.role, text: String(e.text || '').slice(0, 1500) }));`));
  return { prompt, sendInput: call ? { sessionId: call.args?.sessionId ?? null, ok: call.ok } : null, finished: Boolean(done), ms: Date.now() - t0, approvals, onCard: hook, entries };
}
const mentions = (turn, dir) => turn.entries.some((e) => (e.role === "tool" || e.role === "assistant") && [dir, real(dir), dir.replace(/^\/private\/var\//, "/var/")].some((p) => e.text.includes(p)));
const mentionsExactly = (turn, dir) => turn.entries.some((e) => e.role === "assistant" && new RegExp(`(^|\\s|\`)(/private)?${dir.replace(/^\/private/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|\`|$)`, "m").test(e.text));

function watchTree(root) {
  const events = [];
  const t0 = Date.now();
  const w = watch(root, { recursive: true }, (type, name) => {
    const p = String(name ?? "");
    if (!/^(\.git|\.muse)(\/|$)/.test(p)) events.push({ atMs: Date.now() - t0, type, path: p });
  });
  return { stop: async () => { await sleep(1_000); w.close(); return events; } };
}

// ---- run ----------------------------------------------------------------------------

const record = {
  schema: "muse-desktop.m2-05-handoff.macos.v1",
  ticket: "M2-05",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}, Apple Silicon, APFS (case-insensitive); debug build 08b291d with embedded frontend, WKWebView through the test bridge`,
  engine: null,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  liveTurns: 2,
  harness: `scripts/macos/m2-05-handoff.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  isolation: null,
  method: [
    "Two isolated instances on the same data folder and WKWebView store; the first closed from its window (a real restart).",
    "The conversation is started with the Projects panel's New conversation here (start_session, no turn), in a fresh Git repository with a local user config.",
    "The Move action is the conversation's Actions dialog; its question is the dialog plugin's message box (plugin:dialog|message on macOS), answered Cancel or Ok by the IPC trace, which records the text it asked.",
    "Both folders hashed (sha256/16 of every file, .git and .muse left out), git status --porcelain -uall and the index read outside the app before and after every step; Local watched with fs.watch (FSEvents) during the failing moves.",
    "Windows' held-open file has no macOS equivalent (unlink succeeds on an open file): the immutable flag (chflags uchg) makes Git fail where a held file did, and is cleared after.",
    "send_input is refused by the harness outside the two live turns, so no turn can start by accident.",
  ],
  phases: {},
};
const phase = (name, data) => { record.phases[name] = data; };
let inst = null;
let sid = null;
const WORK = {};
try {
  // Repository.
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "assets"), { recursive: true });
  git(REPO, ["init", "-q", "-b", "main"]);
  git(REPO, ["config", "user.name", "m2-05 proof"]);
  git(REPO, ["config", "user.email", "m2-05@localhost"]);
  git(REPO, ["config", "commit.gpgsign", "false"]);
  for (const [path, content] of Object.entries(INITIAL)) writeFileSync(join(REPO, path), content);
  writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V1);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-q", "-m", "initial"]);
  const cleanMap = side(REPO).files;

  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  let app = inst.app;
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  // The conversation in Local, no turn.
  await app.ev(page("q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)).click(); return true;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${J([REPO])}), true)`);
  await app.ev(page(`setValue(q('input[aria-label="Project name"]')[0], 'm2-05-${ID}'); button('Choose project folders').click(); await pause(800); button('+ Add project').click(); await pause(800); return true;`));
  await app.ev(page(`const r = q('li.project-item').find((li) => /m2-05-${ID}/.test(li.innerText)); r.querySelector('details').open = true; await pause(200); button('New conversation here', r).click(); return true;`));
  const started = await nextIpc(app, "start_session", 0, 60_000);
  sid = started?.ok ? parse(started.result).session_id : null;
  if (!sid) throw new Error(`no conversation: ${started?.result}`);
  await sleep(1_500);
  await select(app, sid);
  phase("setup", { start: { workspacePath: started.args?.workspacePath, ok: started.ok }, view: await sessionView(app, sid), repoClean: side(REPO).status.length === 0 });

  // ---- move: Local -> worktree 1.
  {
    const app10 = INITIAL["src/app.txt"].split("\n").filter(Boolean);
    app10[2] = "line 3 changed in Local";
    writeFileSync(join(REPO, "src/app.txt"), app10.join("\n") + "\n");
    writeFileSync(join(REPO, "staged.txt"), "staged v2\n");
    writeFileSync(join(REPO, "added.txt"), "added and staged\n");
    git(REPO, ["add", "--", "staged.txt", "added.txt"]);
    rmSync(join(REPO, "deleted.txt"), { force: true });
    writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V2);
    mkdirSync(join(REPO, "notes"), { recursive: true });
    writeFileSync(join(REPO, "notes/todo.md"), "- [ ] untracked note, only in the worktree after the move\n");
    writeFileSync(join(REPO, "assets/new.bin"), NEW_BIN);
    writeFileSync(join(REPO, "build.log"), "ignored, stays in Local\n");
    const before = { local: side(REPO), refs: handoffRefs() };
    Object.assign(WORK, without(before.local.files, Object.keys(cleanMap).filter((p) => before.local.files[p] === cleanMap[p])));
    const viewBefore = await sessionView(app, sid);
    const cancelled = await moveThroughUi(app, sid, "Move to worktree", { answer: "Cancel" });
    const afterCancel = { local: side(REPO), refs: handoffRefs(), checkouts: checkouts() };
    const action = await moveThroughUi(app, sid, "Move to worktree");
    const w1 = action.move?.result?.target ?? null;
    const after = { local: side(REPO), w1: w1 ? side(w1) : null, refs: handoffRefs() };
    const view = await sessionView(app, sid);
    const lost = lostWork(WORK, [REPO, w1]);
    phase("move", { before: { local: before.local, header: viewBefore.header }, cancelled, afterCancel: { localUnchanged: sameMap(afterCancel.local, before.local), refs: afterCancel.refs.length, checkouts: afterCancel.checkouts }, action, after, view, lost,
      verdict: {
        cancelMovesNothing: cancelled.questions?.length === 1 && cancelled.moveCalls === 0 && cancelled.worktreeCreated?.length === 0 && sameMap(afterCancel.local, before.local) && afterCancel.refs.length === before.refs.length && afterCancel.checkouts === 1,
        questionGivesCounts: /Move all the uncommitted work/.test(action.questions?.[0]?.text ?? "") && /\d/.test(action.questions?.[0]?.text ?? ""),
        counts: { tracked: action.move?.result?.tracked, untracked: action.move?.result?.untracked, ignored: action.move?.result?.ignored },
        sameSession: action.move?.result?.sameSession === true && view.active === sid && view.sessions === viewBefore.sessions,
        worktreeBytesIdentical: Boolean(after.w1) && sameMap(after.w1.files, without(before.local.files, ["build.log"])),
        localClean: after.local.status.length === 0 && sameMap(after.local.files, { ...cleanMap, "build.log": before.local.files["build.log"] }),
        ignoredStayed: after.local.files["build.log"] === before.local.files["build.log"] && !("build.log" in (after.w1?.files ?? {})),
        stagingArrivesUnstaged: (after.w1?.staged.length ?? -1) === 0 && (after.w1?.status ?? []).includes("?? added.txt"),
        snapshotRefs: after.refs.length === before.refs.length + 2,
        conversationFollows: samePath(view.stored?.workspace, w1) && samePath(view.stored?.host_workspace, REPO),
        noWorkLost: lost.length === 0,
      } });
    record.w1 = w1;
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after move"), { dataLoss: lost });
  }
  const w1 = record.w1;
  const localWork = record.phases.move.before.local.files;

  // ---- turn 1 in worktree 1 (the move refused while it runs).
  await app.ev("(window.__baselineIpc.block = [], true)");
  const turn1 = await liveTurn(app, sid,
    "M2-05 macOS proof, step 1. Use your shell tool to run pwd. Then use your file-reading tool to read notes/todo.md. Reply with two lines: the exact path pwd printed, then the first line of that file.",
    { onCard: async () => {
      const refusal = await clickAction(app, sid, "Move back to local");
      return { moveWhileTurnRuns: refusal, moveCallsSoFar: (await ipc(app, "handoff_move")).length };
    } });
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  phase("turn1", { turn: turn1, verdict: {
    finished: turn1.finished,
    sameSessionId: turn1.sendInput?.sessionId === sid,
    shellInWorktree: mentions(turn1, w1),
    fileToolReadWorktreeOnlyFile: turn1.entries.some((e) => e.role === "assistant" && /untracked note, only in the worktree/.test(e.text)),
    moveRefusedWhileTurnRuns: turn1.onCard === null ? "no card shown: not exercised" : turn1.onCard.moveWhileTurnRuns?.clicked === false,
  } });

  // ---- restart.
  await app.ev(page("q('.primary-nav button[aria-label=\"New conversation\"]')[0]?.click(); await pause(800); return true;"));
  record.stopRun1 = await inst.stop({ keepStore: true });
  inst = null;
  inst = await launch({ exe: EXE, port: PORT, data: DATA });
  app = inst.app;
  await waitFor(() => app.ev(page(`return Boolean(row(${J(sid)}));`)), 60_000, 1_000);
  await app.ev(INSTALL_IPC_TRACE);
  const storedAtBoot = await app.ev(page(`const r = stored(${J(sid)}); return r ? { workspace: r.workspace, host_workspace: r.host_workspace ?? null } : null;`));
  await select(app, sid);
  const resumed = await nextIpc(app, "resume_session", 0, 90_000);
  await sleep(2_000);
  const startsAfterRestart = (await ipc(app, "start_session")).length;
  const turn2 = await liveTurn(app, sid, "M2-05 macOS proof, step 2, after an app restart. Use your shell tool to run pwd now, then reply with only the exact path it printed.");
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const meta = parse(resumed?.result);
  phase("restart", { stopRun1: record.stopRun1, storedAtBoot, resume: resumed ? { ok: resumed.ok, workspacePath: resumed.args?.workspacePath ?? null, effectiveWorkspace: resumed.args?.effectiveWorkspace ?? null, workspace: meta?.workspace ?? null, notice: meta?.workspace_notice ?? null } : null,
    view: await sessionView(app, sid), turn: turn2, verdict: {
      closedFromWindow: record.stopRun1.quitBy === "window closed" && record.stopRun1.leftAfterQuit.length === 0,
      storedInWorktree: samePath(storedAtBoot?.workspace, w1) && samePath(storedAtBoot?.host_workspace, REPO),
      // The resume may run before the trace is installed (the app restores at boot): the same id, no new conversation, no start.
      resumedSameSession: turn2.sendInput?.sessionId === sid && turn2.sendInput?.ok === true && startsAfterRestart === 0 && (await sessionView(app, sid)).sessions === 1,
      resumedInWorktree: Boolean(samePath((await sessionView(app, sid)).stored?.workspace, w1)) && (resumed === null || resumed.ok === true),
      turnFinished: turn2.finished,
      shellInWorktree: mentions(turn2, w1),
    } });

  // ---- back: worktree 1 -> Local.
  {
    const before = { local: side(REPO), w1: side(w1), refs: handoffRefs() };
    const action = await moveThroughUi(app, sid, "Move back to local");
    const after = { local: side(REPO), w1: side(w1), refs: handoffRefs() };
    const view = await sessionView(app, sid);
    const lost = lostWork(WORK, [REPO, w1]);
    phase("back", { before, action, after, view, lost, verdict: {
      questionAsked: action.questions?.length === 1,
      moved: action.move?.ok === true && samePath(action.move?.result?.target, REPO),
      roundTripBytesIdentical: sameMap(after.local.files, localWork),
      worktreeClean: after.w1.status.length === 0 && sameMap(after.w1.files, cleanMap),
      stagingNotRestored: { before: record.phases.move.before.local.status, after: after.local.status },
      conversationHome: samePath(view.stored?.workspace, REPO),
      snapshotRefs: after.refs.length === before.refs.length + 2,
      noWorkLost: lost.length === 0,
    } });
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after back"), { dataLoss: lost });
  }

  // ---- conflict: Local -> worktree 2 (bulk + a send meanwhile), then the way back refused.
  let w2 = null;
  {
    mkdirSync(join(REPO, "bulk"), { recursive: true });
    for (let i = 0; i < 20000; i++) writeFileSync(join(REPO, "bulk", `f${i}.txt`), `bulk ${i}\n`);
    const sends = (await ipc(app, "send_input")).length;
    const out = await moveThroughUi(app, sid, "Move to worktree", { during: async () => app.ev(page(`
      // In the page, polled every 10 ms: the moment handoff_move is in flight
      // (sent, not answered), the composer is read and a send is tried.
      const inflight = () => window.__baselineIpc.calls.some((c) => c.cmd === 'handoff_move' && c.ok === undefined);
      const t0 = performance.now();
      while (!inflight() && performance.now() - t0 < 30000) await pause(10);
      const state = { moveInFlightSeen: inflight(), atMs: Math.round(performance.now() - t0) };
      const field = document.querySelector('textarea[aria-label="Message Muse"]');
      state.fieldDisabled = field ? field.disabled : null;
      state.composerReason = (document.querySelector('.composer')?.innerText || '').match(/being moved[^\\n]*/)?.[0] ?? null;
      if (field && !field.disabled) {
        setValue(field, 'sent while the move runs');
        await pause(50);
        const send = document.querySelector('button.send');
        state.sendDisabledWithText = send ? send.disabled : null;
        if (send && !send.disabled) { send.click(); state.clicked = true; }
      }
      state.moveStillInFlightAfterTry = inflight();
      return state;`)) });
    const sendCalls = (await ipc(app, "send_input")).slice(sends);
    w2 = out.move?.result?.target ?? null;
    if (!w2) throw new Error(`no second worktree: ${J(out).slice(0, 400)}`);
    rmSync(join(w2, "bulk"), { recursive: true, force: true });
    await app.ev(page("const f = document.querySelector('textarea[aria-label=\"Message Muse\"]'); if (f) setValue(f, ''); return true;"));
    const local10 = INITIAL["src/app.txt"].split("\n").filter(Boolean);
    local10[2] = "line 3 changed differently in Local, after the move";
    writeFileSync(join(REPO, "src/app.txt"), local10.join("\n") + "\n");
    const before = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
    const ui = await moveThroughUi(app, sid, "Move back to local", { answer: "Cancel", expectMove: false });
    const direct = await app.ev(`window.__TAURI_INTERNALS__.invoke('handoff_move', { sessionId: ${J(sid)}, target: ${J(REPO)} }).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String(e) }))`);
    const after = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
    const view = await sessionView(app, sid);
    git(REPO, ["checkout", "--", "src/app.txt"]);
    const lost = lostWork(without(WORK, ["src/app.txt"]), [REPO, w2]);
    phase("conflict", { setupMove: { ok: out.move?.ok, counts: out.move?.result ? { tracked: out.move.result.tracked, untracked: out.move.result.untracked } : null, during: out.during, sendInputCalls: sendCalls }, before, ui, direct, after, view, lost, verdict: {
      sendDuringMoveNotTaken: out.during?.moveInFlightSeen === true && out.during?.moveStillInFlightAfterTry === true ? sendCalls.length === 0 : "the move was not caught in flight: not exercised",
      previewConflict: J(ui.preview?.result?.conflicts) === J(["src/app.txt"]),
      refusedBeforeQuestion: (ui.questions?.length ?? 0) === 0 && ui.moveCalls === 0 && /^Nothing was moved: 1 file would conflict in Local \(src\/app\.txt\)/.test(ui.banner ?? ""),
      supervisorRefuses: direct.ok === false && /would conflict in the target: src\/app\.txt/.test(direct.error ?? ""),
      localUnchanged: sameMap(after.local, before.local),
      worktreeUnchanged: sameMap(after.w2, before.w2),
      noSnapshotRef: after.refs.length === before.refs.length,
      conversationStays: samePath(view.stored?.workspace, w2),
      noWorkLost: lost.length === 0,
    } });
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after conflict"), { dataLoss: lost });
  }

  // ---- failure: worktree 2 -> Local with an immutable Local file to rewrite.
  {
    const target = join(REPO, "src/app.txt");
    chflags("uchg", target);
    const before = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
    const viewBefore = await sessionView(app, sid);
    const watcher = watchTree(REPO);
    let action;
    let events;
    try { action = await moveThroughUi(app, sid, "Move back to local"); } finally { events = await watcher.stop(); chflags("nouchg", target); }
    const after = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
    const view = await sessionView(app, sid);
    const newRefs = after.refs.filter((r) => !before.refs.includes(r));
    const written = [...new Set(events.map((e) => e.path))].sort();
    const lost = lostWork(WORK, [REPO, w2]);
    phase("failure", { immutable: "src/app.txt (chflags uchg)", before, action, writtenPaths: written.slice(0, 40), eventCount: events.length, after, newRefs, view, lost, verdict: {
      questionAsked: action.questions?.length === 1,
      moveFailed: action.move?.ok === false,
      honestMessage: /^The conversation was not moved: .*both sides were restored as they were/.test(action.banner ?? ""),
      namesTheFile: /src\/app\.txt/.test(action.banner ?? ""),
      wroteThenUndid: written.length > 0,
      localRestored: sameMap(after.local, before.local),
      worktreeUntouched: sameMap(after.w2, before.w2),
      snapshotKept: newRefs.length === 2,
      conversationStays: samePath(view.stored?.workspace, w2) && view.logEntries === viewBefore.logEntries,
      noWorkLost: lost.length === 0,
    } });
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after failure"), { dataLoss: lost });
  }

  // ---- held: back to Local, then Local -> new worktree with an immutable untracked file.
  {
    const home = await moveThroughUi(app, sid, "Move back to local");
    const held = join(REPO, "notes/todo.md");
    const before = { local: side(REPO), refs: handoffRefs(), museBranches: museBranches(), checkouts: checkouts() };
    chflags("uchg", held);
    const watcher = watchTree(REPO);
    let action;
    let events;
    try { action = await moveThroughUi(app, sid, "Move to worktree"); } finally { events = await watcher.stop(); chflags("nouchg", held); }
    const target = action.move?.target ?? null;
    const branch = action.worktreeCreated?.[0]?.result?.branch ?? null;
    const after = { local: side(REPO), refs: handoffRefs(), museBranches: museBranches(), checkouts: checkouts(), targetExists: target ? existsSync(target) : null };
    const view = await sessionView(app, sid);
    const lost = lostWork(WORK, [REPO, target]);
    phase("held", { homeFirst: { ok: home.move?.ok, banner: home.banner }, immutable: "notes/todo.md (chflags uchg, untracked)", before: { local: before.local, refs: before.refs.length, checkouts: before.checkouts }, action, eventCount: events.length, after, view, lost, verdict: {
      homeFirst: home.move?.ok === true && sameMap(before.local.files, localWork),
      questionAsked: action.questions?.length === 1,
      worktreeMadeForTheMove: action.worktreeCreated?.length === 1 && action.worktreeCreated[0].ok === true,
      moveFailed: action.move?.ok === false,
      // With an immutable file the restore cannot delete it either: the app then keeps the worktree (it holds a copy) and says so.
      honestMessage: /^The conversation was not moved: /.test(action.banner ?? "") && /(both sides were restored as they were|both sides are kept in refs\/muse\/handoff\/)/.test(action.banner ?? ""),
      namesTheFile: /notes\/todo\.md/.test(action.banner ?? ""),
      worktreeFateAsSaid: (after.targetExists === false && /was removed with its branch/.test(action.banner ?? "") && branch !== null && !after.museBranches.includes(branch))
        || (after.targetExists === true && /was kept: it holds files that are not in its checkout/.test(action.banner ?? "")),
      worktreeOutcome: after.targetExists === false ? "removed with its branch" : "kept, as the message says",
      localByteIdentical: sameMap(after.local, before.local),
      conversationStays: samePath(view.stored?.workspace, REPO),
      noWorkLost: lost.length === 0,
    } });
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after held"), { dataLoss: lost });
  }

  // ---- case: a staged case-only rename on APFS.
  {
    git(REPO, ["mv", "README.md", "Readme.md"]);
    const before = { local: side(REPO), refs: handoffRefs().length, museBranches: museBranches(), checkouts: checkouts() };
    const watcher = watchTree(REPO);
    let ui;
    let events;
    try { ui = await moveThroughUi(app, sid, "Move to worktree"); } finally { events = await watcher.stop(); }
    const wn = ui.move?.target ?? null;
    const branch = ui.worktreeCreated?.[0]?.result?.branch ?? null;
    const after = { local: side(REPO), refs: handoffRefs().length, museBranches: museBranches(), checkouts: checkouts(), worktreeExists: wn ? existsSync(wn) : null };
    git(REPO, ["mv", "Readme.md", "README.md"]);
    const lost = lostWork(WORK, [REPO, wn]);
    phase("case", { before, ui, eventCount: events.length, after, lost, verdict: {
      outcome: ui.move?.ok === true ? "moved" : ui.move?.ok === false ? "refused at the move" : (ui.questions?.length ?? 0) === 0 ? "refused before the question" : "no move",
      refusedWithoutLoss: ui.move?.ok !== true && sameMap(after.local, before.local),
      worktreeRemovedIfMade: ui.worktreeCreated?.length === 0 || (after.worktreeExists === false && branch !== null && !after.museBranches.includes(branch)),
      noLocalFileEvent: events.length === 0,
      noWorkLost: lost.length === 0,
    } });
    if (lost.length > 0) throw Object.assign(new Error("DATA LOSS after case"), { dataLoss: lost });
  }
  record.finalLocalMatchesWork = sameMap(side(REPO).files, localWork);
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 1200);
  if (error?.dataLoss) record.dataLoss = error.dataLoss;
  if (error?.appOutput) record.appOutput = error.appOutput;
} finally {
  if (inst) {
    record.consoleErrors = inst.app.errors.slice(0, 20);
    record.stop = await inst.stop();
  }
  for (const f of [join(REPO, "src/app.txt"), join(REPO, "notes/todo.md")]) { try { chflags("nouchg", f); } catch { /* absent */ } }
}
const boolVerdicts = Object.entries(record.phases).flatMap(([name, p]) => Object.entries(p.verdict ?? {}).filter(([, v]) => typeof v === "boolean").map(([k, v]) => [`${name}.${k}`, v]));
record.verdicts = Object.fromEntries(boolVerdicts);
record.limits = [
  "Staging arrives unstaged, as the question says (same as Windows).",
  "The confirmation box and the folder dialog are answered through the IPC trace; the native NSAlert is not driven.",
  "The immutable flag stands in for Windows' held-open file: on macOS an open file does not stop Git.",
  "Engine session store and Keychain shared with the user (ADR 0003 amendment).",
];
record.passed = !record.failure && !record.dataLoss && boolVerdicts.every(([, v]) => v === true) && record.stop?.leftAfterQuit?.length === 0;
const redact = redactor([...(record.w1 ? [[record.w1, "<worktree 1>"]] : []), [REPO, "<local>"], [BASE, "<proof>"], [BASE_ARG, "<proof>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]);
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ passed: out.passed, dataLoss: out.dataLoss, failure: out.failure, verdicts: out.verdicts, nonBool: Object.fromEntries(Object.entries(out.phases).map(([n, p]) => [n, Object.fromEntries(Object.entries(p.verdict ?? {}).filter(([, v]) => typeof v !== "boolean"))])) }, null, 2));
process.exit(out.passed ? 0 : 1);
