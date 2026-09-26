#!/usr/bin/env node
/**
 * M2-03 in-app replay (the 25/09 fix's outstanding acceptance piece):
 * "Create & open" must start the conversation INSIDE the fresh worktree —
 * the panel's workspace path shows `.muse\worktrees\…` and git announces a
 * `muse/…` branch — with a live turn running there.
 *
 * Usage: node scripts/cdp-m2-03-worktree.mjs
 *   [--out docs/evidence/2026-09-26-m2-closure/m2-03-worktree-create-open.json]
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (...args) =>
  execFileSync("git", ["-C", REPO_FWD, ...args], { encoding: "utf8" }).replace(/[\r\n]+$/, "");

// reset the scratch repo to a known committed state
if (existsSync(REPO_FWD)) {
  for (const entry of readdirSync(REPO_FWD)) {
    try { rmSync(join(REPO_FWD, entry), { recursive: true, force: true }); } catch {}
  }
}
execFileSync("git", ["init", "-q", REPO_FWD]);
git("config", "user.email", "qualif@local");
git("config", "user.name", "Qualif Locale");
wf(join(REPO_FWD, "README.md"), "# Scratch qualif M2\n\nWorktree create & open qualification.\n");
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
  schema: "muse-desktop.m2-03-worktree-create-open.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 240)}`);
};

// welcome flow: pick the m1-qualification project, check Worktree, start
await sleep(2000);
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
const picked = await evaluate(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualification/i.test(o.textContent));
    if (option) { option.click(); return { picked: true, via: "details-picker" }; }
  }
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
  return { picked: false };
})()`);
if (!picked.picked) throw new Error("scratch project picker not found");
step("project-picked", picked);
await evaluate(`(() => {
  const box = document.querySelector("label.welcome-worktree input");
  if (box && !box.checked) box.click();
  return box ? box.checked : null;
})()`);
const checked = await evaluate(`(() => document.querySelector("label.welcome-worktree input")?.checked ?? false)()`);
step("worktree-checked", { checked });
if (!checked) throw new Error("worktree switch did not engage");
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Your first message"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "Reply with just the word TREEOK and nothing else.");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
// the worktree creation + host spawn + first turn take a while
const startDeadline = Date.now() + 90_000;
let workspaceShown = "";
while (Date.now() < startDeadline) {
  await sleep(3000);
  workspaceShown = await evaluate(`(() => {
    const span = document.querySelector('.task-metadata span[title*="worktrees"]');
    return span?.getAttribute("title") ?? "";
  })()`);
  if (workspaceShown) break;
}
step("workspace-path", { workspaceShown });
report.verdict.conversationStartedInWorktree =
  /worktrees/.test(workspaceShown) && /m1-qualification/.test(workspaceShown);
// wait for the turn to settle
const doneDeadline = Date.now() + 180_000;
let done = false;
while (Date.now() < doneDeadline) {
  await sleep(4000);
  done = await evaluate(`(() => {
    const dot = document.querySelector(".session-view .task-metadata .dot");
    return dot?.getAttribute("data-running") !== "true";
  })()`);
  const tail = await evaluate(`(() => (document.querySelector(".session-center")?.innerText ?? "").slice(-100))()`);
  if (done && /TREEOK/.test(tail)) break;
}
step("first-turn-done", { done });
// git acceptance: the worktree's branch is muse/…
const worktreePath = workspaceShown;
let branchInWorktree = null;
if (worktreePath) {
  const clean = worktreePath.replace(/^\\\\\?\\/, "");
  branchInWorktree = execFileSync(
    "git",
    ["-C", clean, "branch", "--show-current"],
    { encoding: "utf8" },
  ).trim();
}
const worktreeList = git("worktree", "list");
step("git-acceptance", { branchInWorktree, worktreeList: worktreeList.split("\n").map((l) => l.slice(0, 90)) });
report.verdict.gitAnnouncesMuseBranch = /^muse\//.test(branchInWorktree ?? "");
// the transcript carries the turn's answer
const transcript = await evaluate(`(() => (document.querySelector(".session-center")?.innerText ?? "").slice(-200))()`);
report.verdict.turnRanInWorktree = /TREEOK/.test(transcript);
report.verdict.all =
  !!report.verdict.conversationStartedInWorktree &&
  !!report.verdict.gitAnnouncesMuseBranch &&
  !!report.verdict.turnRanInWorktree;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
