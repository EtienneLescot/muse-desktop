#!/usr/bin/env node
/**
 * M1-04 final piece: the live PR round trip through the app's Ship panel.
 *
 * A disposable PRIVATE GitHub repo (EtienneLescot/m1-qualif-pr) receives a
 * pushed branch; the panel then opens the PR (title/base/body via the real
 * form, head = the pushed branch). Idempotency is proved by clicking again
 * ("Existing pull request"). gh verifies both steps independently.
 *
 * Cleanup: the PR is closed; the repo itself needs manual deletion (the gh
 * token has no delete_repo scope).
 *
 * Usage: node scripts/cdp-m1-04-pr-roundtrip.mjs
 *   [--out docs/evidence/2026-09-26-m1-closure/m1-04-pr-roundtrip.json]
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
const GH_REPO = "EtienneLescot/m1-qualif-pr";
const GH_URL = `https://github.com/${GH_REPO}.git`;
const BRANCH = "qualif-pr";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const git = (...args) =>
  execFileSync("git", ["-C", REPO_FWD, ...args], { encoding: "utf8" }).replace(/[\r\n]+$/, "");

// --- phase A: scratch repo + disposable remote, all via CLI
rmSync(REMOTE_SAFE(), { recursive: true, force: true });
if (existsSync(REPO_FWD)) {
  for (const entry of readdirSync(REPO_FWD)) {
    try { rmSync(join(REPO_FWD, entry), { recursive: true, force: true }); } catch {}
  }
}
execFileSync("git", ["init", "-q", REPO_FWD]);
git("config", "user.email", "qualif@local");
git("config", "user.name", "Qualif Locale");
wf(join(REPO_FWD, "README.md"), "# Scratch qualif M1\n\nPR round trip qualification.\n");
git("add", "-A");
git("commit", "-qm", "initial");
try {
  gh("repo", "view", GH_REPO, "--json", "name", "--jq", ".name");
  console.log(`reusing existing disposable repo ${GH_REPO}`);
} catch {
  gh("repo", "create", GH_REPO, "--private", "--description", "Disposable PR round-trip qualification repo (safe to delete)");
  console.log(`created disposable repo ${GH_REPO}`);
}
git("remote", "add", "origin", GH_URL);
git("push", "-q", "origin", "master");
git("checkout", "-q", "-b", BRANCH);
wf(join(REPO_FWD, "README.md"), "# Scratch qualif M1\n\nPR round trip qualification.\n\nBranch change for the live PR.\n");
git("add", "-A");
git("commit", "-qm", "qualif: branch change for the PR round trip");
console.log("phase A done: branch", BRANCH, "with one commit ahead of master");

// --- phase B: the app opens the PR
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no CDP page target (launch the dev app with CDP)");
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
  schema: "muse-desktop.m1-04-pr-roundtrip.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: "Windows 11 (26200), dev webview (WebView2, CDP), real Muse 1.3.0 sidecar",
  disposableRepo: `https://github.com/${GH_REPO} (private; manual deletion — token lacks delete_repo)`,
  steps: {},
  verdict: {},
};
const step = (name, data) => {
  report.steps[name] = data;
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 220)}`);
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
const waitFor = async (label, fn, timeoutMs = 45_000, interval = 800) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => ({ ok: false, error: String(error) }));
    if (last && last.ok) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 200)}`);
};

await sleep(2000);
// open the scratch conversation: find its title in localStorage, click the row
const target = await evaluate(`(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const inWs = sessions.find((s) => (s.workspace || "").includes("m1-qualification"));
  return inWs ? { id: inWs.session_id, title: inWs.title } : null;
})()`);
if (!target) throw new Error("scratch conversation not found in sessions");
await evaluate(`(() => {
  const row = [...document.querySelectorAll("button.session-select")]
    .find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(target.title)});
  row?.click();
})()`);
await sleep(3000);
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
await waitFor("status shows qualif-pr branch", () => evaluate(`(() => ({
  ok: (document.querySelector(".review-panel")?.textContent ?? "").includes("${BRANCH}"),
}))()`), 30_000);

// push the branch through the panel
await evaluate(`(() => {
  const P = HTMLSelectElement.prototype;
  for (const label of ["Sync remote", "Push remote"]) {
    const sel = document.querySelector('select[aria-label="' + label + '"]');
    if (!sel) continue;
    const targetOpt = [...sel.options].find((o) => o.value === "origin");
    if (targetOpt) {
      Object.getOwnPropertyDescriptor(P, "value").set.call(sel, "origin");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
})()`);
await setValue('input[aria-label="Push branch"]', BRANCH);
await sleep(400);
await clickButtonByText("Push branch");
await waitFor("push result", () => evaluate(`(() => ({
  ok: (document.querySelector(".review-panel")?.textContent ?? "").includes("Pushed origin"),
}))()`), 45_000);
const refOnGithub = gh("api", `repos/${GH_REPO}/git/refs/heads/${BRANCH}`, "--jq", ".ref");
step("branch-pushed", { ref: refOnGithub });
report.verdict.branchPushed = refOnGithub === `refs/heads/${BRANCH}`;

// open the PR through the panel
await setValue('input[aria-label="Pull request title"]', "Qualif PR round trip");
await setValue('input[aria-label="Pull request base branch"]', "master");
await setValue('textarea[aria-label="Pull request description"]', "Opened by the Muse-Desktop Ship panel during M1-04 qualification.");
await sleep(400);
await clickButtonByText("Open pull request");
const prState = await waitFor("PR result link", () => evaluate(`(() => {
  const link = document.querySelector(".review-ship-link");
  if (!link) return { ok: false };
  return { ok: true, url: link.href, text: link.textContent.trim() };
})()`), 60_000, 1500);
step("pr-opened", prState);
report.verdict.prCreated = prState.text.includes("Open pull request") && prState.url.includes(GH_REPO);

// independent verification via gh
const ghPr = JSON.parse(gh("pr", "list", "--repo", GH_REPO, "--head", BRANCH, "--base", "master", "--state", "open", "--json", "url,title,headRefName,baseRefName", "--limit", "1"))[0] ?? null;
step("gh-verification", ghPr);
report.verdict.ghConfirmsPr = !!ghPr && ghPr.url === prState.url;

// idempotency: clicking again reports the existing PR
await clickButtonByText("Open pull request");
const idemState = await waitFor("existing PR result", () => evaluate(`(() => {
  const link = document.querySelector(".review-ship-link");
  if (!link) return { ok: false };
  return { ok: link.textContent.includes("Existing pull request"), text: link.textContent.trim(), url: link.href };
})()`), 60_000, 1500);
step("pr-idempotent", idemState);
report.verdict.prIdempotent = idemState.ok && idemState.url === prState.url;

// cleanup: close the PR (the repo itself stays — no delete_repo scope)
let cleanup = { prClosed: false };
try {
  const prNumber = prState.url.split("/").pop();
  gh("pr", "close", prNumber, "--repo", GH_REPO);
  cleanup = { prClosed: true, note: "repo deletion is manual (token lacks delete_repo scope)" };
} catch (error) {
  cleanup = { prClosed: false, error: String(error).slice(0, 120) };
}
step("cleanup", cleanup);

socket.close();
report.verdict.all =
  !!report.verdict.branchPushed &&
  !!report.verdict.prCreated &&
  !!report.verdict.ghConfirmsPr &&
  !!report.verdict.prIdempotent;
if (OUT) {
  mkd(dirname(OUT), { recursive: true });
  wf(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`written ${OUT}`);
}
console.log(JSON.stringify(report.verdict));

function REMOTE_SAFE() {
  return "G:/repos/m1-qualification-remote.git";
}
