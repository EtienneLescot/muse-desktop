#!/usr/bin/env node
/**
 * M0-06, decision of 06/10/2026: a project follows the Isolation level chosen
 * in Settings unless its own preferences restrict it. No model turn: every
 * conversation is started with no message, from the project's row.
 *
 * On the isolated app only (test mode, ADR 0003). Launch it from PowerShell:
 *   $env:MUSE_DESKTOP_TEST_DATA_DIR='G:\muse-proofs\project-isolation\appdata-1'
 *   $env:MUSE_DESKTOP_TEST_SIDECAR='["<repo>/src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe"]'
 *   $env:MUSE_DESKTOP_TEST_CDP_PORT='9335'; $env:MUSE_NO_AUTO_UPDATE='1'
 *   (no WEBVIEW2_* variable) Start-Process <muse-desktop.exe> -PassThru
 * then, once <data dir>\test-mode.pid exists:
 *   MUSE_CDP_PORT=9335 node scripts/cdp-m0-06-project-follows-global.mjs --build before|after
 *     --commit <sha> --exe <muse-desktop.exe> --test-data <data dir> --base <proof folder>
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-06-project-follows-global.json]
 *
 * Steps, in one fresh profile: "Workspace and network" granted and selected, a
 * project with no override, a conversation in it; then "Elevated access"; then
 * the project's Isolation "No Elevated access"; then its Network "No network"
 * alone; then its Isolation "Read only" alone. After each, the argv the OS runs
 * for the project's engine (a child of the app). When a running engine has
 * another posture, the start is refused and the error banner's "Restart
 * workspace host" restarts it, the confirmation answered by the harness. Last,
 * the project's folder becomes the default folder and Settings' "Restart
 * workspace host" restarts it. The record is path-free.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, openPage, redactor, sleep, under, waitFor, webviewProfile } from "./cdp-harness.mjs";

const BUILD = argValue("--build", "after");
const EXE = argValue("--exe", null);
const TEST_DATA = argValue("--test-data", null);
const BASE = argValue("--base", "G:\\muse-proofs\\project-isolation\\run");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-06-project-follows-global.json");
const COMMIT = argValue("--commit", null);
const PROJECT = "m06-follows-global";
const ROOT = join(BASE, "proj");
if (!EXE || !TEST_DATA || !COMMIT) {
  process.stderr.write("pass --exe, --test-data and --commit\n");
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
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const row = () => q('li.project-item').find((li) => li.querySelector('.project-name')?.innerText.trim() === ${JSON.stringify(PROJECT)});
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/** A confirmation is a `plugin:dialog|message` IPC call: answered "Ok" here, and counted. */
const ANSWER_CONFIRMS = `(() => {
  if (window.__confirms) return 'already';
  window.__confirms = [];
  const inner = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const m = url.match(/^https?:\\/\\/ipc\\.localhost\\/([^/?#]+)/);
    if (m && decodeURIComponent(m[1]) === 'plugin:dialog|message') {
      window.__confirms.push(String((init && init.body) || '').slice(0, 300));
      return new Response(JSON.stringify('Ok'), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
    }
    return inner(input, init);
  };
  return 'installed';
})()`;

const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})
  .map((c) => ({ args: c.args, ok: c.ok, result: c.result === undefined ? undefined : String(c.result).slice(0, 600) }))`);
const posture = (args) => ({ sandboxMode: args?.sandboxMode ?? null, disableWrite: args?.sandboxDisableWrite ?? null, disableShell: args?.sandboxDisableShell ?? null });
/** A refused command answers its error as a JSON string. */
const refusal = (call) => { try { return String(JSON.parse(call?.result)).slice(0, 300); } catch { return String(call?.result ?? "no answer").slice(0, 300); } };

/** The app's engines as the OS runs them (its `serve` children): pid -> argv, the exe redacted. */
function engines() {
  const pid = Number(readFileSync(join(TEST_DATA, "test-mode.pid"), "utf8").trim());
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CommandLine -match ' serve( |$)' } | ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }`],
  { encoding: "utf8" });
  return Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, cmd] = line.split("|");
    return [id, cmd.replace(/^("[^"]*"|\S+)/, "<engine>").trim()];
  }));
}
const spawnedSince = (before) => Object.entries(engines()).filter(([id]) => !(id in before)).map(([, argv]) => argv);

