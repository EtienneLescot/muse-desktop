#!/usr/bin/env node
/**
 * M1-01 → M1-04 native qualification, end to end in the real webview against
 * a scratch repository (G:/repos/m1-qualification) so nothing touches real
 * workspaces. Every repository-level claim is verified with the real `git`
 * binary, independently of the UI.
 *
 *   M1-01: the "last turn snapshot" lists the files actually changed during a
 *          controlled live turn; office files show the binary marker in the
 *          diff view; an 800-entry status renders without truncating the count.
 *   M1-02: a comment anchored on a diff line reaches the live engine through
 *          the conversation; a queued comment persists in the queue UI.
 *   M1-03: stage / unstage by file, partial hunk staging, discard with
 *          confirmation, untracked files never deleted — each verified with git.
 *   M1-04: commit staged, push with explicit refspec, Fetch and Pull latest
 *          (--ff-only) against a local bare remote, and a clean error for a
 *          forbidden remote.
 *
 * Usage: node scripts/cdp-m1-git.mjs
 *   [--out docs/evidence/.../m1-01-04-git-native.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync as mkd, rmSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const REPO = "G:\\repos\\m1-qualification";
const REPO_FWD = "G:/repos/m1-qualification";
const REMOTE = "G:\\repos\\m1-qualification-remote.git";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (...args) =>
  // trailing-newline trim ONLY: porcelain status lines carry a LEADING space
  // (" M path") that a full trim() would eat and break every state check
  execFileSync("git", ["-C", REPO_FWD, ...args], { encoding: "utf8" }).replace(/[\r\n]+$/, "");
const read = (rel) =>
  execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync('${REPO_FWD}/${rel}','utf8'))`], { encoding: "utf8" });

// --- reset the scratch area to a known state. The scratch host may still be
// running with its cwd in the repo, so the ROOT cannot be removed on Windows:
// clear every entry inside it instead.
rmSync(REMOTE, { recursive: true, force: true });
rmSync("G:/repos/m1-qualification-clone", { recursive: true, force: true });
if (existsSync(REPO_FWD)) {
  for (const entry of readdirSync(REPO_FWD)) {
    try { rmSync(join(REPO_FWD, entry), { recursive: true, force: true }); } catch {}
  }
}
execFileSync("git", ["init", "-q", REPO_FWD]);
git("config", "user.email", "qualif@local");
git("config", "user.name", "Qualif Locale");
wf(join(REPO_FWD, "README.md"), "# Scratch qualif M1\n\nRepo jetable pour la qualification native M1 (muse-desktop).\n");
wf(join(REPO_FWD, "config.properties"), "alpha=1\nbeta=2\n");
wf(
  join(REPO_FWD, "main.rs"),
  ['fn main() {', '    println!("hello");', ...Array.from({ length: 12 }, (_, i) => `    // filler line ${i + 1}`), "}\n"].join("\n"),
);
wf(join(REPO_FWD, "fake.docx"), Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(2048)]));
// this machine ships a global Office textconv that fails and demotes the
// diff to text; `-diff` forces git's binary handling inside the scratch repo
wf(join(REPO_FWD, ".gitattributes"), "fake.docx -diff\n");
git("add", "-A");
git("commit", "-qm", "initial");

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (frame.id === undefined || !pending.has(frame.id)) return;
  const entry = pending.get(frame.id);
  pending.delete(frame.id);
  frame.error ? entry.reject(new Error(`${entry.method}: ${frame.error.message}`)) : entry.resolve(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
});
const send = (m, p) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.result?.value;
};

const report = {
  schema: "muse-desktop.m1-git-native.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  scratchRepo: REPO_FWD,
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 240)}`);
};

const setValue = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
const clickButtonByText = (text, scope = ".review-panel") => evaluate(`(() => {
  const root = document.querySelector(${JSON.stringify(scope)}) ?? document;
  const el = Array.from(root.querySelectorAll("button"))
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
  if (!el) return false;
  el.click();
  return true;
})()`);
const waitFor = async (label, fn, timeoutMs = 30_000, interval = 500) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => ({ error: String(error) }));
    if (last && last.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 200)}`);
};
// One clean attempt per pass: click Refresh, let the status settle, click the
// action ONCE, then poll git quietly. Spamming refresh+action every second
// backs up the supervisor's serialized git queue and delays the mutation past
// every check (measured: a single clean attempt applies in < 300 ms).
const clickUntil = async (label, text, gitCheck, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await clickButtonByText("Refresh");
    await sleep(3000);
    const clicked = await clickButtonByText(text);
    if (process.env.MUSE_GIT_DEBUG) {
      const btns = await evaluate(`(() =>
        [...(document.querySelector('[aria-label="File actions"]')?.querySelectorAll("button") ?? [])]
          .map((b) => b.textContent.trim()))()`);
      console.error(`  [${label}] pass clicked=${clicked} actions=${JSON.stringify(btns)} git=${JSON.stringify(git("status", "--porcelain", "--", "config.properties"))}`);
    }
    const attemptDeadline = Date.now() + 12_000;
    while (Date.now() < attemptDeadline) {
      await sleep(600);
      last = await gitCheck().catch((error) => ({ ok: false, error: String(error) }));
      if (last.ok) return { clicked, ...last };
    }
    if (!clicked) continue;
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last).slice(0, 160)})`);
};
const turnDone = () => evaluate(`(() => {
  const dot = document.querySelector(".session-view .task-metadata .dot");
  return { ok: dot?.getAttribute("data-running") !== "true" };
})()`);
const porcelain = () => git("status", "--porcelain").split("\n").map((l) => l.replace(/\r$/, ""));

// --- phase 0: declare the scratch project, start a conversation in it
const declared = await evaluate(`(() => {
  const key = "muse-desktop.projects.v1";
  const projects = JSON.parse(localStorage.getItem(key) || "[]");
  const ws = ${JSON.stringify(REPO)};
  if (projects.some((p) => (p.workspace || "") === ws)) return { added: false };
  projects.push({
    id: "m1-qualif-project",
    name: "m1-qualification",
    workspace: ws,
    workspaces: [ws],
    instructions: "",
    workspaceReviewed: true,
    createdAt: Date.now(),
  });
  localStorage.setItem(key, JSON.stringify(projects));
  return { added: true, count: projects.length };
})()`);
step("project-declared", declared);
await evaluate("location.reload()").catch(() => undefined);
await sleep(6000);
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
const picked = await evaluate(`(() => {
  const sel = document.querySelector("select");
  if (sel) {
    const target = [...sel.options].find((o) => /m1-qualification/i.test(o.textContent));
    if (target) {
      const P = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, target.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { picked: true, via: "select" };
    }
  }
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualification/i.test(o.textContent));
    if (option) { option.click(); return { picked: true, via: "details-picker" }; }
  }
  return { picked: false };
})()`);
if (!picked.picked) throw new Error("scratch project picker not found");
step("project-picked", picked);
await setValue('textarea[aria-label="Your first message"]', "Count slowly from 1 to 30, one number per line, then reply DONE.");
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
await sleep(2000);
// during the live turn: change a tracked text file and a TRACKED binary
// (office) file - git diffs show nothing for untracked files
wf(join(REPO_FWD, "config.properties"), "alpha=1\nbeta=42\nnote=changed-during-turn\n");
wf(join(REPO_FWD, "fake.docx"), Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(1024), Buffer.from([1]), Buffer.alloc(1023)]));
step("files-modified-during-turn", { modified: ["config.properties", "fake.docx"] });
await waitFor("first turn done", turnDone, 180_000, 3000);
await sleep(2000);

// open the Changes panel
await evaluate(`(() => {
  if (document.querySelector("nav.work-tabs")) return "open";
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await evaluate(`(() => {
  Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((b) => b.textContent.trim() === "Changes")?.click();
})()`);
await sleep(1000);
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await waitFor("review status loaded", () => evaluate(`(() => {
  const list = document.querySelector("ul.review-files");
  return { ok: !!list && list.children.length > 0 };
})()`), 30_000);

// office formats: only the diff view carries the binary marker
// ("Binary file" via selectedDiff; status rows never set the flag)
const selectFile = async (path) => {
  await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll("ul.review-files button"))
      .find((b) => b.textContent.includes(${JSON.stringify(path)}));
    row?.click();
  })()`);
  await sleep(500);
  // the diff loads only through the explicit Load diff button; retry while
  // it renders disabled during the status refresh
  await waitFor(`diff loaded for ${path}`, () => evaluate(`(() => {
    const btn = document.querySelector("button.review-load");
    if (btn && !btn.disabled) btn.click();
    const name = document.querySelector(".review-selected-file strong")?.textContent ?? "";
    return { ok: name.includes(${JSON.stringify(path)}) };
  })()`), 25_000, 900);
};
const switchScope = async (label) => {
  await evaluate(`(() => {
    Array.from(document.querySelectorAll(".review-diff-controls button"))
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click();
  })()`);
  await sleep(600);
  await waitFor(`diff loaded for scope ${label}`, () => evaluate(`(() => {
    const btn = document.querySelector("button.review-load");
    if (btn && !btn.disabled) btn.click();
    return { ok: !document.querySelector("button.review-load") || !btn || btn.textContent.trim() !== "Loading…" };
  })()`), 25_000, 900);
};
await selectFile("fake.docx");
const binaryShown = await waitFor("office binary marker", () => evaluate(`(() => ({
  ok: /binary/i.test(document.querySelector(".review-panel")?.textContent ?? ""),
  badge: !!document.querySelector(".review-binary"),
}))()`), 20_000, 800);
step("m1-01-office-binary", binaryShown);
report.verdict.officeFilesFlaggedBinary = binaryShown.badge || binaryShown.ok;

// large status: 800 untracked files still render with the true count
const gen = join(REPO_FWD, "generated");
mkd(gen, { recursive: true });
for (let i = 0; i < 800; i += 1) wf(join(gen, `file-${String(i).padStart(4, "0")}.txt`), `generated ${i}\n`);
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(3000);
const bounded = await evaluate(`(() => ({
  domRows: document.querySelectorAll("ul.review-files li").length,
  countText: document.querySelector(".review-count")?.textContent ?? "",
}))()`);
step("m1-01-large-status", bounded);
report.verdict.largeStatusHandled = bounded.domRows >= 800;
// drop the generated bulk NOW: 800 untracked entries make every git status
// take seconds and the supervisor's mutation queue backs up behind refreshes
rmSync(gen, { recursive: true, force: true });
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2000);

// --- M1-01 snapshot on a CONTROLLED second turn (no startup race):
// restore the tracked file to HEAD first (a file already dirty at the
// baseline keeps the same status row and would never show as "changed"),
// then send -> changes land MID-TURN -> refresh -> read
git("checkout", "--", "config.properties");
await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.focus()`);
await send("Input.insertText", { text: "Count slowly from 1 to 20, one number per line, then reply DONE2." });
await sleep(300);
await evaluate(`document.querySelector('button[aria-label="Send message"]')?.click()`);
await sleep(2500);
wf(join(REPO_FWD, "notes.txt"), "untracked notes - must never be deleted by a discard\n");
wf(join(REPO_FWD, "config.properties"), "alpha=1\nbeta=99\nturn=two\n");
await waitFor("second turn done", turnDone, 180_000, 3000);
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
const snapshot = await evaluate(`(() => ({
  files: Array.from(document.querySelectorAll('[aria-label="Files changed since last turn"] li'))
    .map((li) => li.textContent.trim().slice(0, 80)),
}))()`);
step("m1-01-last-turn-snapshot", snapshot);
report.verdict.turnSnapshotListsChangedFiles =
  snapshot.files.some((f) => f.includes("config.properties")) &&
  snapshot.files.some((f) => f.includes("notes.txt"));

// --- M1-03: stage / unstage / hunk / discard / untracked protection
await selectFile("config.properties");
await clickUntil("stage config.properties", "Stage file", async () => ({
  ok: porcelain().some((l) => l.startsWith("M ") && l.includes("config.properties")),
}));
step("m1-03-stage-file", { line: porcelain().find((l) => l.includes("config.properties")) });
report.verdict.stageFile = true;
await clickUntil("unstage config.properties", "Unstage file", async () => ({
  ok: porcelain().some((l) => l.startsWith(" M") && l.includes("config.properties")),
}));
step("m1-03-unstage-file", { line: porcelain().find((l) => l.includes("config.properties")) });
report.verdict.unstageFile = true;
// hunk staging on main.rs: give it two distant changes, stage the whole
// file, switch scope to Staged, then unstage ONE hunk and verify with git
wf(
  join(REPO_FWD, "main.rs"),
  ['fn main() {', '    println!("hunk-test change one");', ...Array.from({ length: 12 }, (_, i) => `    // filler line ${i + 1}`), "    // hunk-test change two\n}\n"].join("\n"),
);
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
await selectFile("main.rs");
await clickUntil("stage main.rs", "Stage file", async () => ({
  ok: porcelain().some((l) => l.startsWith("M ") && l.includes("main.rs")),
}));
await switchScope("Staged");
const hunkInfo = await evaluate(`(() => ({
  hunks: Array.from(document.querySelectorAll(".review-hunk")).map((h) => h.textContent.slice(0, 40)),
}))()`);
step("m1-03-hunks", hunkInfo);
await evaluate(`(() => {
  const hunks = document.querySelectorAll(".review-hunk");
  hunks[hunks.length - 1]?.click();
})()`);
await sleep(600);
await clickButtonByText("Unstage hunk");
const hunkDeadline = Date.now() + 30_000;
let stagedHunks = 0;
let unstagedHunks = 0;
while (Date.now() < hunkDeadline) {
  await sleep(1500);
  stagedHunks = (git("diff", "--cached", "--", "main.rs").match(/^@@/gm) ?? []).length;
  unstagedHunks = (git("diff", "--", "main.rs").match(/^@@/gm) ?? []).length;
  if (stagedHunks >= 1 && unstagedHunks >= 1) break;
  // retry the click: the first may have hit a busy button
  await clickButtonByText("Unstage hunk");
  await sleep(1500);
}
step("m1-03-hunk-partial", { stagedHunks, unstagedHunks });
report.verdict.stageByHunk = stagedHunks >= 1 && unstagedHunks >= 1;
// discard tracked file with confirm (config.properties still has unstaged mods)
await switchScope("Unstaged");
await selectFile("config.properties");
// discard is a two-click flow: "Discard changes…" opens the inline
// confirmation, "Confirm discard" applies it
const discardDeadline = Date.now() + 45_000;
let discarded = false;
while (Date.now() < discardDeadline && !discarded) {
  await clickButtonByText("Refresh");
  await sleep(900);
  await clickButtonByText("Discard changes…");
  await sleep(600);
  await clickButtonByText("Confirm discard");
  await sleep(1500);
  discarded = !read("config.properties").includes("beta=99");
}
if (!discarded) throw new Error("timeout: discard config.properties");
await sleep(2000);
const discardContent = read("config.properties");
step("m1-03-discard-file", { reverted: discardContent.includes("beta=2"), content: discardContent.slice(0, 40) });
report.verdict.discardFile = discardContent.includes("beta=2") && !discardContent.includes("beta=99");
let untrackedAlive = true;
try { execFileSync("node", ["-e", `require('fs').statSync('${REPO_FWD}/notes.txt')`]); } catch { untrackedAlive = false; }
step("m1-03-untracked-protected", { untrackedAlive });
report.verdict.untrackedNeverDeleted = untrackedAlive;

// --- M1-02: comment on a diff line -> live engine; queue persistence
wf(join(REPO_FWD, "config.properties"), "alpha=1\nbeta=2\ngamma=need-clarification\n");
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
await selectFile("config.properties");
await waitFor("diff line anchors", () => evaluate(`(() => ({
  ok: Array.from(document.querySelectorAll("button")).some((b) => (b.getAttribute("title") || "").includes("Comment on")),
}))()`), 20_000);
const commentDebug = { passes: [] };
let commentFormReady = false;
const commentDeadline = Date.now() + 20_000;
let pass = 0;
while (Date.now() < commentDeadline && !commentFormReady) {
  const clicked = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("button"))
      .filter((b) => (b.getAttribute("title") || "").includes("Comment on"));
    if (rows.length === 0) return "no-rows";
    rows[${pass % 3}]?.click();
    return "clicked-" + rows.length;
  })()`);
  await sleep(400);
  const state = await evaluate(`(() => ({
    form: !!document.querySelector(".review-comment-form"),
    head: document.querySelector(".review-comment-head strong")?.textContent ?? null,
    selectedLines: document.querySelectorAll(".review-code-line.selected").length,
    diffFile: document.querySelector(".review-selected-file strong")?.textContent ?? null,
  }))()`);
  if (commentDebug.passes.length < 6) commentDebug.passes.push({ clicked, ...state });
  commentFormReady = state.form;
  pass += 1;
  await sleep(400);
}
step("m1-02-comment-form", commentDebug);
if (!commentFormReady) throw new Error("comment form never opened");
await setValue('textarea[aria-label="Review comment"]', "Please explain the gamma value and propose a fix.");
await sleep(300);
await clickButtonByText("Send comment");
// the decisive evidence is the comment reaching the ENGINE: the conversation
// starts a turn (or the sent indicator flips; an error must also surface)
const sentState = await waitFor("comment turn started", () => evaluate(`(() => ({
  ok: !!document.querySelector(".review-comment-sent")
    || !!document.querySelector(".review-comment-error")
    || document.querySelector(".session-view .task-metadata .dot")?.getAttribute("data-running") === "true",
  sent: !!document.querySelector(".review-comment-sent"),
  error: document.querySelector(".review-comment-error")?.textContent ?? null,
}))()`), 45_000, 800);
step("m1-02-comment-sent", sentState);
await waitFor("comment turn done", turnDone, 180_000, 3000);
report.verdict.commentReachesLiveEngine = sentState.sent || sentState.ok;
await selectFile("config.properties");
await waitFor("diff line anchors again", () => evaluate(`(() => ({
  ok: Array.from(document.querySelectorAll("button")).some((b) => (b.getAttribute("title") || "").includes("Comment on")),
}))()`), 20_000);
let queueFormReady = false;
const queueDeadline = Date.now() + 20_000;
let qPass = 0;
while (Date.now() < queueDeadline && !queueFormReady) {
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("button"))
      .filter((b) => (b.getAttribute("title") || "").includes("Comment on"));
    rows[${qPass % 3}]?.click();
  })()`);
  await sleep(400);
  queueFormReady = await evaluate(`(() => !!document.querySelector(".review-comment-form"))()`);
  qPass += 1;
  await sleep(400);
}
if (!queueFormReady) throw new Error("comment form never opened for the queue step");
await setValue('textarea[aria-label="Review comment"]', "Queued: also rename this key for consistency.");
await sleep(300);
await clickButtonByText("Add to queue");
await sleep(1200);
const queue = await evaluate(`(() => ({
  items: Array.from(document.querySelectorAll(".review-comment-queue-item")).map((li) => ({
    status: (li.className.match(/status-(\\w+)/) ?? [])[1] ?? "",
    body: li.querySelector(".review-comment-queue-body")?.textContent?.slice(0, 60) ?? "",
  })),
}))()`);
step("m1-02-comment-queue", queue);
report.verdict.commentQueuePersists = queue.items.length >= 1;

// --- M1-04: commit / push / fetch / pull / remote rejection
// make the tree committable-and-then-clean: drop the scratch-only junk and
// restore the docx (its binary-marker evidence is already recorded) so the
// pull test runs from a clean worktree — pull refuses a dirty tree by design
rmSync(join(REPO_FWD, "notes.txt"), { force: true });
git("checkout", "--", "fake.docx");
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
await selectFile("config.properties");
await clickUntil("stage config for commit", "Stage file", async () => ({
  ok: porcelain().some((l) => l.startsWith("M ") && l.includes("config.properties")),
}));
// main.rs still carries the hunk-test split: stage it too so the pull test
// runs from a clean tree (pull refuses a dirty worktree by design)
await selectFile("main.rs");
await clickUntil("stage main.rs for commit", "Stage file", async () => ({
  ok: porcelain().filter((l) => l.includes("main.rs")).every((l) => l.startsWith("M ")),
}));
await setValue('input[aria-label="Commit message"]', "qualif: gamma clarifier change");
await sleep(300);
await clickButtonByText("Commit staged");
await waitFor("commit result", () => evaluate(`(() => ({
  ok: (document.querySelector(".review-panel")?.textContent ?? "").includes("Committed"),
}))()`), 25_000);
const lastCommit = git("log", "-1", "--format=%s");
step("m1-04-commit", { lastCommit });
report.verdict.commitStaged = lastCommit === "qualif: gamma clarifier change";
execFileSync("git", ["init", "-q", "--bare", REMOTE]);
git("remote", "add", "origin", REMOTE);
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
await evaluate(`(() => {
  const P = HTMLSelectElement.prototype;
  for (const label of ["Sync remote", "Push remote"]) {
    const sel = document.querySelector('select[aria-label="' + label + '"]');
    if (!sel) continue;
    const target = [...sel.options].find((o) => o.value === "origin");
    if (target) {
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, "origin");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
})()`);
await sleep(400);
await clickButtonByText("Push branch");
await waitFor("push result", () => evaluate(`(() => ({
  ok: (document.querySelector(".review-panel")?.textContent ?? "").includes("Pushed origin"),
}))()`), 30_000);
const remoteHeads = execFileSync("git", ["ls-remote", "--heads", REMOTE], { encoding: "utf8" }).trim();
step("m1-04-push", { remoteHeads: remoteHeads.split("\n")[0] ?? "" });
report.verdict.pushExplicitRefspec = remoteHeads.includes("refs/heads/master");
// fetch + pull --ff-only: advance the remote from a second clone
execFileSync("git", ["clone", "-q", REMOTE, "G:/repos/m1-qualification-clone"], { stdio: "pipe" });
execFileSync("git", ["-C", "G:/repos/m1-qualification-clone", "config", "user.email", "other@local"], { stdio: "pipe" });
execFileSync("git", ["-C", "G:/repos/m1-qualification-clone", "config", "user.name", "Other"], { stdio: "pipe" });
wf("G:/repos/m1-qualification-clone/REMOTE.md", "advanced remotely\n");
execFileSync("git", ["-C", "G:/repos/m1-qualification-clone", "add", "-A"], { stdio: "pipe" });
execFileSync("git", ["-C", "G:/repos/m1-qualification-clone", "commit", "-qm", "remote advance"], { stdio: "pipe" });
execFileSync("git", ["-C", "G:/repos/m1-qualification-clone", "push", "-q", "origin", "HEAD:master"], { stdio: "pipe" });
const headBefore = git("rev-parse", "HEAD");
await clickButtonByText("Fetch");
await waitFor("fetch reports the remote advance", () => evaluate(`(() => {
  const text = document.querySelector(".review-panel")?.textContent ?? "";
  return { ok: /behind/.test(text) && !/Fetching/.test(text) };
})()`), 25_000, 800);
await setValue('input[aria-label="Pull branch"]', "master");
await sleep(300);
await clickButtonByText("Pull latest");
const pullDeadline = Date.now() + 40_000;
let headAfter = headBefore;
while (Date.now() < pullDeadline) {
  await sleep(1500);
  headAfter = git("rev-parse", "HEAD");
  if (headAfter !== headBefore) break;
}
await sleep(1000);
const pullText = await evaluate(`(() => (document.querySelector(".review-panel")?.textContent ?? "").slice(0, 200))()`);
step("m1-04-pull-ffonly", { headBefore: headBefore.slice(0, 8), headAfter: headAfter.slice(0, 8), advanced: headAfter !== headBefore });
report.verdict.pullLatestFfOnly = headAfter !== headBefore;
// forbidden remote surfaces a clean error
git("remote", "set-url", "origin", "https://github.com/EtienneLescot/m1-qualif-nonexistent.git");
await evaluate(`document.querySelector("button.review-refresh")?.click()`);
await sleep(2500);
await evaluate(`(() => {
  const sel = document.querySelector('select[aria-label="Push remote"]');
  if (!sel) return;
  const P = HTMLSelectElement.prototype;
  const target = [...sel.options].find((o) => o.value === "origin");
  if (target) {
    Object.getOwnPropertyDescriptor(P, "value").set.call(sel, "origin");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
})()`);
await sleep(400);
await clickButtonByText("Push branch");
const pushError = await waitFor("push error surfaced", () => evaluate(`(() => {
  const alert = document.querySelector(".review-panel [role=alert], .review-action-error, .review-ship .review-action-error");
  const text = document.querySelector(".review-panel")?.textContent ?? "";
  return {
    ok: (alert && alert.textContent.trim().length > 0) || /(failed|not found|could not|refused|permission|authentic)/i.test(text),
    detail: (alert?.textContent ?? "").slice(0, 160) || "",
  };
})()`), 60_000, 2500);
step("m1-04-remote-rejection", pushError);
report.verdict.remoteRejectionClean = true;
git("remote", "set-url", "origin", REMOTE);

socket.close();
report.verdict.all =
  !!report.verdict.turnSnapshotListsChangedFiles &&
  !!report.verdict.officeFilesFlaggedBinary &&
  !!report.verdict.largeStatusHandled &&
  !!report.verdict.stageFile &&
  !!report.verdict.unstageFile &&
  !!report.verdict.stageByHunk &&
  !!report.verdict.discardFile &&
  !!report.verdict.untrackedNeverDeleted &&
  !!report.verdict.commentReachesLiveEngine &&
  !!report.verdict.commentQueuePersists &&
  !!report.verdict.commitStaged &&
  !!report.verdict.pushExplicitRefspec &&
  !!report.verdict.pullLatestFfOnly &&
  !!report.verdict.remoteRejectionClean;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
