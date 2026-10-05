#!/usr/bin/env node

/**
 * M0-08 native acceptance on the staged engine: the app runs a real
 * conversation on it and its diagnostics name the engine.
 *
 *   1. welcome screen -> project picker option `<projectId>:<rootIndex>`
 *      (read from the option's React key) -> first message -> Start;
 *   2. IPC trace: start_session (workspace, result) and send_input admission;
 *   3. wait for the assistant reply in the persisted log (one billed turn);
 *   4. collect_diagnostics -> hostEngines (version + sha256 fingerprint),
 *      compared with the recorded initialize fixture of that version;
 *   5. --echo-tap: a second host of the same binary with `--provider echo`
 *      (not billed) records the notification methods a turn emits; those the
 *      client's route_notification_with_emit does not route are the additive
 *      notifications this build ignores.
 *
 * Needs a project created by cdp-m2-01-project-roots.mjs setup (or any
 * project with at least rootIndex+1 roots).
 *
 * Usage:
 *   node scripts/cdp-m0-08-engine-run.mjs [--project baseline-m2-01] [--root-index 1]
 *     [--prompt "Reply with just the word BASELINE and nothing else."] [--echo-tap | --echo-tap-only]
 *     [--echo-root G:\muse-proofs\baseline\m0-08-echo]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-08-engine-run-1.4.2.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";
import { connect as mspConnect, createHost, startSession, uuidv7 } from "./msp-probe.mjs";

const PROJECT = argValue("--project", "baseline-m2-01");
const ROOT_INDEX = Number(argValue("--root-index", "1"));
const PROMPT = argValue("--prompt", "Reply with just the word BASELINE and nothing else.");
const MARKER = (PROMPT.match(/word (\w+)/) ?? [])[1] ?? "BASELINE";
const ECHO_ROOT = argValue("--echo-root", "G:\\muse-proofs\\baseline\\m0-08-echo");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-08-engine-run-1.4.2.json");
const BINARY = resolve("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
const FIXTURE = join("src-tauri", "tests", "fixtures", "initialize-1.4.2-R4684.1.json");

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

/** Methods the client routes: the match arms of route_notification_with_emit. */
function routedMethods() {
  const source = readFileSync(join("src-tauri", "src", "main.rs"), "utf8");
  const start = source.indexOf("fn route_notification_with_emit");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return [...new Set([...body.matchAll(/^\s*(?:\|\s*)?"([a-zA-Z]+\/[a-zA-Z/]+)"(?:\s*\|\s*"([a-zA-Z]+\/[a-zA-Z/]+)")*\s*(?:=>|\|)/gm)]
    .flatMap((m) => m[0].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))))].sort();
}

async function echoTap() {
  mkdirSync(ECHO_ROOT, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ECHO_ROOT });
  const host = createHost(BINARY, ECHO_ROOT, ["--provider", "echo"]);
  const tap = { provider: "echo", billed: false };
  try {
    const init = await mspConnect(host);
    tap.serverVersion = init?.serverInfo?.version ?? null;
    tap.schemaFingerprint = init?.schema?.fingerprint ?? null;
    const { sessionId } = await startSession(host, ECHO_ROOT);
    const mark = host.mark();
    const started = await host.request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text: "echo tap" }] });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !host.since(mark).some((e) => e.method === "turn/completed")) await sleep(200);
    await sleep(1_000);
    const events = host.since(mark);
    tap.turnAccepted = Boolean(started);
    tap.terminal = events.find((e) => e.method === "turn/completed")?.params?.terminal ?? null;
    tap.methods = [...new Set(events.map((e) => e.method))].sort();
    tap.allMethodsSinceInitialize = host.methods();
  } catch (error) {
    tap.failure = String(error?.message ?? error).slice(0, 300);
  } finally {
    await host.stop();
  }
  const routed = routedMethods();
  tap.routedByClient = routed;
  tap.ignoredByClient = (tap.allMethodsSinceInitialize ?? []).filter((m) => !routed.includes(m));
  return tap;
}