const openSettings = (app) => app.ev(page("const b = q('button').find((n) => /^Settings$/i.test((n.getAttribute('aria-label') || n.innerText || '').trim())); if (b) b.click(); return !!b;"));

/** Settings > Isolation, picked like a user does (picking a level grants it). */
async function setIsolation(app, label) {
  await openSettings(app);
  await sleep(1_200);
  return app.ev(page(`
    const l = q('[role="radiogroup"][aria-label="Isolation"] label').find((x) => x.querySelector('strong')?.innerText.trim() === ${JSON.stringify(label)});
    if (!l) return { clicked: false };
    l.querySelector('input').click();
    await new Promise((r) => setTimeout(r, 600));
    const group = q('.settings-group').find((g) => g.querySelector('h3')?.innerText.trim() === 'Isolation');
    return { clicked: true, stored: store('muse-desktop.settings.v1', 'null'), note: group?.querySelector('.settings-note')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      levels: q('[role="radiogroup"][aria-label="Isolation"] label').map((x) => x.innerText.replace(/\\s+/g, ' ').trim()),
      current: group?.querySelector('.authorization-status')?.innerText.replace(/\\s+/g, ' ').trim() ?? null };
  `));
}

/** The project's folder as Settings' default folder, then Settings' "Restart workspace host", confirmed. */
async function settingsRestart(app) {
  await openSettings(app);
  await sleep(1_200);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOT)}), true)`);
  const picked = await app.ev(page("const b = q('button.workspace-button')[0]; if (!b) return false; b.click(); return true;"));
  await sleep(1_000);
  const n = (await ipc(app, "restart_host")).length;
  const before = engines();
  const clicked = await app.ev(page("const b = q('.settings-host-restart button').find((x) => /Restart workspace host/.test(x.innerText)); if (!b) return false; b.click(); return true;"));
  if (!picked || !clicked) return { picked, clicked };
  const call = await waitFor(async () => {
    const calls = await ipc(app, "restart_host");
    return calls.length > n && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
  const spawned = await waitFor(() => { const s = spawnedSince(before); return s.length > 0 ? s : null; }, 30_000);
  return { picked, clicked, requested: posture(call?.args), ok: Boolean(call?.ok), ...(call?.ok ? {} : { error: refusal(call) }),
    engine: spawned ? spawned.join(" | ") : null, running: Object.values(engines()) };
}

async function openRow(app) {
  const open = await app.ev(page(`
    const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click();
    await new Promise((r) => setTimeout(r, 800));
    const r = row(); if (!r) return false;
    r.querySelector('details').open = true;
    await new Promise((r) => setTimeout(r, 400));
    return true;
  `));
  if (!open) throw new Error("project row not found");
}

/** The row's preferences as shown: label, selected choice, choices; and the note under them. */
async function preferences(app) {
  await openRow(app);
  return app.ev(page(`return { rows: [...row().querySelectorAll('.project-settings label.project-setting')].map((l) => {
    const s = l.querySelector('select');
    return { label: l.querySelector('span')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      selected: s ? s.selectedOptions[0]?.text ?? null : null, choices: s ? [...s.options].map((o) => o.text) : null };
  }), note: row().querySelector('.project-settings > small')?.innerText.replace(/\\s+/g, ' ').trim() ?? null };`));
}

/**
 * One isolation preference in the row: "network" or "isolation", to a stored
 * value, or `null` for the default (the new "Follow Settings" option, the old
 * select's global value).
 */
async function setPreference(app, which, value) {
  await openRow(app);
  const labels = which === "network" ? ["Project network"] : ["Project isolation", "Project sandbox"];
  return app.ev(page(`
    const s = ${JSON.stringify(labels)}.map((l) => row().querySelector('select[aria-label^="' + l + '"]')).find(Boolean);
    if (!s) return { select: false };
    const values = [...s.options].map((o) => o.value);
    const target = ${JSON.stringify(value)} ?? (values.includes('') ? '' : ${JSON.stringify(which === "network" ? "prompt" : "workspace")});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, target);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { select: true, value: s.value, override: (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT)})?.settings ?? null };
  `));
}

/** The row's "New conversation here": a conversation with no message. */
async function startHere(app) {
  const n = (await ipc(app, "start_session")).length;
  const before = engines();
  await openRow(app);
  const clicked = await app.ev(page("const b = button('New conversation here', row()); if (!b || b.disabled) return false; b.click(); return true;"));
  if (!clicked) throw new Error('no "New conversation here"');
  const call = await waitFor(async () => {
    const calls = await ipc(app, "start_session");
    return calls.length > n && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
  await sleep(1_500);
  const spawned = spawnedSince(before);
  return { requested: posture(call?.args), ok: Boolean(call?.ok), ...(call?.ok ? {} : { error: refusal(call) }),
    engine: spawned.length > 0 ? spawned.join(" | ") : "reused the running engine" };
}

/** The error banner's "Restart workspace host", confirmed; the engine it starts. */
async function restartFromBanner(app) {
  const n = (await ipc(app, "restart_host")).length;
  const before = engines();
  const clicked = await app.ev(page("const b = q('button.error-banner-action').find((x) => /Restart workspace host/.test(x.innerText)); if (!b) return false; b.click(); return true;"));
  if (!clicked) return { offered: false };
  const call = await waitFor(async () => {
    const calls = await ipc(app, "restart_host");
    return calls.length > n && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, 90_000);
  const spawned = await waitFor(() => { const s = spawnedSince(before); return s.length > 0 ? s : null; }, 30_000);
  return { offered: true, confirmed: await app.ev("window.__confirms.length"), requested: posture(call?.args), ok: Boolean(call?.ok),
    ...(call?.ok ? {} : { error: refusal(call) }), engine: spawned ? spawned.join(" | ") : null };
}

/** Start in the project; a refused start restarts the project's engine from the banner, then starts again. */
async function step(app, name, isolation) {
  const result = { step: name, isolation, override: await app.ev(page(`return (store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT)})?.settings ?? {};`)) };
  result.start = await startHere(app);
  if (!result.start.ok) {
    result.restart = await restartFromBanner(app);
    result.startAfterRestart = await startHere(app);
  }
  result.running = Object.values(engines());
  return result;
}

const app = await openPage();
const profile = webviewProfile();
if (!profile || !under(profile, TEST_DATA)) {
  app.close();
  throw new Error("the WebView2 profile is not under the test data folder: stopping before any action");
}
await app.ev(INSTALL_IPC_TRACE);
await app.ev(ANSWER_CONFIRMS);
mkdirSync(ROOT, { recursive: true });

const run = { commit: COMMIT, exeSha256: createHash("sha256").update(readFileSync(EXE)).digest("hex"), date: new Date().toISOString().slice(0, 10),
  profileUnderTestData: true, steps: [] };
run.grantNetwork = await setIsolation(app, "Workspace and network");
const projects = await app.ev(page("return store('muse-desktop.projects.v1', '[]') || [];"));
if (!projects.some((p) => p.name === PROJECT)) {
  await app.ev(page("const b = q('button.sidebar-manage').find((n) => /Manage projects/.test(n.innerText)); if (b) b.click(); return !!b;"));
  await waitFor(() => app.ev(page("return Boolean(document.querySelector('.projects-panel'));")), 10_000);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(ROOT)}), true)`);
  run.projectCreated = await app.ev(page(`
    setValue(q('input[aria-label="Project name"]')[0], ${JSON.stringify(PROJECT)});
    button('Choose project folders').click();
    await new Promise((r) => setTimeout(r, 800));
    button('+ Add project').click();
    await new Promise((r) => setTimeout(r, 800));
    return Boolean((store('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${JSON.stringify(PROJECT)}));
  `));
}
run.preferencesShown = await preferences(app);
run.steps.push(await step(app, "no override", "Workspace and network"));
run.grantElevated = await setIsolation(app, "Elevated access");
run.steps.push(await step(app, "no override", "Elevated access"));
// The old select read "workspace" as its global value and cleared it.
run.setNoElevated = await setPreference(app, "isolation", "workspace");
run.steps.push(await step(app, "Isolation: no Elevated access", "Elevated access"));
run.clearIsolation = await setPreference(app, "isolation", null);
run.setNoNetwork = await setPreference(app, "network", "deny");
run.steps.push(await step(app, "Network: no network", "Elevated access"));
run.clearNetwork = await setPreference(app, "network", null);
run.setReadOnly = await setPreference(app, "isolation", "read-only");
run.steps.push(await step(app, "Isolation: read only", "Elevated access"));
run.preferencesShownAtEnd = await preferences(app);
run.settingsRestart = await settingsRestart(app);
run.errors = app.errors.slice(0, 5);
app.close();

