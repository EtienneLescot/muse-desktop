#!/usr/bin/env node

/**
 * M0-14 end-to-end check on the real app (ADR 0003). The debug build runs in
 * its isolated test mode against the deterministic Muse fixture
 * (scripts/muse-fixture.mjs) and is driven over CDP. Nothing is built here:
 * run `npm run build`, then `cargo build --manifest-path src-tauri/Cargo.toml`.
 *
 *   ab    projects A and B (temp folders), a turn and an approval card in
 *         each; deciding A's card reaches A only, B stays pending and intact.
 *   send  B's host dies on a turn/start before answering (`[fixture:exit]`):
 *         the text is still in the transcript or the outbox, and on screen.
 *
 * Isolation: MUSE_DESKTOP_TEST_DATA_DIR (app data and WebView2 profile) is a
 * fresh temp folder and MUSE_DESKTOP_TEST_SIDECAR runs the fixture, so the
 * user's profile and engine are never touched; MUSE_DESKTOP_TEST_CDP_PORT
 * opens CDP. No WEBVIEW2_* variable reaches the app. Before driving anything
 * the runner checks that the exe reads the switch, that the app wrote its
 * test-mode marker and that the WebView2 browser runs on the test profile;
 * otherwise it kills the app. Windows only: CDP needs WebView2.
 *
 * Usage: npm run e2e:fixture [-- --exe <muse-desktop.exe>] [--keep]
 * Prints the verdict as JSON; exit code 1 when any check fails, or when the
 * watchdog stops a run that hangs.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A port of its own: never attach to a developer's CDP-enabled app on 9222.
process.env.MUSE_CDP_PORT ??= "9339";
const { INSTALL_IPC_TRACE, argValue, openPage, redactor, sleep, waitFor } = await import("./cdp-harness.mjs");

const PORT = Number(process.env.MUSE_CDP_PORT);
const EXE = resolve(argValue("--exe", join(process.env.CARGO_TARGET_DIR ?? join("src-tauri", "target"), "debug", "muse-desktop.exe")));
const FIXTURE = fileURLToPath(new URL("./muse-fixture.mjs", import.meta.url));
const DONE = "the fixture turn resumed successfully";
// test_mode.rs: the variable only a test-mode build reads, and the file its enter() writes.
const SWITCH = "MUSE_DESKTOP_TEST_DATA_DIR";
const MARKER = "test-mode.pid";
// The CI step stops at 8 minutes (ci.yml, e2e-windows): the verdict prints before.
const WATCHDOG_MS = 6 * 60_000;

/** A diagnostic command's bounded output; never throws. */
function run(cmd, args, max = 600) {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 20_000 }).trim().slice(0, max); } catch (error) { return `failed: ${String(error?.message ?? error).slice(0, 200)}`; }
}

/** Command lines of the WebView2 browser processes (child processes carry --type=). */
const browserCommandLines = () => run("powershell", ["-NoProfile", "-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine }"], 200_000);

/** The --user-data-dir of the WebView2 browser that serves CDP on PORT. */
function webviewProfile() {
  const line = browserCommandLines().split(/\r?\n/).find((entry) => entry.includes(`--remote-debugging-port=${PORT}`));
  const flag = line?.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
  return flag ? flag[1] ?? flag[2] : null;
}