async function main() {
  const app = await openPage();
  const report = {
    schema: "muse-desktop.m0-08-engine-run.v1",
    ticket: "M0-08",
    date: new Date().toISOString().slice(0, 10),
    commit: gitHead(),
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    engine: execFileSync(BINARY, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(),
    liveTurns: 0,
    prompt: PROMPT,
  };
  let roots = [];
  try {
    await app.ev(INSTALL_IPC_TRACE);
    const project = await app.ev(page(`
      const p = (store('muse-desktop.projects.v1', '[]') || []).find((x) => x.name === ${JSON.stringify(PROJECT)});
      return p ? { id: p.id, roots: p.workspaces || (p.workspace ? [p.workspace] : []) } : null;
    `));
    if (!project || project.roots.length <= ROOT_INDEX) throw new Error(`project ${PROJECT} with root #${ROOT_INDEX} not found`);
    roots = project.roots;
    const wanted = `${project.id}:${ROOT_INDEX}`;

    // 1. Welcome screen and the environment picker.
    await app.ev(page("const n = q('.primary-nav button[aria-label=\"New conversation\"]')[0]; if (n) n.click(); return !!n;"));
    await sleep(1_200);
    report.picker = await app.ev(page(`
      const details = document.querySelector('details.project-picker-control');
      if (!details) return { found: false };
      details.open = true;
      await new Promise((r) => setTimeout(r, 300));
      const options = q('[role="option"].project-option');
      const target = options.find((o) => fiberKey(o) === ${JSON.stringify(wanted)});
      if (!target) return { found: false, keys: options.map(fiberKey) };
      const optionWorkspace = target.querySelector('small')?.textContent || null;
      target.click();
      await new Promise((r) => setTimeout(r, 400));
      return {
        found: true,
        optionId: ${JSON.stringify(wanted)},
        optionWorkspace,
        trigger: (document.querySelector('.project-trigger')?.innerText || '').replace(/\\s+/g, ' ').trim(),
        note: document.querySelector('.welcome-project-note')?.innerText || null,
      };
    `));
    if (!report.picker.found) throw new Error("picker option not found");

    // 2. First message.
    report.send = await app.ev(page(`
      const field = document.querySelector('textarea[aria-label="Your first message"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(PROMPT)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const start = document.querySelector('button.welcome-send');
      const enabled = start && !start.disabled;
      if (enabled) start.click();
      return { clicked: Boolean(enabled) };
    `));
    if (!report.send.clicked) throw new Error("start button disabled");
    report.liveTurns = 1;
    const t0 = Date.now();
    const started = await waitFor(async () => {
      const calls = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.result !== undefined)");
      return calls[0] ?? null;
    }, 90_000);
    const meta = started?.result ? JSON.parse(started.result) : null;
    const sid = meta?.session_id ?? null;
    report.startSession = { workspacePath: started?.args?.workspacePath ?? null, sandboxMode: started?.args?.sandboxMode ?? null, authorizationMode: started?.args?.authorizationMode ?? null, ok: started?.ok ?? null, sessionDurability: meta?.session_durability ?? null, ms: Date.now() - t0 };

    // 3. The turn: admission, then the reply in the persisted log.
    const reply = await waitFor(() => app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];
      const hit = log.find((e) => e.role === 'assistant' && /${MARKER}/.test(e.text || ''));
      const health = document.querySelector('.stream-health');
      const working = health ? /is working|starting/i.test(health.innerText) : false;
      return hit && !working ? { text: String(hit.text).slice(0, 80), entries: log.length, roles: log.map((e) => e.role) } : null;
    `)), 180_000, 1_000);
    report.turn = { replied: reply !== null, ...(reply ?? {}), msFromStart: Date.now() - t0 };
    const sendCall = await app.ev("window.__baselineIpc.calls.find((c) => c.cmd === 'send_input') || null");
    report.turn.sendInput = sendCall ? { ok: sendCall.ok, result: sendCall.result?.slice(0, 200) ?? null } : null;
    report.ui = await app.ev(page(`
      const health = document.querySelector('.stream-health');
      const banner = q('.error, [role="alert"]').map((n) => n.innerText.trim()).filter(Boolean).slice(0, 3);
      return { health: health ? health.innerText.replace(/\\s+/g, ' ').slice(0, 120) : null, alerts: banner };
    `));
    report.project = await app.ev(page(`
      const tp = store('muse-desktop.thread-projects.v1', '{}') || {};
      const s = (store('muse-desktop.sessions.v1', '[]') || []).find((x) => x.session_id === ${JSON.stringify(sid)});
      return { attachedToProject: tp[${JSON.stringify(sid)}] === ${JSON.stringify(project.id)}, sessionWorkspace: s ? s.workspace : null };
    `));

    // 4. Native diagnostics export.
    const diagnostics = await app.ev("window.__TAURI_INTERNALS__.invoke('collect_diagnostics')");
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const fixtureFingerprint = (fixture.result ?? fixture).schema?.fingerprint ?? null;
    report.diagnostics = diagnostics;
    report.fixtureFingerprint = fixtureFingerprint;

    if (process.argv.includes("--echo-tap")) report.echoTap = await echoTap();

    const engines = diagnostics?.hostEngines ?? [];
    report.verdict = {
      pickerProjectRootIndex: report.picker.optionId === wanted,
      sessionStartedInChosenRoot: report.startSession.workspacePath === roots[ROOT_INDEX] && report.startSession.ok === true,
      attachedToProject: report.project.attachedToProject,
      liveTurnCompleted: report.turn.replied,
      hostEngine142: engines.some((e) => e.serverVersion === "1.4.2" && /^sha256:[0-9a-f]{64}$/.test(e.schemaFingerprint)),
      fingerprintMatchesFixture: engines.some((e) => e.schemaFingerprint === fixtureFingerprint),
      consoleErrors: app.errors.length,
      ignoredAdditiveNotifications: report.echoTap?.ignoredByClient ?? null,
    };
  } catch (error) {
    report.failure = String(error?.message ?? error).slice(0, 400);
  } finally {
    report.consoleErrors = app.errors.slice(0, 20);
    app.close();
  }
  const redact = redactor([...roots.map((root, index) => [root, `<root ${"ABCDEFGH"[index]}>`]), [ECHO_ROOT, "<echo root>"]]);
  const record = redact(report);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record.verdict ?? record, null, 2)}\n`);
}

/** Re-run only the non-billed echo tap and merge it into an existing record. */
async function echoTapOnly() {
  const record = JSON.parse(readFileSync(OUT, "utf8"));
  record.echoTap = redactor([[ECHO_ROOT, "<echo root>"]])(await echoTap());
  record.verdict = { ...record.verdict, ignoredAdditiveNotifications: record.echoTap.ignoredByClient };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record.echoTap, null, 2)}\n`);
}

if (process.argv.includes("--echo-tap-only")) await echoTapOnly();
else await main();
