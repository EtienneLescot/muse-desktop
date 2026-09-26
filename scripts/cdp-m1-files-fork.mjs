#!/usr/bin/env node
/**
 * M1-07 (files browser) + M1-09 (faithful fork) native qualification in the
 * dev webview, against the scratch repository so nothing touches real
 * workspaces.
 *
 *   M1-07: real listing + bounded preview of a text file, Add to prompt with
 *          provenance, Office file kept out of the text preview, a 550-entry
 *          folder stays bounded with a note, an on-disk rename shows up, and
 *          a deleted folder yields a bounded error instead of a crash.
 *   M1-09: "Fork from this turn" on an early entry creates a branch whose
 *          transcript stops at the anchor (later turns excluded) while the
 *          source conversation keeps everything.
 *
 * Usage: node scripts/cdp-m1-files-fork.mjs
 *   [--out docs/evidence/.../m1-07-09-files-fork.json]
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
  frame.error ? entry.reject(new Error(frame.error.message)) : entry.resolve(frame);
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
  schema: "muse-desktop.m1-files-fork.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  scratchRepo: REPO_FWD,
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 220)}`);
};
const waitFor = async (label, fn, timeoutMs = 30_000, interval = 500) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => ({ ok: false, error: String(error) }));
    if (last && last.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 200)}`);
};

// open the scratch conversation (the sidebar row whose title mentions the
// project or the most recent conversation rooted in the scratch repo)
await sleep(1500);
const boot = await evaluate(`(() => ({
  sessionView: !!document.querySelector("nav.work-tabs"),
  rows: document.querySelectorAll("button.session-select").length,
}))()`);
if (!boot.sessionView) {
  if (!boot.rows) throw new Error("no conversation to open");
  await evaluate(`document.querySelector("button.session-select")?.click()`);
  await sleep(2500);
}
// open the Files tab
await evaluate(`(() => {
  if (document.querySelector("nav.work-tabs")) return "open";
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await sleep(600);
await evaluate(`(() => {
  Array.from(document.querySelectorAll("nav.work-tabs button"))
    .find((b) => b.textContent.trim() === "Files")?.click();
})()`);
await waitFor("files listed", () => evaluate(`(() => ({
  ok: document.querySelectorAll(".files-list .file-row").length > 0,
}))()`), 30_000);

// --- M1-07.1: text file preview + Add to prompt
const clickRow = async (name) => {
  await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll(".files-list .file-row"))
      .find((r) => r.textContent.includes(${JSON.stringify(name)}));
    row?.click();
  })()`);
  await sleep(900);
};
await clickRow("main.rs");
const textPreview = await waitFor("main.rs preview", () => evaluate(`(() => {
  const head = document.querySelector(".file-preview-head strong")?.textContent ?? "";
  if (!head.includes("main.rs")) return { ok: false };
  return { ok: true, size: document.querySelector(".file-preview-head span")?.textContent ?? "" };
})()`), 20_000);
step("m1-07-text-preview", textPreview);
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll(".file-preview button"))
    .find((x) => x.textContent.trim() === "Add to prompt");
  b?.click();
})()`);
await sleep(900);
const composed = await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? ""`);
const composerBefore = composed;
step("m1-07-add-to-prompt", {
  composerHasContent: composed.includes("fn main"),
  composerLength: composed.length,
});
report.verdict.textPreviewAndPrompt = composed.includes("fn main");
// clear the composer draft for later steps
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Muse"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);

// --- M1-07.2: office file kept out of the text preview
await clickRow("fake.docx");
const officePreview = await waitFor("office preview state", () => evaluate(`(() => {
  const head = document.querySelector(".file-preview-head strong")?.textContent ?? "";
  if (!head.includes("fake.docx")) return { ok: false };
  const text = document.querySelector(".file-preview")?.textContent ?? "";
  return { ok: true, guarded: /could not be safely previewed|Binary content is not rendered|no inline preview/.test(text) };
})()`), 20_000);
step("m1-07-office-preview", officePreview);
report.verdict.officeGuarded = officePreview.guarded;

const filesRefresh = () => evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('[aria-label="Workspace files"] button'))
    .find((x) => x.textContent.trim() === "Refresh");
  b?.click();
  return !!b;
})()`);
// --- M1-07.3: 550-entry folder stays bounded with a note
const bulkDir = join(REPO_FWD, "bulk");
rmSync(bulkDir, { recursive: true, force: true });
mkd(bulkDir, { recursive: true });
for (let i = 0; i < 550; i += 1) wf(join(bulkDir, `f-${String(i).padStart(4, "0")}.txt`), `${i}\n`);
await filesRefresh();
await sleep(1200);
await clickRow("bulk");
const bulkState = await waitFor("bulk folder listed", () => evaluate(`(() => {
  const rows = document.querySelectorAll(".files-list .file-row").length;
  if (rows < 100) return { ok: false, rows };
  return {
    ok: true,
    rows,
    note: document.querySelector(".files-note")?.textContent ?? "",
  };
})()`), 25_000);
step("m1-07-bounded-listing", bulkState);
report.verdict.boundedListing =
  bulkState.rows >= 200 && /first 200 entries|Showing the first/.test(bulkState.note);

// --- M1-07.4: on-disk rename shows up (the renamed entry must sort within
// the bounded 200-row window to be visible)
wf(join(bulkDir, "aaa-renamed.txt"), "renamed\n");
rmSync(join(bulkDir, "f-0000.txt"), { force: true });
await filesRefresh();
await sleep(1500);
const renamed = await evaluate(`(() => ({
  hasRenamed: [...document.querySelectorAll(".files-list .file-row")].some((r) => r.textContent.includes("aaa-renamed.txt")),
  hasOld: [...document.querySelectorAll(".files-list .file-row")].some((r) => r.textContent.includes("f-0000.txt")),
  sampleRows: [...document.querySelectorAll(".files-list .file-row")].map((r) => r.textContent.trim().slice(0, 24)).slice(0, 6),
  currentPath: document.querySelector(".files-meta")?.textContent ?? "",
}))()`);
step("m1-07-rename-reflected", renamed);
report.verdict.renameReflected = renamed.hasRenamed && !renamed.hasOld;

// --- M1-07.5: deleted folder -> bounded error, no crash.
// We are INSIDE bulk here: delete it on disk, then refresh the listing of
// the now-missing working directory.
rmSync(bulkDir, { recursive: true, force: true });
await filesRefresh();
const deletedState = await waitFor("deleted folder error", () => evaluate(`(() => {
  const err = document.querySelector(".files-error")?.textContent ?? "";
  return { ok: err.length > 0, err: err.slice(0, 120) };
})()`), 25_000);
step("m1-07-deleted-folder", deletedState);
report.verdict.deletedFolderBoundedError = deletedState.ok;
// recovery: "Up" returns to the existing parent listing
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('[aria-label="Workspace files"] button'))
    .find((x) => x.textContent.trim() === "Up");
  b?.click();
})()`);
await sleep(1500);
const appAlive = await evaluate(`(() => ({
  ok: document.querySelectorAll('[aria-label="Workspace files"] .file-row').length > 0,
}))()`);
step("m1-07-recovered-up", appAlive);
report.verdict.appSurvives = appAlive.ok;

// --- M1-09: faithful fork from an early turn
// go back to the conversation stream
await evaluate(`(() => {
  if (document.querySelector("nav.work-tabs")) return "open";
  document.querySelector('button[aria-label="Show work panel"]')?.click();
})()`);
await evaluate(`(() => {
  const btn = document.querySelector('button[aria-label="Hide work panel"]');
  btn?.click();
})()`);
await sleep(600);
const sourceLog = await evaluate(`(() => {
  const active = JSON.parse(localStorage.getItem("muse-desktop.active.v1") || '""');
  const id = typeof active === "string" ? active.replace(/"/g, "") : active;
  const log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + id) || "[]");
  return { id, count: log.length, texts: log.map((e) => (e.text || "").slice(0, 40)) };
})()`);
step("m1-09-source-log", { id: sourceLog.id, count: sourceLog.count, first: sourceLog.texts[0] });
// fork from the FIRST forkable entry (an early turn)
// The scratch conversation was loaded from disk by a restarted host: every
// anchor answers the explicit recovery banner ("That turn is no longer
// available on the host…") — that recovery path is itself an M1-09 criterion
// and is recorded above. The faithful-branch proof runs on a FRESH session
// (the host holds its turn seeds): two short live turns, fork from the first.
const forkTries = [];
const recoveryBanner = await evaluate(`(() =>
  document.querySelector(".window-error, [role=alert]")?.textContent?.slice(0, 160) ?? null)()`);
step("m1-09-recovery-banner", { recoveryBanner });
report.verdict.unavailableAnchorRecovery = /no longer available on the host/.test(recoveryBanner ?? "");
const turnDone = () => evaluate(`(() => {
  const dot = document.querySelector(".session-view .task-metadata .dot");
  return { ok: dot?.getAttribute("data-running") !== "true" };
})()`);
await evaluate(`(() => {
  const nav = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") || "") === "New conversation",
  );
  nav?.click();
})()`);
await sleep(2500);
const pickedFresh = await evaluate(`(() => {
  const picker = document.querySelector("details.project-picker-control");
  if (picker) {
    picker.setAttribute("open", "");
    const option = [...picker.querySelectorAll("button, [role=option]")]
      .find((o) => /m1-qualification/i.test(o.textContent));
    if (option) { option.click(); return { picked: true }; }
  }
  const sel = document.querySelector("select");
  if (sel) {
    const target = [...sel.options].find((o) => /m1-qualification/i.test(o.textContent));
    if (target) {
      const P = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, target.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { picked: true };
    }
  }
  return { picked: false };
})()`);
if (!pickedFresh.picked) throw new Error("scratch picker not found for the fresh session");
const setValueInner = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
// turn 1
await setValueInner('textarea[aria-label="Your first message"]', "Reply with just the word FORKONE and nothing else.");
await evaluate(`document.querySelector("button.welcome-send")?.click()`);
await waitFor("fresh turn one running", () => evaluate(`(() => ({
  ok: document.querySelector(".session-view .task-metadata .dot")?.getAttribute("data-running") === "true",
}))()`), 60_000, 800);
await waitFor("fresh turn one done", turnDone, 180_000, 3000);
await sleep(1500);
// turn 2 — the send must be confirmed by the dot actually turning "running",
// otherwise a silently lost click reads as an instant "done"
let turnTwoStarted = false;
for (let attempt = 0; attempt < 3 && !turnTwoStarted; attempt++) {
  await evaluate(`document.querySelector('textarea[aria-label="Message Muse"]')?.focus()`);
  await send("Input.insertText", { text: "Reply with just the word FORKTWO and nothing else." });
  await sleep(200);
  await evaluate(`document.querySelector('button[aria-label="Send message"]')?.click()`);
  const started = await evaluate(`(() => ({
    ok: document.querySelector(".session-view .task-metadata .dot")?.getAttribute("data-running") === "true",
  }))()`);
  turnTwoStarted = started.ok;
  if (!turnTwoStarted) await sleep(3000);
}
if (!turnTwoStarted) throw new Error("turn two never started after 3 send attempts");
await waitFor("fresh turn two done", turnDone, 180_000, 3000);
await sleep(1500);
// fork from the FIRST entry of the fresh session
forkTries.push(await evaluate(`(() => {
  const btn = document.querySelector("button.msg-fork");
  if (!btn) return { ok: false, reason: "no-button" };
  btn.click();
  return { ok: true, total: document.querySelectorAll("button.msg-fork").length };
})()`));
step("m1-09-fork-clicked", { tries: forkTries });
// the fork becomes a new conversation; poll for it (the host fork + record
// write take a moment), capturing any error banner meanwhile
const forkDeadline = Date.now() + 30_000;
let branch = { found: false };
while (Date.now() < forkDeadline && !branch.found) {
  await sleep(2000);
  branch = await evaluate(`(() => {
    const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
    const branchSession = sessions.find((s) => (s.title || "").startsWith("Branch of "));
    const banner = document.querySelector(".window-error, [role=alert]")?.textContent?.slice(0, 160) ?? null;
    if (!branchSession) return { found: false, banner, sessionCount: sessions.length };
    const log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + branchSession.session_id) || "[]");
    return {
      found: true,
      id: branchSession.session_id,
      title: branchSession.title,
      count: log.length,
      texts: log.map((e) => (e.text || "").slice(0, 40)),
    };
  })()`);
}
step("m1-09-branch", branch);
// host 1.3.0 refuses every fork today (fresh session included) with
// `MSP -32023: invalid fork boundary … WriteFailed [forkBoundaryInvalid]`
// (captured raw via a direct fork_session IPC call). The UI-level
// faithful-branch assertion therefore runs only when a branch exists; the
// host-blocked outcome is recorded either way.
if (branch.found) {
  report.verdict.forkFaithful =
    branch.texts.some((t) => t.includes("FORKONE")) &&
    !branch.texts.some((t) => t.includes("FORKTWO"));
} else {
  report.verdict.forkFaithful = false;
  report.verdict.forkHostBlockedNote =
    "host 1.3.0 rejected session/fork (forkBoundaryInvalid WriteFailed) on every anchor incl. a fresh two-turn session; recovery copy + no-crash proved, prior 20/09 fresh-one-turn fork proof stands";
}
// the source conversation keeps both turns
const freshSource = await evaluate(`(() => {
  const active = JSON.parse(localStorage.getItem("muse-desktop.active.v1") || '""');
  const id = typeof active === "string" ? active.replace(/"/g, "") : active;
  const log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + id) || "[]");
  return { id, count: log.length, texts: log.map((e) => (e.text || "").slice(0, 40)) };
})()`);
step("m1-09-fresh-source", freshSource);
report.verdict.sourceIntact =
  freshSource.texts.some((t) => t.includes("FORKONE")) &&
  freshSource.texts.some((t) => t.includes("FORKTWO"));

socket.close();
report.verdict.m1_07_all =
  !!report.verdict.textPreviewAndPrompt &&
  !!report.verdict.officeGuarded &&
  !!report.verdict.boundedListing &&
  !!report.verdict.renameReflected &&
  !!report.verdict.deletedFolderBoundedError &&
  !!report.verdict.appSurvives;
report.verdict.m1_09_all =
  !!report.verdict.unavailableAnchorRecovery &&
  !!report.verdict.sourceIntact &&
  !!report.verdict.forkFaithful;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
