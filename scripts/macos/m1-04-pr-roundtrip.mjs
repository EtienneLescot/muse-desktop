#!/usr/bin/env node
/**
 * M1-04 on macOS, the remote half: the live PR round trip through the app's
 * Changes panel, as on Windows (scripts/cdp-m1-04-pr-roundtrip.mjs,
 * docs/evidence/2026-09-26-m1-closure/m1-04-pr-roundtrip.json), on the same
 * disposable PRIVATE repository EtienneLescot/m1-qualif-pr (Étienne's go,
 * 13/10/2026). The local half (commit, push, fetch, pull, refused push) is
 * m1-04-sync-commit-push.json.
 *
 * A clone of the repository under the run folder gets a branch with one
 * commit; one isolated instance (scripts/macos/test-instance.mjs, pinned
 * engine) opens a conversation in it (one live turn), pushes the branch with
 * the panel's Push branch, opens the PR with the panel's form, then clicks
 * again (Existing pull request). gh checks the branch and the PR on its own.
 * Cleanup: the PR is closed and the branch deleted on GitHub.
 *
 *   node scripts/macos/m1-04-pr-roundtrip.mjs --exe ~/muse-proofs/app/<commit>/muse-desktop
 *     --build-commit <commit> [--port 9402] [--out <record>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const BUILD = argValue("--build-commit", "unknown");
const PORT = Number(argValue("--port", "9402"));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m1-04-pr-roundtrip-macos.json");
const ID = Date.now().toString(36);
const BASE = join(tmpdir(), "muse-proofs-m1-04", ID);
const GH_REPO = "EtienneLescot/m1-qualif-pr";
const BRANCH = `qualif-pr-macos-${ID}`;
const REPO = join(BASE, "m1-qualif-pr");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const sw = (flag) => execFileSync("sw_vers", [flag], { encoding: "utf8" }).trim();

const report = {
  schema: "muse-desktop.m1-04-pr-roundtrip-macos.v1",
  ticket: "M1-04",
  date: new Date().toISOString().slice(0, 10),
  commit: BUILD,
  platform: `macOS ${sw("-productVersion")} (${sw("-buildVersion")}), ${process.arch}, Apple Silicon; debug build ${BUILD} with embedded frontend, WKWebView through the test bridge`,
  harness: "scripts/macos/m1-04-pr-roundtrip.mjs on scripts/macos/test-instance.mjs (macOS replay of scripts/cdp-m1-04-pr-roundtrip.mjs)",
  disposableRepo: `https://github.com/${GH_REPO} (private, disposable, reused from the Windows proof of 26/09)`,
  liveTurns: 1,
  steps: {},
  verdicts: {},
};
const step = (name, data) => { report.steps[name] = data; };

mkdirSync(BASE, { recursive: true });
execFileSync("git", ["clone", "-q", `https://github.com/${GH_REPO}.git`, REPO]);
git("config", "user.email", "qualif@local");
git("config", "user.name", "Qualif Locale");
git("checkout", "-q", "-b", BRANCH);
writeFileSync(join(REPO, `macos-${ID}.md`), `# macOS PR round trip ${ID}\n`);
git("add", "-A");
git("commit", "-qm", `qualif: macOS branch change ${ID}`);
step("scratch", { branch: BRANCH, ahead: git("rev-list", "--count", "master..HEAD") });

let inst = null;
let prUrl = null;
try {
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  report.engine = inst.engineVersion;
  report.isolation = inst.isolation;
  const { app } = inst;
  const ev = (expression) => app.ev(expression);
  const setValue = (selector, value) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  /** A real click on the panel's button, by its text. */
  const clickButton = async (text) => {
    const at = await ev(`(() => {
      const b = [...(document.querySelector(".review-panel") ?? document).querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled);
      if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!at) throw new Error(`no enabled button ${text}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await app.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
  };
  const panel = () => ev(`document.querySelector(".review-panel")?.textContent ?? ""`);

  step("start", await newProjectConversation(app, REPO));
  const sid = await sendFirstMessage(app, `Reply with exactly OK-${ID} and nothing else. Do not use any tool.`);
  step("turn", { replied: Boolean(await waitFor(async () => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(`OK-${ID}`)), 180_000, 1_000)) });

  await ev(`(() => { if (!document.querySelector("nav.work-tabs")) document.querySelector('button[aria-label="Show work panel"]')?.click(); })()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll("nav.work-tabs button")].find((b) => b.textContent.trim() === "Changes")?.click()`);
  await sleep(800);
  await ev(`document.querySelector("button.review-refresh")?.click()`);
  step("panel", { branchShown: Boolean(await waitFor(async () => (await panel()).includes(BRANCH), 30_000)) });

  // Push the branch through the panel.
  await ev(`(() => {
    for (const label of ["Sync remote", "Push remote"]) {
      const sel = document.querySelector('select[aria-label="' + label + '"]');
      if (sel && [...sel.options].some((o) => o.value === "origin")) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "origin");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  })()`);
  await setValue('input[aria-label="Push branch"]', BRANCH);
  await sleep(400);
  await clickButton("Push branch");
  const pushed = await waitFor(async () => (await panel()).includes("Pushed origin"), 60_000, 800);
  let refOnGithub = null;
  try { refOnGithub = gh("api", `repos/${GH_REPO}/git/refs/heads/${BRANCH}`, "--jq", ".ref"); } catch { /* absent */ }
  step("branch-pushed", { panelSaysPushed: Boolean(pushed), ref: refOnGithub });
  report.verdicts.branchPushed = refOnGithub === `refs/heads/${BRANCH}`;

  // Open the PR through the panel's form.
  await setValue('input[aria-label="Pull request title"]', `macOS PR round trip ${ID}`);
  await setValue('input[aria-label="Pull request base branch"]', "master");
  await setValue('textarea[aria-label="Pull request description"]', "Opened by the Muse-Desktop Changes panel during the M1-04 macOS qualification.");
  await sleep(400);
  await clickButton("Open pull request");
  const opened = await waitFor(() => ev(`(() => { const l = document.querySelector(".review-ship-link"); return l ? { url: l.href, text: l.textContent.trim() } : null; })()`), 90_000, 1_500);
  prUrl = opened?.url ?? null;
  step("pr-opened", opened);
  report.verdicts.prCreated = Boolean(opened?.text?.includes("Open pull request") && prUrl?.includes(GH_REPO));

  const ghPr = JSON.parse(gh("pr", "list", "--repo", GH_REPO, "--head", BRANCH, "--base", "master", "--state", "open", "--json", "url,title,headRefName,baseRefName", "--limit", "1"))[0] ?? null;
  step("gh-verification", ghPr);
  report.verdicts.ghConfirmsPr = Boolean(ghPr) && ghPr.url === prUrl;

  // Idempotency: clicking again reports the existing PR.
  await clickButton("Open pull request");
  const again = await waitFor(() => ev(`(() => { const l = document.querySelector(".review-ship-link"); return l && l.textContent.includes("Existing pull request") ? { url: l.href, text: l.textContent.trim() } : null; })()`), 90_000, 1_500);
  step("pr-idempotent", again);
  report.verdicts.prIdempotent = Boolean(again) && again.url === prUrl;
  report.consoleErrors = app.errors.slice(0, 20);
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 600);
  if (error?.appOutput) report.appOutput = error.appOutput;
} finally {
  if (inst) report.stop = await inst.stop();
  const cleanup = {};
  try {
    const number = prUrl?.split("/").pop() ?? JSON.parse(gh("pr", "list", "--repo", GH_REPO, "--head", BRANCH, "--state", "open", "--json", "number", "--limit", "1"))[0]?.number;
    if (number) { gh("pr", "close", String(number), "--repo", GH_REPO, "--delete-branch"); cleanup.prClosed = true; }
  } catch (error) { cleanup.prCloseError = String(error).slice(0, 160); }
  try { gh("api", "-X", "DELETE", `repos/${GH_REPO}/git/refs/heads/${BRANCH}`); } catch { /* already deleted with the PR */ }
  try { gh("api", `repos/${GH_REPO}/git/refs/heads/${BRANCH}`); cleanup.branchLeftOnGithub = true; } catch { cleanup.branchLeftOnGithub = false; }
  step("cleanup", cleanup);
}
report.passed = !report.failure && ["branchPushed", "prCreated", "ghConfirmsPr", "prIdempotent"].every((k) => report.verdicts[k] === true)
  && report.stop?.leftAfterQuit?.length === 0 && report.stop?.defaultStoresUnchangedAtEnd === true;
const clean = redactor([[BASE.replace(/^\/var\//, "/private/var/"), "<run>"], [BASE, "<run>"], [homedir(), "~"]])(report);
mkdirSync(join(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(clean, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, verdicts: report.verdicts, failure: report.failure, cleanup: report.steps.cleanup }, null, 2));
process.exit(report.passed ? 0 : 1);
