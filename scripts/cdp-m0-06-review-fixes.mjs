#!/usr/bin/env node
/**
 * M0-06, review of 06/10/2026: two fixes seen in the isolated app (test mode,
 * ADR 0003), no model turn. Launch as in cdp-m0-06-project-follows-global.mjs
 * (CDP on 9335), then MUSE_CDP_PORT=9335 node scripts/cdp-m0-06-review-fixes.mjs
 * <phase> --build before|after --commit <sha> --exe <exe> --test-data <data dir> --base <proof folder>
 *
 *   prepare  Isolation "Elevated access", then the model of the next
 *            conversation changed in the welcome screen's picker (a project
 *            conversation with no message loads the catalog first).
 *   check    after a relaunch on the same data folder: the Isolation Settings
 *            shows, and the stored model. Run once per relaunch.
 *   retry    on an instance whose test sidecar cannot start: Isolation
 *            "Elevated access", a project with Network "No network", its
 *            "New conversation here" fails, then the welcome screen's
 *            "Try again": which folder and posture the retry asks for.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, openPage, redactor, sleep, under, waitFor, webviewProfile } from "./cdp-harness.mjs";

const PHASE = process.argv[2];
const BUILD = argValue("--build", "after");
const EXE = argValue("--exe", null);
const TEST_DATA = argValue("--test-data", null);
const BASE = argValue("--base", "G:\\muse-proofs\\project-isolation\\review");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-06-review-fixes.json");
const COMMIT = argValue("--commit", null);
const PROJECT = "m06-review";
const ROOT = join(BASE, "proj");
if (!["prepare", "check", "retry"].includes(PHASE) || !EXE || !TEST_DATA || !COMMIT) {
  process.stderr.write("usage: <prepare|check|retry> --build before|after --commit <sha> --exe <exe> --test-data <dir> --base <dir>\n");
  process.exit(2);
}
const redact = redactor([[ROOT, "<project>"], [BASE, "<proof>"], [TEST_DATA, "<test data>"]]);

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (text, root) => q('button', root).find((b) => (b.innerText || '').trim() === text) || null;
  const raw = (key) => localStorage.getItem(key);
  const row = () => q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(PROJECT)});
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})
  .map((c) => ({ args: c.args, ok: c.ok, result: c.result === undefined ? undefined : String(c.result).slice(0, 600) }))`);
const stored = (app) => app.ev(page("return { isolation: raw('muse-desktop.settings.v1'), projectDefaults: raw('muse-desktop.project-defaults.v1') };"));

async function setIsolation(app, label) {
  await app.ev(page("const b = q('button').find((n) => /^Settings$/i.test((n.getAttribute('aria-label') || n.innerText || '').trim())); if (b) b.click(); return !!b;"));
  await sleep(1_200);
  return app.ev(page(`
    const l = q('[role="radiogroup"][aria-label="Isolation"] label').find((x) => x.querySelector('strong')?.innerText.trim() === ${JSON.stringify(label)});
    if (!l) return false;
    l.querySelector('input').click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  `));
}

/** What Settings shows for Isolation: the checked level and the status line. */
async function isolationShown(app) {
  await app.ev(page("const b = q('button').find((n) => /^Settings$/i.test((n.getAttribute('aria-label') || n.innerText || '').trim())); if (b) b.click(); return !!b;"));
  await sleep(1_500);
  return app.ev(page(`
    const checked = document.querySelector('input[name="sandbox-mode"]:checked');
    const group = q('.settings-group').find((g) => g.querySelector('h3')?.innerText.trim() === 'Isolation');
    return { checked: checked?.closest('label')?.querySelector('strong')?.innerText.trim() ?? null,
      status: group?.querySelector('.authorization-status')?.innerText.replace(/\\s+/g, ' ').trim() ?? null };
  `));
}

async function createProject(app) {
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(page("const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOT)}), true)`);
  return app.ev(page(`
    if (!row()) {
      setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(PROJECT)});
      button('Choose project folders').click();
      await new Promise((r) => setTimeout(r, 800));
      button('+ Add project').click();
      await new Promise((r) => setTimeout(r, 800));
    }
    const r = row(); if (!r) return false;
    r.querySelector('details').open = true;
    await new Promise((r) => setTimeout(r, 400));
    return true;
  `));
}

/** The row's "New conversation here"; the start_session call it made. */
async function startHere(app) {
  const n = (await ipc(app, "start_session")).length;
  const clicked = await app.ev(page("const b = button('New conversation here', row()); if (!b || b.disabled) return false; b.click(); return true;"));
  if (!clicked) throw new Error('no "New conversation here"');
  return waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > n && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
}
const openWelcome = (app) => app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));

