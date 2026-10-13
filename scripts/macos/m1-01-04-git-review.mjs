#!/usr/bin/env node
/**
 * M1-01 → M1-04 on macOS: the Windows record (scripts/cdp-m1-git.mjs,
 * docs/evidence/2026-09-26-m1-closure/m1-01-04-git-native.json) replayed in
 * one isolated test instance (scripts/macos/test-instance.mjs) on the pinned
 * engine, against a scratch repository and bare remotes under --base. Every
 * repository claim is read back with the real git binary, not the UI.
 *
 *   M1-01  the last-turn snapshot lists the files changed during a controlled
 *          live turn; the office file shows git's binary marker; an 800-entry
 *          untracked folder renders with the true count; a Unicode (NFC) name
 *          is listed as git names it.
 *   M1-02  a comment on a diff line reaches the live engine (a turn whose user
 *          text carries the anchor, answered); a queued comment persists in
 *          the queue, across a page reload.
 *   M1-03  stage / unstage a file, partial hunk staging, discard after the
 *          inline confirmation, untracked files never deleted.
 *   M1-04  commit staged, push with an explicit refspec to a local bare
 *          remote, Fetch + Pull latest (--ff-only), a rejected push (a bare
 *          remote whose pre-receive hook refuses) surfaced as a clean error,
 *          and Open pull request against a local-only remote (the real gh is
 *          found and its refusal is surfaced; no GitHub host is contacted).
 *
 *   node scripts/macos/m1-01-04-git-review.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop \
 *     [--port 9431] [--base $TMPDIR/muse-proofs-g3] [--out-dir docs/evidence/2026-10-13-macos-closure]
 *
 * --out-dir writes one evidence JSON per ticket (scripts/macos/m1-01-08-evidence.mjs).
 *
 * Live turns: 2 (3 if the first turn's snapshot misses a file).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { writeEvidence } from "./m1-01-08-evidence.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9431"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g3")));
const OUT_DIR = argValue("--out-dir", null);
const ID = Date.now().toString(36);
const ROOT = join(BASE, `m1-git-${ID}`);
const REPO = join(ROOT, "repo");
const REMOTE = join(ROOT, "remote.git");
const REJECTING = join(ROOT, "rejecting.git");
const CLONE = join(ROOT, "clone");
const UNICODE_NAME = "café-ünïcode.txt".normalize("NFC");

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).replace(/[\r\n]+$/, "");
const gitAt = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=Qualif Mac", "-c", "user.email=qualif-mac@local", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const porcelain = () => git("status", "--porcelain").split("\n");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");
const write = (rel, data) => writeFileSync(join(REPO, rel), data);

// --- scratch repository (local identity, nothing global touched)
mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "master", REPO]);
git("config", "user.email", "qualif-mac@local");
git("config", "user.name", "Qualif Mac");
write("README.md", "# Scratch M1 (macOS)\n");
write("config.properties", "alpha=1\nbeta=2\n");
write("main.rs", ["fn main() {", '    println!("hello");', ...Array.from({ length: 12 }, (_, i) => `    // filler line ${i + 1}`), "}\n"].join("\n"));
write("fake.docx", Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(2048)]));
write(".gitattributes", "fake.docx -diff\n");
git("add", "-A");
git("commit", "-qm", "initial");

const record = {
  schema: "muse-desktop.m1-01-04-git-review-macos.v1",
  tickets: ["M1-01", "M1-02", "M1-03", "M1-04"],
  date: new Date().toISOString().slice(0, 10),
  liveTurns: 0,
  steps: {},
  verdict: {},
};
const step = (name, data) => { record.steps[name] = data; console.error(`- ${name}: ${JSON.stringify(data).slice(0, 260)}`); return data; };

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
const { app } = inst;
record.engine = inst.engineVersion;
record.isolation = inst.isolation;

const ev = (expr) => app.ev(expr);
const setValue = (selector, value) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
const clickButton = (text, scope = ".review-panel") => ev(`(() => {
  const root = document.querySelector(${JSON.stringify(scope)}) ?? document;
  const el = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
  if (!el) return false;
  el.click();
  return true;
})()`);
const refresh = () => ev(`(() => { const b = document.querySelector("button.review-refresh"); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
const panelText = () => ev(`document.querySelector(".review-panel")?.textContent ?? ""`);
const running = () => ev(`document.querySelector(".session-view .task-metadata .dot")?.getAttribute("data-running") === "true"`);
// The trace keeps the last 400 calls: look calls up by time, never by count.
const calls = (cmd, sinceMs = -1) => ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)} && c.atMs > ${sinceMs}).map((c) => ({ atMs: c.atMs, ok: c.ok, args: c.args, result: (c.result || "").slice(0, 1200) }))`);
const mark = () => ev("Date.now() - window.__baselineIpc.t0");
const must = async (label, probe, ms = 30_000, every = 500) => {
  const value = await waitFor(probe, ms, every);
  if (!value) throw new Error(`timeout: ${label}`);
  return value;
};
/** Refresh, let the status settle, click the action once, then poll git. */
const clickUntil = async (label, text, check, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await refresh();
    await sleep(2500);
    const clicked = await clickButton(text);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await sleep(500);
      if (check()) return { clicked };
    }
  }
  throw new Error(`timeout: ${label}`);
};
const selectFile = async (path) => {
  await ev(`(() => { const row = [...document.querySelectorAll("ul.review-files button")].find((b) => b.textContent.includes(${JSON.stringify(path)})); row?.click(); return !!row; })()`);
  await sleep(400);
  await must(`diff of ${path}`, () => ev(`(() => {
    const btn = document.querySelector("button.review-load");
    if (btn && !btn.disabled) btn.click();
    return (document.querySelector(".review-selected-file strong")?.textContent ?? "").includes(${JSON.stringify(path)});
  })()`), 25_000, 900);
};
const switchScope = async (label) => {
  await ev(`(() => { [...document.querySelectorAll(".review-diff-controls button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(); })()`);
  await sleep(600);
  await ev(`(() => { const b = document.querySelector("button.review-load"); if (b && !b.disabled) b.click(); })()`);
  await sleep(1500);
};
const turnSettled = (sid, marker) => waitFor(async () => {
  if (await running()) return false;
  const log = await transcript(app, sid);
  return log.some((e) => e.role === "assistant" && String(e.text).includes(marker));
}, 240_000, 2_000);
const sendInConversation = async (text) => {
  await ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.focus()`);
  await app.send("Input.insertText", { text });
  await must("composer took the text", () => ev(`(() => { const b = document.querySelector('button[aria-label="Send message"]'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
};
const snapshotFiles = () => ev(`[...document.querySelectorAll('[aria-label="Files changed since last turn"] li')].map((li) => li.textContent.trim())`);

try {
  // --- conversation in the scratch repository, first live turn
  step("project", { start: await newProjectConversation(app, REPO) });
  const sends0 = await mark();
  const sid = await sendFirstMessage(app, "Count slowly from 1 to 30, one number per line, then reply DONE-ONE.");
  if (!sid) throw new Error("no session started");
  record.sid = sid;
  record.liveTurns += 1;
  // the baseline is the git_status read before send_input: change files only once the turn is admitted
  await must("first send_input", async () => (await calls("send_input", sends0)).length > 0, 60_000, 200);
  const baseline1 = (await calls("git_status")).at(0);
  write("config.properties", "alpha=1\nbeta=42\nnote=changed-during-turn\n");
  write("fake.docx", Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(1024), Buffer.from([1]), Buffer.alloc(1023)]));
  write("notes.txt", "untracked notes - must never be deleted by a discard\n");
  step("files-modified-during-turn-1", { modified: ["config.properties", "fake.docx"], untracked: ["notes.txt"], baselineReadAtMs: baseline1?.atMs ?? null });
  if (!(await turnSettled(sid, "DONE-ONE"))) throw new Error("first turn never settled");

  // --- Changes panel
  await ev(`(() => { if (!document.querySelector("nav.work-tabs")) document.querySelector('button[aria-label="Show work panel"]')?.click(); })()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll("nav.work-tabs button")].find((b) => b.textContent.trim() === "Changes")?.click()`);
  await sleep(800);
  await refresh();
  await must("review status", () => ev(`(document.querySelector("ul.review-files")?.children.length ?? 0) > 0`), 30_000);
  await sleep(1500);

  // M1-01: snapshot of the controlled turn (turn 1; a second turn only if a file is missing)
  let snap = await snapshotFiles();
  let snapshotTurn = 1;
  const listsBoth = (files) => files.some((f) => f.includes("config.properties")) && files.some((f) => f.includes("notes.txt"));
  if (!listsBoth(snap)) {
    git("checkout", "--", "config.properties");
    rmSync(join(REPO, "notes.txt"), { force: true });
    const before = await mark();
    await sendInConversation("Count slowly from 1 to 20, one number per line, then reply DONE-TWO.");
    record.liveTurns += 1;
    await must("second send_input", async () => (await calls("send_input", before)).length > 0, 60_000, 200);
    write("config.properties", "alpha=1\nbeta=42\nnote=changed-during-turn\n");
    write("notes.txt", "untracked notes - must never be deleted by a discard\n");
    if (!(await turnSettled(sid, "DONE-TWO"))) throw new Error("second turn never settled");
    await refresh();
    await sleep(2500);
    snap = await snapshotFiles();
    snapshotTurn = 2;
  }
  const gitChanged = porcelain().map((l) => l.slice(3));
  step("m1-01-last-turn-snapshot", { turn: snapshotTurn, files: snap, gitPorcelainPaths: gitChanged });
  record.verdict.turnSnapshotListsChangedFiles = listsBoth(snap);

  // M1-01: office file -> git's binary marker
  await selectFile("fake.docx");
  const binary = step("m1-01-office-binary", await must("binary marker", () => ev(`(() => {
    const text = document.querySelector(".review-panel")?.textContent ?? "";
    const badge = [...document.querySelectorAll("ul.review-files li")].some((li) => li.textContent.includes("fake.docx") && !!li.querySelector(".review-binary"));
    return /binary/i.test(text) ? { diffSaysBinary: /Binary file/i.test(text), rowBadge: badge, gitNumstat: null } : null;
  })()`), 20_000, 800));
  binary.gitNumstat = git("diff", "--numstat", "--", "fake.docx");
  record.verdict.officeFilesFlaggedBinary = binary.gitNumstat.startsWith("-\t-\t") && (binary.diffSaysBinary || binary.rowBadge);

  // M1-01: 800 untracked files + a Unicode name
  mkdirSync(join(REPO, "generated"), { recursive: true });
  for (let i = 0; i < 800; i += 1) writeFileSync(join(REPO, "generated", `file-${String(i).padStart(4, "0")}.txt`), `generated ${i}\n`);
  write(UNICODE_NAME, "unicode name\n");
  await refresh();
  const large = step("m1-01-large-status", await must("800 rows", () => ev(`(() => {
    const rows = document.querySelectorAll("ul.review-files li").length;
    return rows >= 800 ? { domRows: rows, countText: document.querySelector(".review-count")?.textContent ?? "" } : null;
  })()`), 40_000, 1_000));
  // the app lists untracked files one by one (-uall); git's default folds a folder into one entry
  const gitCount = git("status", "--porcelain", "-uall").split("\n").length;
  large.gitPorcelainEntries = gitCount;
  const unicodeRow = await ev(`[...document.querySelectorAll("ul.review-files .review-file-name")].map((n) => n.textContent).find((t) => t.startsWith("caf")) ?? null`);
  step("m1-01-unicode-name", { row: unicodeRow, rowIsNfc: unicodeRow === UNICODE_NAME, gitQuotesOff: git("-c", "core.quotepath=off", "status", "--porcelain", "--", UNICODE_NAME) });
  record.verdict.largeStatusHandled = large.domRows === gitCount && large.countText.startsWith(`${gitCount} changed`);
  record.verdict.unicodeNameListed = unicodeRow === UNICODE_NAME;
  rmSync(join(REPO, "generated"), { recursive: true, force: true });
  rmSync(join(REPO, UNICODE_NAME), { force: true });
  await refresh();
  await sleep(2500);

  // --- M1-03: stage / unstage / hunk / discard / untracked protected
  await selectFile("config.properties");
  await clickUntil("stage file", "Stage file", () => porcelain().some((l) => l.startsWith("M ") && l.endsWith("config.properties")));
  step("m1-03-stage-file", { line: porcelain().find((l) => l.endsWith("config.properties")) });
  record.verdict.stageFile = true;
  await clickUntil("unstage file", "Unstage file", () => porcelain().some((l) => l.startsWith(" M") && l.endsWith("config.properties")));
  step("m1-03-unstage-file", { line: porcelain().find((l) => l.endsWith("config.properties")) });
  record.verdict.unstageFile = true;

  write("main.rs", ["fn main() {", '    println!("hunk-test change one");', ...Array.from({ length: 12 }, (_, i) => `    // filler line ${i + 1}`), "    // hunk-test change two\n}\n"].join("\n"));
  await refresh();
  await sleep(2500);
  await selectFile("main.rs");
  await clickUntil("stage main.rs", "Stage file", () => porcelain().some((l) => l.startsWith("M ") && l.endsWith("main.rs")));
  await switchScope("Staged");
  await selectFile("main.rs");
  const hunks = await ev(`[...document.querySelectorAll(".review-hunk")].map((h) => h.textContent.slice(0, 40))`);
  await ev(`(() => { const h = document.querySelectorAll(".review-hunk"); h[h.length - 1]?.click(); })()`);
  await sleep(600);
  let staged = 0;
  let unstaged = 0;
  const hunkDeadline = Date.now() + 40_000;
  while (Date.now() < hunkDeadline) {
    await clickButton("Unstage hunk");
    await sleep(2000);
    staged = (git("diff", "--cached", "--", "main.rs").match(/^@@/gm) ?? []).length;
    unstaged = (git("diff", "--", "main.rs").match(/^@@/gm) ?? []).length;
    if (staged >= 1 && unstaged >= 1) break;
  }
  step("m1-03-hunk-partial", { uiHunks: hunks.length, stagedHunks: staged, unstagedHunks: unstaged });
  record.verdict.stageByHunk = staged === 1 && unstaged === 1;

  await switchScope("Unstaged");
  await selectFile("config.properties");
  const discardDeadline = Date.now() + 45_000;
  let confirmSeen = false;
  while (Date.now() < discardDeadline && read("config.properties").includes("beta=42")) {
    await refresh();
    await sleep(1500);
    await clickButton("Discard changes…");
    await sleep(500);
    confirmSeen = confirmSeen || (await ev(`!!document.querySelector(".review-file-actions .review-confirm-label")`));
    await clickButton("Confirm discard");
    await sleep(1500);
  }
  const content = read("config.properties");
  step("m1-03-discard-file", { inlineConfirmShown: confirmSeen, content });
  record.verdict.discardFile = content === "alpha=1\nbeta=2\n" && confirmSeen;
  step("m1-03-untracked-protected", { notesTxtAlive: existsSync(join(REPO, "notes.txt")) });
  record.verdict.untrackedNeverDeleted = existsSync(join(REPO, "notes.txt"));

  // --- M1-02: a diff-line comment reaches the live engine; a queued comment persists
  write("config.properties", "alpha=1\nbeta=2\ngamma=need-clarification\n");
  await refresh();
  await sleep(2500);
  await selectFile("config.properties");
  const openForm = async () => {
    await must("comment anchors", () => ev(`[...document.querySelectorAll("button")].some((b) => (b.getAttribute("title") || "").includes("Comment on"))`), 20_000);
    for (let pass = 0; pass < 12; pass += 1) {
      await ev(`(() => { const rows = [...document.querySelectorAll("button")].filter((b) => (b.getAttribute("title") || "").includes("Comment on") && b.textContent.includes("gamma")); (rows[0] ?? null)?.click(); })()`);
      await sleep(400);
      const head = await ev(`document.querySelector(".review-comment-head strong")?.textContent ?? null`);
      if (head) return head;
    }
    return null;
  };
  const head = await openForm();
  if (!head) throw new Error("comment form never opened");
  // the anchor the prompt must carry: file, side and line of the clicked row (the gamma line, new line 3)
  const ANCHOR = /File: config\.properties[^\n]*\nSide: new line 3\nHunk: @@/;
  const BODY = "Explain this value and propose a fix in one sentence, from this message alone: do not run any command or tool, do not edit any file. End with DONE-COMMENT.";
  await setValue('textarea[aria-label="Review comment"]', BODY);
  await sleep(300);
  const sendsBefore = await mark();
  await clickButton("Send comment");
  const sentCall = await must("comment send_input", async () => (await calls("send_input", sendsBefore))[0] ?? null, 45_000, 300);
  record.liveTurns += 1;
  const sentText = String(sentCall.args?.text ?? "");
  // the comment's turn: a user entry carrying the anchor, then an assistant answer, then idle
  // The stored log may be reconciled (entries merged) while turns settle: find
  // the comment's user entry by its text in the whole log, then an answer after it.
  // The engine may still ask to run a tool (measured: a read-only git diff):
  // every approval card of this turn is declined, so nothing runs in the repo.
  const declined = [];
  const settled = await waitFor(async () => {
    const card = await ev(`(() => {
      const card = document.querySelector(".approval");
      const deny = card?.querySelector(".approval-actions button.deny");
      if (!deny) return null;
      const text = (card.querySelector(".approval-text")?.textContent ?? "").slice(0, 200);
      deny.click();
      return { text, choice: deny.textContent.trim() };
    })()`);
    if (card) { declined.push(card); return null; }
    if (await running()) return null;
    const log = await transcript(app, sid);
    const at = log.findLastIndex((e) => e.role === "user" && String(e.text).includes("DONE-COMMENT"));
    const answer = at >= 0 ? log.slice(at + 1).filter((e) => e.role === "assistant" && String(e.text).trim().length > 0).at(-1) : null;
    return answer ? { user: String(log[at].text), answer: String(answer.text) } : null;
  }, 240_000, 2_000);
  const logTail = settled ? null : (await transcript(app, sid)).slice(-8).map((e) => ({ role: e.role, kind: e.kind ?? e.type ?? null, text: String(e.text ?? "").slice(0, 120) }));
  step("m1-02-comment-sent", {
    formHead: head,
    sendInputOk: sentCall.ok,
    sentText: sentText.slice(0, 900),
    sentCarriesAnchor: ANCHOR.test(sentText) && sentText.includes(BODY),
    userEntryCarriesAnchor: Boolean(settled?.user.includes("config.properties")),
    answerExcerpt: settled?.answer.slice(0, 300) ?? null,
    approvalsDeclined: declined,
    logTailIfUnsettled: logTail,
    sentMarkerShown: await ev(`!!document.querySelector(".review-comment-sent")`),
  });
  record.verdict.commentReachesLiveEngine = Boolean(sentCall.ok && ANCHOR.test(sentText) && sentText.includes(BODY) && settled?.user.includes("config.properties"));

  await selectFile("config.properties");
  if (!(await openForm())) throw new Error("comment form never reopened");
  await setValue('textarea[aria-label="Review comment"]', "Queued: also rename this key for consistency.");
  await sleep(300);
  await clickButton("Add to queue");
  await sleep(1200);
  const queueItems = () => ev(`[...document.querySelectorAll(".review-comment-queue-item")].map((li) => ({ status: (li.className.match(/status-(\\w+)/) ?? [])[1] ?? "", body: li.querySelector(".review-comment-queue-body")?.textContent?.slice(0, 60) ?? "" }))`);
  const queueBefore = await queueItems();
  const stored = await ev(`JSON.parse(localStorage.getItem("muse-desktop.review-comments.v1." + ${JSON.stringify(sid)}) || "null")`);
  // persistence: reload the page, reopen the Changes panel and the same file
  await app.send("Page.reload", {});
  await sleep(4000);
  await must("reloaded", () => ev(`document.readyState === "complete" && !!document.querySelector(".session-view, .primary-nav")`), 60_000);
  await ev(`(() => { const row = [...document.querySelectorAll("button.session-select")].find((b) => true); if (!document.querySelector(".session-view")) row?.click(); })()`);
  await sleep(2500);
  await ev(`(() => { if (!document.querySelector("nav.work-tabs")) document.querySelector('button[aria-label="Show work panel"]')?.click(); })()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll("nav.work-tabs button")].find((b) => b.textContent.trim() === "Changes")?.click()`);
  await sleep(800);
  await refresh();
  await must("status after reload", () => ev(`(document.querySelector("ul.review-files")?.children.length ?? 0) > 0`), 30_000);
  await selectFile("config.properties");
  const queueAfter = await must("queue after reload", async () => { const q = await queueItems(); return q.length > 0 ? q : null; }, 20_000);
  step("m1-02-comment-queue", { beforeReload: queueBefore, storedStatuses: Array.isArray(stored) ? stored.map((c) => c.status) : stored, afterReload: queueAfter });
  record.verdict.commentQueuePersists = queueAfter.some((c) => c.status === "ready" && c.body.startsWith("Queued:")) && queueAfter.some((c) => c.status === "sent");
  // the IPC trace was lost with the page: re-install it for the M1-04 steps
  await ev(INSTALL_IPC_TRACE);

  // --- M1-04: commit / push / fetch / pull / rejected push / PR
  rmSync(join(REPO, "notes.txt"), { force: true });
  git("checkout", "--", "fake.docx");
  await refresh();
  await sleep(2500);
  await selectFile("config.properties");
  await clickUntil("stage config", "Stage file", () => porcelain().some((l) => l.startsWith("M ") && l.endsWith("config.properties")));
  await selectFile("main.rs");
  await clickUntil("stage main.rs", "Stage file", () => porcelain().filter((l) => l.endsWith("main.rs")).every((l) => l.startsWith("M ")));
  await setValue('input[aria-label="Commit message"]', "qualif: gamma clarifier change (macOS)");
  await sleep(300);
  await clickButton("Commit staged");
  await must("commit result", async () => (await panelText()).includes("Committed"), 25_000);
  const lastCommit = git("log", "-1", "--format=%s");
  step("m1-04-commit", { lastCommit, clean: porcelain().join("") === "" });
  record.verdict.commitStaged = lastCommit === "qualif: gamma clarifier change (macOS)";

  execFileSync("git", ["init", "-q", "--bare", "-b", "master", REMOTE]);
  git("remote", "add", "origin", REMOTE);
  await refresh();
  await sleep(2500);
  const selectRemote = (name) => ev(`(() => {
    const P = HTMLSelectElement.prototype;
    let set = 0;
    for (const label of ["Sync remote", "Push remote"]) {
      const sel = document.querySelector('select[aria-label="' + label + '"]');
      if (sel && [...sel.options].some((o) => o.value === ${JSON.stringify(name)})) {
        Object.getOwnPropertyDescriptor(P, "value").set.call(sel, ${JSON.stringify(name)});
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        set += 1;
      }
    }
    return set;
  })()`);
  step("m1-04-remote-selected", { selects: await selectRemote("origin") });
  await setValue('input[aria-label="Push branch"]', "master");
  await sleep(300);
  await clickButton("Push branch");
  await must("push result", async () => (await panelText()).includes("Pushed origin"), 30_000);
  const pushCall = (await calls("git_push")).at(-1);
  const remoteHeads = execFileSync("git", ["ls-remote", "--heads", REMOTE], { encoding: "utf8" }).trim();
  step("m1-04-push", { remoteHeads, localHead: git("rev-parse", "HEAD"), pushArgs: pushCall?.args ?? null });
  record.verdict.pushExplicitRefspec = remoteHeads === `${git("rev-parse", "HEAD")}\trefs/heads/master`;

  execFileSync("git", ["clone", "-q", REMOTE, CLONE], { stdio: "pipe" });
  writeFileSync(join(CLONE, "REMOTE.md"), "advanced remotely\n");
  gitAt(CLONE, "add", "-A");
  gitAt(CLONE, "commit", "-qm", "remote advance");
  gitAt(CLONE, "push", "-q", "origin", "HEAD:master");
  const headBefore = git("rev-parse", "HEAD");
  await clickButton("Fetch");
  const fetched = await must("fetch shows behind", async () => { const t = await panelText(); return /1 behind|behind/.test(t) && !/Fetching/.test(t) ? t.match(/\d+ ahead · \d+ behind/)?.[0] ?? "behind" : null; }, 25_000, 800);
  await setValue('input[aria-label="Pull branch"]', "master");
  await sleep(300);
  await clickButton("Pull latest");
  const headAfter = await waitFor(() => { const h = git("rev-parse", "HEAD"); return h !== headBefore ? h : null; }, 40_000, 1_000);
  const remoteMaster = execFileSync("git", ["-C", REMOTE, "rev-parse", "master"], { encoding: "utf8" }).trim();
  step("m1-04-fetch-pull", { fetchShows: fetched, headBefore: headBefore.slice(0, 8), headAfter: (headAfter ?? headBefore).slice(0, 8), remoteMaster: remoteMaster.slice(0, 8), mergeCommits: git("rev-list", "--merges", "--count", "HEAD") });
  record.verdict.pullLatestFfOnly = headAfter === remoteMaster && git("rev-list", "--merges", "--count", "HEAD") === "0";

  // rejected push: a bare remote whose pre-receive hook refuses every update
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", REJECTING]);
  writeFileSync(join(REJECTING, "hooks", "pre-receive"), "#!/bin/sh\necho 'qualif: pushes are refused by policy' >&2\nexit 1\n");
  chmodSync(join(REJECTING, "hooks", "pre-receive"), 0o755);
  git("remote", "add", "guarded", REJECTING);
  await refresh();
  await sleep(2500);
  await selectRemote("guarded");
  await setValue('input[aria-label="Push branch"]', "master");
  await sleep(300);
  await clickButton("Push branch");
  const rejection = await must("push error", () => ev(`(() => {
    const alerts = [...document.querySelectorAll(".review-panel [role=alert]")].map((a) => a.textContent.trim()).filter(Boolean);
    return alerts.length > 0 ? alerts : null;
  })()`), 30_000, 800);
  const guardedHeads = execFileSync("git", ["ls-remote", "--heads", REJECTING], { encoding: "utf8" }).trim();
  step("m1-04-rejected-push", { alerts: rejection, guardedRemoteHeads: guardedHeads, appAlive: await ev(`!!document.querySelector(".review-panel")`) });
  record.verdict.rejectedPushClean = guardedHeads === "" && rejection.some((t) => /refused by policy|pre-receive|rejected/i.test(t));

  // PR through the panel against a local-only remote: the real gh is found
  // through the adopted login PATH and refuses before any API call (no
  // GitHub remote); the refusal must surface. No PR is created anywhere.
  await selectRemote("origin");
  await setValue('input[aria-label="Push branch"]', "master");
  await setValue('input[aria-label="Pull request title"]', "Qualif PR (local remote)");
  await setValue('input[aria-label="Pull request base branch"]', "master");
  await sleep(300);
  const prsBefore = await mark();
  await clickButton("Open pull request");
  const prCall = await waitFor(async () => (await calls("git_create_pr", prsBefore)).find((c) => c.ok !== undefined) ?? null, 30_000, 500);
  await sleep(1000);
  const prAlerts = await ev(`[...document.querySelectorAll(".review-panel [role=alert]")].map((a) => a.textContent.trim()).filter(Boolean)`);
  step("m1-04-pr-local-remote", { ok: prCall?.ok ?? null, result: prCall?.result ?? null, alerts: prAlerts, link: await ev(`document.querySelector(".review-ship-link")?.href ?? null`) });
  record.verdict.prPathReachesGhAndSurfacesRefusal = prCall?.ok === false && /known GitHub host/.test(prCall?.result ?? "") && prAlerts.some((a) => /known GitHub host/.test(a));
  record.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 120));
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}

