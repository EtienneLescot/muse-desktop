#!/usr/bin/env node
/**
 * M2-04 + M2-06 native qualification, driven through the real Settings UI.
 *
 * M2-04 (worktree environment): open the worktree conversation -> the setup
 * surface appears; a setup command runs IN the worktree (proof file), a
 * failing command reports failed + exit code, a long command is cancelled
 * through the token, readiness detects package.json + toolchains, and the
 * runner refuses the main checkout (outside .muse/worktrees).
 *
 * M2-06 (cleanup): from the main checkout's settings, Inspect all lists the
 * main checkout and the worktrees with real branch/clean/dirty/age; a clean
 * unattached worktree is removed; a dirty worktree is refused; the retention
 * select persists per repository.
 *
 * Usage: node scripts/cdp-m2-04-06-setup-cleanup.mjs
 *   [--out docs/evidence/2026-09-26-m2-closure/m2-04-06-setup-cleanup.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync as wf, mkdirSync as mkd } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();
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
  schema: "muse-desktop.m2-04-06-setup-cleanup.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 240)}`);
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
const git = (...args) =>
  execFileSync("git", ["-C", REPO_FWD, ...args], { encoding: "utf8" }).replace(/[\r\n]+$/, "");

// ---- M2-04: open the worktree conversation, then Settings
await sleep(2000);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("button.session-select")];
  const target = rows.find((b) => (b.getAttribute("title") || "").includes("TREEOK"));
  target ?? rows[0];
  (target ?? rows[0])?.click();
})()`);
await sleep(3000);
const worktreePath = await evaluate(`(() =>
  document.querySelector('.task-metadata span[title*="worktrees"]')?.getAttribute("title") ?? null)()`);
step("worktree-conversation-open", { worktreePath });
if (!worktreePath) throw new Error("worktree conversation not found");
await evaluate(`(() => {
  document.querySelector('button[aria-label="Settings"]')?.click();
})()`);
await sleep(1500);
const surface = await evaluate(`(() => ({
  group: !!document.querySelector('[aria-label="Worktree tools"]'),
  setupTextarea: !!document.querySelector('textarea[aria-label="Worktree setup command"]'),
  readiness: !!document.querySelector('button') && [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Check readiness"),
}))()`);
step("setup-surface-visible", surface);
report.verdict.setupSurfaceInWorktree = surface.group && surface.setupTextarea;

// ready path: proof file written inside the worktree
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Worktree setup command"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "echo M2-04-SETUP-PROOF > setup-proof.txt");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run setup");
  b?.click();
})()`);
await waitFor("setup ready", () => evaluate(`(() => ({
  ok: /Setup ready/.test(document.querySelector('[aria-label="Worktree tools"]')?.textContent ?? ""),
}))()`), 45_000);
const proofPath = worktreePath.replace(/\\/g, "/") + "/setup-proof.txt";
const proof = await evaluate(`(async () => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke("read_text_file_small", { path: ${JSON.stringify(proofPath)} });
    return { ok: true, content: String(r).slice(0, 60) };
  } catch { return { ok: false }; }
})()`);
const proofViaCli = (() => {
  try {
    return execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(proofPath)},'utf8'))`], { encoding: "utf8" });
  } catch { return ""; }
})();
step("setup-ready", { proofFile: proof.ok || proofViaCli.includes("M2-04-SETUP-PROOF"), content: proofViaCli.slice(0, 40) });
report.verdict.setupRunsInWorktree = proofViaCli.includes("M2-04-SETUP-PROOF");

// failed path
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Worktree setup command"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "cmd /C exit /b 5");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run setup");
  b?.click();
})()`);
const failed = await waitFor("setup failed", () => evaluate(`(() => ({
  ok: /Setup failed/.test(document.querySelector('[aria-label="Worktree tools"]')?.textContent ?? "") && /exit 5/.test(document.querySelector('[aria-label="Worktree tools"]')?.textContent ?? ""),
}))()`), 45_000);
step("setup-failed", failed);
report.verdict.setupReportsFailure = true;

// readiness: give the worktree a package.json, then check
wf(worktreePath.replace(/\\/g, "/") + "/package.json", "{}");
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Check readiness");
  b?.click();
})()`);
const readiness = await waitFor("readiness displayed", () => evaluate(`(() => {
  const text = document.querySelector('[aria-label="Worktree tools"]')?.textContent ?? "";
  return { ok: /Readiness:/.test(text), text: text.match(/Readiness:[^]*?(?=Setup|$)/)?.[0]?.slice(0, 200) ?? "" };
})()`), 30_000);
step("readiness", readiness);
report.verdict.readinessDetects = /package\.json/.test(readiness.text) && /git available/.test(readiness.text);

// cancellation
await evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Worktree setup command"]');
  const P = HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(area, "ping -n 30 127.0.0.1");
  area.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run setup");
  b?.click();
})()`);
const cancelBtn = await waitFor("cancel button appears", () => evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Cancel setup" && !x.disabled);
  b?.click();
  return { ok: !!b };
})()`), 20_000);
const cancelled = await waitFor("setup cancelled", () => evaluate(`(() => ({
  ok: /Setup cancelled/.test(document.querySelector('[aria-label="Worktree tools"]')?.textContent ?? ""),
}))()`), 30_000);
step("setup-cancelled", { cancelBtn, cancelled });
report.verdict.setupCancellable = cancelled.ok;

// refusal: the runner rejects the main checkout (outside .muse/worktrees)
const refusal = await evaluate(`(async () => {
  try {
    const mainRoot = ${JSON.stringify(REPO_FWD)};
    await window.__TAURI_INTERNALS__.invoke("git_worktree_setup_run", {
      workspace: mainRoot,
      path: mainRoot,
      command: "echo nope",
      token: "refusal-probe",
    });
    return { ok: false, note: "no error raised" };
  } catch (e) {
    return { ok: true, error: String(e).slice(0, 140) };
  }
})()`);
step("setup-refuses-main-checkout", refusal);
report.verdict.setupRefusesOutsideWorktrees = refusal.ok && refusal.error.includes(".muse/worktrees");

// ---- M2-06: open the MAIN checkout conversation, inspect + remove
await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").replace(/[\\\\?]/g, "").replace(/\\\\/g, "/").endsWith("repos/m1-qualification"));
  return inWs ? inWs.title : null;
})()`);
// switch to the main-checkout conversation (the one whose workspace lacks worktrees)
const mainTitle = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const normalized = (w) => (w || "").replace(/[\\\\?]/g, "").replace(/\\\\/g, "/");
  const inWs = sessions.find((s) => normalized(s.workspace).endsWith("repos/m1-qualification"));
  return inWs ? inWs.title : null;
})()`);
if (mainTitle) {
  await evaluate(`(() => {
    const row = [...document.querySelectorAll("button.session-select")]
      .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(mainTitle)});
    row?.click();
  })()`);
  await sleep(3000);
}
await evaluate(`(() => {
  document.querySelector('button[aria-label="Settings"]')?.click();
})()`);
await sleep(1500);
// inspect: the main repo has at least one worktree (the M2-03 one)
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Inspect all");
  b?.click();
})()`);
const inspected = await waitFor("worktree list rendered", () => evaluate(`(() => ({
  ok: document.querySelectorAll(".worktree-inspections li").length >= 2,
  rows: [...document.querySelectorAll(".worktree-inspections li")].map((li) => li.textContent.trim().slice(0, 110)),
}))()`), 30_000);
step("m2-06-inspect-all", inspected);
report.verdict.inspectAllLists = inspected.rows.some((r) => r.includes("main checkout")) &&
  inspected.rows.some((r) => /muse\//.test(r));

// dirty refusal: create a dirty worktree via git, Inspect, then Force-remove guards
// (idempotent across reruns: previous runs leave the branch and folder behind)
try { execFileSync("git", ["-C", REPO_FWD, "worktree", "remove", "--force", ".muse/worktrees/wt-dirty"]); } catch {}
try { execFileSync("git", ["-C", REPO_FWD, "branch", "-D", "muse/qualif-dirty"]); } catch {}
try { execFileSync("git", ["-C", REPO_FWD, "worktree", "remove", "--force", ".muse/worktrees/wt-clean"]); } catch {}
try { execFileSync("git", ["-C", REPO_FWD, "branch", "-D", "muse/qualif-clean"]); } catch {}
execFileSync("git", ["-C", REPO_FWD, "worktree", "add", "-q", "-b", "muse/qualif-dirty", ".muse/worktrees/wt-dirty"]);
wf(REPO_FWD + "/.muse/worktrees/wt-dirty/dirty.txt", "change");
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Refresh");
  b?.click();
  const inspect = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Inspect all");
  inspect?.click();
})()`);
await sleep(2500);
const dirtyRow = await waitFor("dirty worktree listed", () => evaluate(`(() => {
  const li = [...document.querySelectorAll(".worktree-inspections li")]
    .find((x) => x.textContent.includes("wt-dirty"));
  return { ok: !!li && /dirty/.test(li.textContent), text: li?.textContent.trim().slice(0, 110) ?? "" };
})()`), 30_000);
step("m2-06-dirty-detected", dirtyRow);
// non-forced removal of the dirty worktree is refused by the backend
const dirtyRefusal = await evaluate(`(async () => {
  try {
    const mainRoot = ${JSON.stringify(REPO_FWD)};
    await window.__TAURI_INTERNALS__.invoke("git_worktree_remove", {
      workspace: mainRoot,
      path: mainRoot + "\\\\.muse\\\\worktrees\\\\wt-dirty",
      force: false,
    });
    return { ok: false, note: "removal was not refused" };
  } catch (e) {
    return { ok: true, error: String(e).slice(0, 140) };
  }
})()`);
step("m2-06-dirty-refused", dirtyRefusal);
report.verdict.dirtyRemovalRefused = dirtyRefusal.ok;
// a clean unattached worktree is removable from the panel
execFileSync("git", ["-C", REPO_FWD, "worktree", "add", "-q", "-b", "muse/qualif-clean", ".muse/worktrees/wt-clean"]);
await evaluate(`(() => {
  const inspect = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Inspect all");
  inspect?.click();
})()`);
await sleep(2500);
const removed = await evaluate(`(() => {
  const li = [...document.querySelectorAll(".worktree-inspections li")]
    .find((x) => x.textContent.includes("wt-clean"));
  const btn = li ? [...li.querySelectorAll("button")].find((b) => b.textContent.trim() === "Remove") : null;
  btn?.click();
  return !!btn;
})()`);
await waitFor("clean worktree removed from the list", () => evaluate(`(() => ({
  ok: ![...document.querySelectorAll(".worktree-inspections li")].some((x) => x.textContent.includes("wt-clean")),
}))()`), 30_000);
const wtCleanGone = await evaluate(`(() => {
  const li = [...document.querySelectorAll(".worktree-inspections li")].length;
  return { rows: li };
})()`);
step("m2-06-clean-removed", { clicked: removed, ...wtCleanGone });
report.verdict.cleanRemovalWorks = removed;
// retention select persists per repository
await evaluate(`(() => {
  const sel = document.querySelector('select[aria-label="Worktree retention"]');
  const P = HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(P, "value").set.call(sel, "14");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
await sleep(400);
const retentionPersisted = await evaluate(`(() => {
  const map = JSON.parse(localStorage.getItem("muse-desktop.worktree-retention.v1") || "{}");
  return Object.entries(map).map(([k, v]) => [k.slice(-30), v]);
})()`);
step("m2-06-retention-persisted", retentionPersisted);
report.verdict.retentionPersisted = retentionPersisted.length > 0;

socket.close();
report.verdict.m2_04_all =
  !!report.verdict.setupSurfaceInWorktree &&
  !!report.verdict.setupRunsInWorktree &&
  !!report.verdict.setupReportsFailure &&
  !!report.verdict.readinessDetects &&
  !!report.verdict.setupCancellable &&
  !!report.verdict.setupRefusesOutsideWorktrees;
report.verdict.m2_06_all =
  !!report.verdict.inspectAllLists &&
  !!report.verdict.dirtyRemovalRefused &&
  !!report.verdict.cleanRemovalWorks &&
  !!report.verdict.retentionPersisted;
report.verdict.all = !!report.verdict.m2_04_all && !!report.verdict.m2_06_all;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));
process.exit(0);