/** Whether `path` is inside `dir`, both resolved on disk (short names, case). */
function under(path, dir) {
  try {
    const rel = relative(realpathSync.native(dir), realpathSync.native(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** A CDP call that has not settled in `ms` fails instead of hanging the run. */
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms).unref();
})]);

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (probe, ms = 5000) => { for (let t = 0; t < ms && !probe(); t += 100) await wait(100); return probe(); };
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
  const cards = () => q('.approvals .approval').map((card) => fiberKey(card));
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
/** The host's pending approvals for one conversation, through the real bridge. */
const pending = async (app, sid) => (await invoke(app, "list_pending_requests", { sessionId: sid }))?.approvals ?? [];
const transcript = (app, sid) => app.ev(page(`return (store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '') }));`));
const finished = async (app, sid) => (await transcript(app, sid)).some((e) => e.role === "assistant" && e.text.includes(DONE));
const calls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)})`);

/** Welcome screen -> "New project from a folder…" (dialog answered) -> first message. */
async function startIn(app, folder, text) {
  const before = (await calls(app, "start_session")).length;
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  const outcome = await app.ev(page(`
    q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
    const picker = await until(() => document.querySelector('details.project-picker-control'));
    if (!picker) return 'no project picker';
    picker.open = true;
    (await until(() => document.querySelector('.project-option-new')))?.click();
    const name = ${JSON.stringify(basename(folder))};
    const note = await until(() => (document.querySelector('.welcome-project-note')?.innerText || '').includes(name));
    if (!note) return 'project not selected: ' + (document.querySelector('.welcome-project-note')?.innerText || '');
    setValue(document.querySelector('textarea[aria-label="Your first message"]'), ${JSON.stringify(text)});
    const start = await until(() => { const b = document.querySelector('button.welcome-send'); return b && !b.disabled ? b : null; });
    if (!start) return 'start disabled';
    start.click();
    return 'started';
  `));
  if (outcome !== "started") throw new Error(`could not start in ${basename(folder)}: ${outcome}`);
  const started = await waitFor(async () => {
    const list = await calls(app, "start_session");
    return list.length > before && list.at(-1).result !== undefined ? list.at(-1) : null;
  }, 60_000);
  const sid = started?.ok ? JSON.parse(started.result).session_id : null;
  if (!sid) throw new Error(`start_session in ${basename(folder)} failed: ${started?.result ?? "no answer"}`);
  return sid;
}

async function select(app, sid) {
  const opened = await app.ev(page(`
    document.querySelector('li.session-item[data-session-id="' + ${JSON.stringify(sid)} + '"] button.session-select')?.click();
    return until(() => activeSid() === ${JSON.stringify(sid)}, 10000);
  `));
  if (!opened) throw new Error(`could not open conversation ${sid}`);
  await sleep(500);
}

/** Click "Allow once" on the card of the open conversation; returns that card's key. */
const allowOnce = (app) => app.ev(page(`
  const card = await until(() => q('.approvals .approval')[0], 10000);
  const allow = card ? q('.approval-actions button', card).find((b) => b.innerText.trim() === 'Allow once') : null;
  if (!allow) return null;
  allow.click();
  return fiberKey(card);