const argv = (s) => (s?.running ?? []).join(" | ");
const [network, elevated, noElevated, noNetwork, readOnly] = run.steps;
const networkRow = run.preferencesShownAtEnd.rows.find((r) => r.label === "Network");
run.verdict = BUILD === "before"
  ? {
      restrictedAtEveryLevel: run.steps.every((s) => argv(s).includes("--sandbox-network restricted") && !argv(s).includes("--disable-sandbox")),
      settingsRestartLiftsReadOnly: argv(run.settingsRestart).includes("--disable-sandbox"),
    }
  : {
      followsWorkspaceAndNetwork: argv(network).includes("--sandbox-network enabled") && !argv(network).includes("--disable-sandbox"),
      followsElevated: argv(elevated).includes("--disable-sandbox"),
      noElevatedRestricts: argv(noElevated).includes("--sandbox-network enabled") && !argv(noElevated).includes("--disable-sandbox"),
      noNetworkRestricts: argv(noNetwork).includes("--sandbox-network restricted") && !argv(noNetwork).includes("--disable-sandbox"),
      readOnlyRestricts: ["--sandbox-network restricted", "--disable-write", "--disable-shell"].every((flag) => argv(readOnly).includes(flag)),
      restartedThroughTheBanner: [elevated, noElevated, noNetwork, readOnly].every((s) => s.restart?.ok && s.startAfterRestart?.ok),
      conflictInWords: [elevated, noElevated, noNetwork, readOnly].every((s) =>
        /^This folder's engine is running with [A-Z][^;]+; restart it to apply [A-Z][^.]+\.$/.test(s.start.error ?? "")),
      followLabelIsTheLevelRun: networkRow?.selected === "Follow Settings (Workspace only)",
      runningEngineNoteShown: /a running engine keeps its posture until it restarts/.test(run.preferencesShownAtEnd.note ?? ""),
      noGHint: run.preferencesShown.rows.every((r) => !/\bg:/.test(r.label ?? "")),
      elevatedSaysGlobal: run.grantElevated.levels.some((l) => l.includes("It reaches every project that does not restrict it.")),
      currentIsolationInWords: run.grantElevated.current === "Current isolation: Elevated access",
      settingsRestartKeepsTheProjectPosture: run.settingsRestart.requested?.disableWrite === true
        && ["--disable-write", "--disable-shell"].every((flag) => argv(run.settingsRestart).includes(flag)),
    };

let record;
try { record = JSON.parse(readFileSync(OUT, "utf8")); } catch {
  record = {
    schema: "muse-desktop.m0-06-project-follows-global.v1",
    tickets: ["M0-06"],
    decision: "06/10/2026: a project follows the global Isolation level unless its own preferences restrict it",
    platform: "Windows 11 (26200), debug build with embedded frontend, isolated test mode (ADR 0003), WebView2 over CDP",
    liveTurns: 0,
    builds: {},
  };
}
try {
  record.engine = execFileSync(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"), ["--version"],
    { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
} catch { /* keeps the previous value */ }
record.builds[BUILD] = redact(run);
const before = record.builds.before;
const after = record.builds.after;
if (before && after) {
  record.table = [
    ...before.steps.map((s, i) => ({ isolation: s.isolation, project: s.step, before: s.running.join(" | "), after: after.steps[i]?.running.join(" | ") ?? null })),
    { isolation: "Elevated access", project: "Isolation: read only, its folder restarted from Settings",
      before: before.settingsRestart?.running?.join(" | ") ?? null, after: after.settingsRestart?.running?.join(" | ") ?? null },
  ];
}
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ build: BUILD, verdict: run.verdict, running: run.steps.map((s) => s.running) }, null, 2));