const required = ["turnSnapshotListsChangedFiles", "officeFilesFlaggedBinary", "largeStatusHandled", "stageFile", "unstageFile", "stageByHunk", "discardFile", "untrackedNeverDeleted", "commentReachesLiveEngine", "commentQueuePersists", "commitStaged", "pushExplicitRefspec", "pullLatestFfOnly", "rejectedPushClean"];
record.verdict.allWindowsCriteria = !record.failure && required.every((k) => record.verdict[k] === true);
record.passed = record.verdict.allWindowsCriteria && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd;
const redact = redactor([[realpathSync(BASE), "<g3>"], [BASE, "<g3>"], [homedir(), "~"]]);
const out = redact(record);
if (OUT_DIR) {
  const S = record.steps;
  const v = record.verdict;
  const harness = `node scripts/macos/m1-01-04-git-review.mjs --exe <exe> --port ${PORT} --base <tmp> --out-dir <dir> (scripts/macos/test-instance.mjs launch(), scripts/cdp-harness.mjs IPC trace)`;
  const shared = "One isolated instance drove the four tickets in one conversation, in a scratch repository with local identity (git config in the repo) and local bare remotes, all under the run's temp folder. The project folder was picked from the welcome screen (folder dialog answered through dialogQueue), the first message typed with Input.insertText and sent with a real Enter (Input.dispatchKeyEvent). Panel buttons were clicked in the page (element.click()), fields filled through React's value setter, as in the Windows record. Every repository claim was read back with /usr/bin/git, independently of the UI.";
  const cmp = "docs/evidence/2026-09-26-m1-closure/m1-01-04-git-native.json";
  writeEvidence({ dir: OUT_DIR, exe: EXE, base: BASE, record, harness, entries: [
    {
      file: "m1-01-git-status-diff.json", ticket: "M1-01", windowsReference: cmp,
      method: `${shared} Files were changed on disk only after send_input was traced (the baseline is the git_status read before it), while the turn ran.`,
      checks: { lastTurnSnapshot: S["m1-01-last-turn-snapshot"], officeBinary: S["m1-01-office-binary"], largeStatus: S["m1-01-large-status"], unicodeName: S["m1-01-unicode-name"] },
      verdicts: { turnSnapshotListsChangedFiles: v.turnSnapshotListsChangedFiles, officeFilesFlaggedBinary: v.officeFilesFlaggedBinary, largeStatusHandled: v.largeStatusHandled, unicodeNameListed: v.unicodeNameListed, ticketMacos: v.turnSnapshotListsChangedFiles && v.officeFilesFlaggedBinary && v.largeStatusHandled ? "☑" : "◐" },
      limits: ["The status row of the office file carries no binary badge; the marker is in the diff view ('Binary file'), as on Windows.", "The Unicode name check (NFC name listed as git names it) goes beyond the Windows record; it is not a closing criterion.", "The 800-file status is 800 untracked files plus 4 other entries: the app lists untracked files one by one (as git status -uall)."],
    },
    {
      file: "m1-02-review-comment.json", ticket: "M1-02", windowsReference: cmp,
      method: `${shared} The comment was written on the diff line of config.properties added during the run, sent with Send comment; the send_input call was read from the IPC trace and the turn's user entry and answer from the stored transcript. The queued comment's persistence was read after Page.reload.`,
      checks: { commentForm: { head: S["m1-02-comment-sent"]?.formHead }, commentSent: S["m1-02-comment-sent"], commentQueue: S["m1-02-comment-queue"] },
      verdicts: { commentReachesLiveEngine: v.commentReachesLiveEngine, commentQueuePersists: v.commentQueuePersists, ticketMacos: v.commentReachesLiveEngine && v.commentQueuePersists ? "☑" : "◐" },
      limits: ["The comment asked for an explanation and a proposed fix in words, not an edit: the criterion is the anchored comment reaching the live engine and being answered. Any tool approval the engine requested during that turn was declined by the harness (approvalsDeclined), so nothing ran in the repository; a previous run without that guard showed the engine asking to run a read-only git diff on the comment.", "The prompt names the file as 'config.properties (renamed from config.properties)' for an unrenamed file (oldPath always set): cosmetic, not macOS-specific, logged for the backlog."],
    },
    {
      file: "m1-03-stage-discard.json", ticket: "M1-03", windowsReference: cmp,
      method: `${shared} Each action was clicked once per pass after a Refresh, then git status/diff were polled.`,
      checks: { stageFile: S["m1-03-stage-file"], unstageFile: S["m1-03-unstage-file"], hunkPartial: S["m1-03-hunk-partial"], discardFile: S["m1-03-discard-file"], untrackedProtected: S["m1-03-untracked-protected"] },
      verdicts: { stageFile: v.stageFile, unstageFile: v.unstageFile, stageByHunk: v.stageByHunk, discardFile: v.discardFile, untrackedNeverDeleted: v.untrackedNeverDeleted, ticketMacos: v.stageFile && v.unstageFile && v.stageByHunk && v.discardFile && v.untrackedNeverDeleted ? "☑" : "◐" },
      limits: ["The stale-hunk refusal (file changed between two clicks) is covered by the Rust tests, not replayed here, as in the Windows record."],
    },
    {
      file: "m1-04-sync-commit-push.json", ticket: "M1-04", windowsReference: `${cmp}; docs/evidence/2026-09-26-m1-closure/m1-04-pr-roundtrip.json`,
      method: `${shared} The rejected push used a second local bare remote whose pre-receive hook exits 1 (no network). Open pull request was clicked with the local origin: the app ran the user's real gh, found through the login-shell PATH the app adopts on macOS (src-tauri/src/login_env.rs); gh refuses before any API call because no remote points to a GitHub host. No PR was created anywhere.`,
      checks: { commit: S["m1-04-commit"], push: S["m1-04-push"], fetchPull: S["m1-04-fetch-pull"], rejectedPush: S["m1-04-rejected-push"], prAgainstLocalRemote: S["m1-04-pr-local-remote"] },
      verdicts: { commitStaged: v.commitStaged, pushExplicitRefspec: v.pushExplicitRefspec, pullLatestFfOnly: v.pullLatestFfOnly, rejectedPushClean: v.rejectedPushClean, prPathReachesGhAndSurfacesRefusal: v.prPathReachesGhAndSurfacesRefusal, remotePrRoundTrip: "not run (no external effect allowed)", ticketMacos: "◐" },
      limits: ["The live PR round trip (open a PR on GitHub through the form, gh confirms it, a second click reports 'Existing pull request') was proved on Windows on a disposable GitHub repo; it is not replayed on macOS because the run may not reach GitHub. It needs a disposable repo and Étienne's go-ahead. Until then M1-04 stays ◐ on macOS for that criterion only.", "The Windows record's forbidden remote was a GitHub URL; here a local hook rejection stands in for it."],
    },
  ] });
}
console.log(JSON.stringify(out, null, 2));
process.exit(record.passed ? 0 : 1);