`));

async function scenario(app, dirs, report) {
  const verdict = report.verdict;
  await waitFor(() => app.ev(page(`return q('.primary-nav button[aria-label="New conversation"]').length > 0;`)), 60_000, 500);
  await app.ev(INSTALL_IPC_TRACE);

  // ab: a turn and a card in each project.
  const a = await startIn(app, dirs.A, "Turn in project A");
  const cardA = await waitFor(async () => (await pending(app, a))[0] ?? null, 30_000);
  const b = await startIn(app, dirs.B, "Turn in project B");
  const cardB = await waitFor(async () => (await pending(app, b))[0] ?? null, 30_000);
  verdict.abCardPendingInEach = Boolean(cardA && cardB) && cardA.approvalId !== cardB.approvalId;
  if (!verdict.abCardPendingInEach) throw new Error("no approval card in each project");

  // Decide A's card from A's conversation; every decision from here on is traced.
  await app.ev(INSTALL_IPC_TRACE);
  await select(app, a);
  report.clickedA = await allowOnce(app);
  const aDone = await waitFor(async () => (await pending(app, a)).length === 0 && (await finished(app, a)), 20_000);
  const decided = (await calls(app, "approve")).map((c) => c.args?.sessionId);
  verdict.abDecidingAReachesOnlyA = report.clickedA === `${a}:${cardA.approvalId}` && Boolean(aDone)
    && decided.length > 0 && decided.every((sid) => sid === a);

  const bNow = await pending(app, b);
  await select(app, b);
  const bCards = await app.ev(page("return cards();"));
  verdict.abBStillPendingAndIntact = bNow.length === 1 && bNow[0].approvalId === cardB.approvalId
    && JSON.stringify(bNow[0].currentRequirementId) === JSON.stringify(cardB.currentRequirementId)
    && !(await finished(app, b)) && bCards.length === 1 && bCards[0] === `${b}:${cardB.approvalId}`;

  // B is still decidable on its own.
  report.clickedB = await allowOnce(app);
  verdict.abBDecidedAfterwards = Boolean(await waitFor(async () => (await pending(app, b)).length === 0 && (await finished(app, b)), 20_000));

  // send: B's host dies before answering this turn/start.
  const shown = `keep this text ${Date.now().toString(36)}`;
  const text = `[fixture:exit] ${shown}`;
  report.send = await app.ev(page(`
    const field = await until(() => document.querySelector('textarea[aria-label="Message Muse"]'));
    if (!field) return 'no composer';
    setValue(field, ${JSON.stringify(text)});
    const send = await until(() => { const b = document.querySelector('button.send'); return b && !b.disabled ? b : null; });
    if (!send) return 'send disabled';
    send.click();
    return 'sent';
  `));
  const settled = await waitFor(async () => (await calls(app, "send_input"))
    .find((c) => String(c.args?.text ?? "").includes(text) && c.result !== undefined) ?? null, 30_000);
  await sleep(1_500);
  verdict.sendHostFailureForced = settled?.ok === false;
  const kept = await app.ev(page(`
    const has = (rows) => (rows || []).some((e) => String(e.text || '').includes(${JSON.stringify(text)}));
    // What the user sees: the bubble, or the unsent row under the transcript.
    const onScreen = await until(() => q('.msg.user, .pending-send-text').some((n) => n.innerText.includes(${JSON.stringify(shown)})));
    return { transcript: has(store('muse-desktop.log.v1.' + ${JSON.stringify(b)}, '[]')),
      outbox: has(store('muse-desktop.outbox.v1.' + ${JSON.stringify(b)}, '[]')),
      onScreen, ...(onScreen ? {} : { lastRows: q('.msg, .pending-send').slice(-3).map((n) => n.innerText.slice(0, 80)) }) };
  `));
  const ledger = join(dirs.data, "outbox", "outbox.json");
  kept.nativeOutbox = existsSync(ledger) && readFileSync(ledger, "utf8").includes(text);
  report.sendKeptIn = kept;
  verdict.sendNeverLost = kept.transcript || kept.outbox || kept.nativeOutbox;
  verdict.sendTextOnScreen = kept.onScreen;
  verdict.otherHostUnaffected = await pending(app, a).then(() => true, () => false);

  verdict.isolatedWebviewProfile = existsSync(join(dirs.data, "WebView2", "EBWebView"));
  verdict.isolatedAppData = readdirSync(dirs.data).some((name) => name !== "WebView2" && name !== MARKER);
}

/** What the runner can tell when the app does not answer: bounded, path-free once redacted. */
async function diagnose(dirs) {
  const browser = browserCommandLines().slice(0, 20_000);
  return {
    webview2Runtime: run("reg", ["query", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "/v", "pv"]),
    webviewProcesses: run("tasklist", ["/FI", "IMAGENAME eq msedgewebview2.exe", "/FO", "CSV", "/NH"]).split("\n").length,
    browserFlags: browser.match(/--(remote-debugging|user-data-dir|disable-features|embedded-browser)[^ ]*/g) ?? browser.slice(0, 300),
    listening: run("netstat", ["-ano", "-p", "TCP"], 200_000).split("\n").filter((line) => line.includes(`:${PORT} `)).map((line) => line.trim()),
    cdpTargets: await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json())
      .then((list) => list.map((t) => `${t.type} ${t.url}`.slice(0, 120)))
      .catch((error) => `unreachable: ${error?.cause?.code ?? error?.message ?? error}`),
    dataDir: existsSync(dirs.data) ? readdirSync(dirs.data) : null,
  };
}

async function main() {
  if (process.platform !== "win32") throw new Error("this check drives WebView2 over CDP: Windows only (ADR 0003)");
  if (!existsSync(EXE)) throw new Error(`no app at ${EXE}: run cargo build --manifest-path src-tauri/Cargo.toml (or pass --exe)`);
  // A release build, or a debug build without the test mode, would run on the
  // user's own profile and engine: only an exe that reads the switch starts.
  if (!readFileSync(EXE).includes(SWITCH)) throw new Error(`${EXE} has no test mode (release build?): refusing to start it`);
  // Taken when something answers, or accepts and never answers.
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  const root = mkdtempSync(join(tmpdir(), "muse-e2e-"));
  const dirs = { data: join(root, "data"), A: join(root, "project-a"), B: join(root, "project-b") };
  for (const dir of [dirs.data, dirs.A, dirs.B]) mkdirSync(dir);
  const report = { schema: "muse-desktop.e2e-fixture.v1", verdict: {} };
  const output = [];
  // No WEBVIEW2_* variable reaches the app: its profile and flags are the test mode's alone.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^WEBVIEW2_/i.test(name)));
  const started = Date.now();
  const child = spawn(EXE, [], {
    env: {
      ...env,
      [SWITCH]: dirs.data,
      MUSE_DESKTOP_TEST_SIDECAR: JSON.stringify([process.execPath, FIXTURE]),
      // Through the WebView2 options: an elevated runner ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
      MUSE_DESKTOP_TEST_CDP_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    output.splice(0, output.length - 80);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  // A failed spawn is reported by the marker wait, not by a crash of the runner.
  child.once("error", (error) => keep(`spawn failed: ${error.message}`));
  const kill = () => {
    if (child.exitCode !== null) return;
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 20_000 }); } catch { /* already gone */ }
  };
  const print = () => {
    const values = Object.values(report.verdict);
    report.passed = !report.failure && values.length > 0 && values.every((value) => value === true);
    if (!report.passed) report.appOutputTail = output;
    return new Promise((done) => process.stdout.write(`${JSON.stringify(redactor([[root, "<e2e>"]])(report), null, 2)}\n`, done));
  };
  // A hang still ends with a verdict: stop the app, print, fail.
  const watchdog = setTimeout(async () => {
    report.failure = `watchdog: no verdict after ${WATCHDOG_MS / 60_000} minutes`;
    kill();
    await print();
    process.exit(1);
  }, WATCHDOG_MS);
  let app = null;
  try {
    // enter() writes its pid at startup: without it the app is not in test
    // mode and may be on the user's profile, so it goes at once.
    const marker = join(dirs.data, MARKER);
    const entered = await waitFor(() => {
      try { return readFileSync(marker, "utf8").trim() === String(child.pid); } catch { return false; }
    }, 10_000, 100);
    if (!entered) {
      kill();
      throw new Error(`no ${MARKER} within 10 s (exit code ${child.exitCode}): the app is not in test mode, stopped`);
    }
    report.markerMs = Date.now() - started;
    // A cold runner creates the WebView2 profile first: give it time.
    app = await waitFor(() => (child.exitCode === null ? withTimeout(openPage(), 15_000, "CDP page").catch(() => null) : "exited"), 120_000, 1_000);
    if (!app || app === "exited") throw new Error(`the app exposed no page on CDP ${PORT} (exit code ${child.exitCode})`);
    // Before driving anything: the browser runs on the test profile. An HKLM
    // WebView2 policy, honoured even for an elevated host, could move it.
    report.webviewProfile = webviewProfile();
    if (!under(report.webviewProfile, dirs.data)) {
      kill();
      throw new Error("the WebView2 browser is not on the test profile: stopped before driving the app");
    }
    await scenario(app, dirs, report);
  } catch (error) {
    report.failure = String(error?.message ?? error).slice(0, 400);
    report.diagnostics = await diagnose(dirs);
  } finally {
    report.consoleErrors = app?.errors?.slice(0, 20) ?? [];
    app?.close?.();
    kill();
    await sleep(1_000);
    if (!process.argv.includes("--keep")) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* a temp folder */ }
    }
  }
  clearTimeout(watchdog);
  await print();
  // Exit now: a CDP socket opened after its timeout would keep the process alive.
  process.exit(report.passed ? 0 : 1);
}

await main();