async function prepare(app) {
  const result = { setElevated: await setIsolation(app, "Elevated access") };
  result.projectCreated = await createProject(app);
  const started = await startHere(app);
  result.startOk = Boolean(started?.ok);
  // The catalog is read when a conversation is selected, not when one starts.
  const sid = /"session_id":"([^"]+)"/.exec(started?.result ?? "")?.[1] ?? null;
  await app.ev(page(`const b = document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(async () => (await ipc(app, "list_models")).some((c) => c.ok), 30_000, 1_000);
  await openWelcome(app);
  // The picker appears once a host has listed its models.
  const picker = await waitFor(() => app.ev(page("return Boolean(q('summary.model-trigger')[0]) && !q('summary.model-trigger')[0].getAttribute('aria-disabled');")), 60_000, 1_000);
  if (picker) {
    result.model = await app.ev(page(`
      const trigger = q('summary.model-trigger')[0];
      const before = trigger.getAttribute('aria-label');
      trigger.click();
      await new Promise((r) => setTimeout(r, 600));
      const options = q('[role="listbox"][aria-label="Model"] [role="option"]');
      const next = options.find((o) => o.getAttribute('aria-selected') !== 'true') || null;
      if (!next) return { before, options: options.length, picked: null };
      next.click();
      await new Promise((r) => setTimeout(r, 800));
      return { before, options: options.length, picked: q('summary.model-trigger')[0]?.getAttribute('aria-label') ?? null };
    `));
  }
  result.stored = await stored(app);
  return result;
}

async function check(app) {
  return { shown: await isolationShown(app), stored: await stored(app) };
}

async function retry(app) {
  const result = { setElevated: await setIsolation(app, "Elevated access") };
  result.projectCreated = await createProject(app);
  result.setNoNetwork = await app.ev(page(`
    const s = row().querySelector('select[aria-label^="Project network"]');
    if (!s) return null;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'deny');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return s.value;
  `));
  const failed = await startHere(app);
  result.failedStart = { ok: Boolean(failed?.ok), workspacePath: failed?.args?.workspacePath ?? null, sandboxMode: failed?.args?.sandboxMode ?? null };
  await openWelcome(app);
  await sleep(1_200);
  const n = (await ipc(app, "start_session")).length;
  result.retryOffered = await app.ev(page("const b = button('Try again'); if (!b) return false; b.click(); return true;"));
  const call = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > n && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 20_000);
  result.retried = call ? { workspacePath: call.args?.workspacePath ?? null, sandboxMode: call.args?.sandboxMode ?? null } : null;
  result.shownAfter = await app.ev(page("return q('.error, [role=\"alert\"], .error-banner, .sidecar-error').map((n) => n.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)).slice(0, 3);"));
  return result;
}

const app = await openPage();
if (!under(webviewProfile(), TEST_DATA)) {
  app.close();
  throw new Error("the WebView2 profile is not under the test data folder: stopping before any action");
}
// Right after a launch the first document can still be replaced: wait for the shell.
await waitFor(() => app.ev("document.readyState === 'complete' && Boolean(document.querySelector('button.sidebar-manage'))"), 30_000);
await sleep(2_000);
await app.ev(INSTALL_IPC_TRACE);
mkdirSync(ROOT, { recursive: true });
const result = await { prepare, check, retry }[PHASE](app);
result.errors = app.errors.slice(0, 5);
app.close();

let record;
try { record = JSON.parse(readFileSync(OUT, "utf8")); } catch {
  record = {
    schema: "muse-desktop.m0-06-review-fixes.v1",
    tickets: ["M0-06"],
    platform: "Windows 11 (26200), debug build with embedded frontend, isolated test mode (ADR 0003), WebView2 over CDP",
    liveTurns: 0,
    builds: {},
  };
}
const build = record.builds[BUILD] ??= {};
build.commit = COMMIT;
build.exeSha256 = createHash("sha256").update(readFileSync(EXE)).digest("hex");
build.date = new Date().toISOString().slice(0, 10);
if (PHASE === "prepare") build.restart = { prepare: redact(result), checks: [] };
if (PHASE === "check") build.restart.checks.push(redact(result));
if (PHASE === "retry") build.retry = redact(result);
const elevated = (c) => c.shown.checked === "Elevated access";
const model = (stored) => {
  for (const key of ["projectDefaults", "isolation"]) {
    try { const value = JSON.parse(stored[key] ?? "null"); if (value && typeof value.model === "string") return value.model; } catch { /* not JSON */ }
  }
  return null;
};
if (build.restart) {
  const picked = model(build.restart.prepare.stored);
  build.restart.verdict = {
    modelChanged: Boolean(build.restart.prepare.model?.picked) && build.restart.prepare.model.picked !== build.restart.prepare.model.before,
    isolationKeptOnEachRelaunch: build.restart.checks.length > 0 && build.restart.checks.every(elevated),
    modelKeptOnEachRelaunch: build.restart.checks.length > 0 && picked !== null && build.restart.checks.every((c) => model(c.stored) === picked),
  };
}
if (build.retry) {
  build.retry.verdict = {
    retriesTheProjectFolder: build.retry.retried?.workspacePath === "<project>",
    atTheProjectPosture: build.retry.retried?.sandboxMode === "workspace",
  };
}
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ build: BUILD, phase: PHASE, result: redact(result), verdict: { restart: build.restart?.verdict, retry: build.retry?.verdict } }, null, 2));
