#!/usr/bin/env node

/**
 * M0-05 complement (06/10/2026), native on Windows with Muse 1.4.2: the open
 * items of an adversarial check of m0-05-questions.json and
 * m0-05-06-approvals.json. Each test conversation runs in its own folder under
 * --base (P pre-fix questions, Q questions, A approvals); every phase refuses
 * to act unless that conversation is the active one and runs in that folder.
 *
 * Phases (results merge into --out, path-free, keyed by phase):
 *   launch      the isolated instance (below) on a fresh data folder:
 *               --exe <file in --bin> --build prefix|fixed. No turn.
 *   relaunch    the same data folder (a restart), the same exe unless --exe
 *               names another (an upgrade). No turn.
 *   probe       no turn. Page selectors, and the invoke counter.
 *   p-double / q-double   1 turn. (1) A single-choice question; a real CDP
 *               double-click on Send answer. answer_input counted on
 *               __TAURI_INTERNALS__.invoke (see countInvokes) and on the IPC
 *               transport (window.fetch); the clicks the card received; the
 *               banner; the question's transcript line, shown and stored.
 *               q-double first reloads the window with the question pending
 *               (5): the boot read and the cards, while the host still lists
 *               the question of a dead turn (msp-orphan-prompt.mjs, before and
 *               after).
 *   p-restart / q-restart 1 turn. (2) A question pending, the app closed from
 *               its window, relaunched on the same data folder, the
 *               conversation reopened: cards, transcript, the app's own
 *               pending read, the events of the resume (poll_events ring),
 *               and whether it still shows a running turn a minute later.
 *   stale       no turn. That liveness read again (--conv p|q).
 *   a-reload    1 turn. (4) Ask posture, the reliable PowerShell prompt: the
 *               card against the host's choices, a window reload rebuilds it,
 *               every stage the host presents decided Allow once, the end.
 *   a-death     1 turn. (3) An approval card open, only A's engine killed (the
 *               app's child whose working directory is A's folder): card,
 *               transcript, the reconnection (the app's own when A was started
 *               in this run, else the Reconnect button), no card coming back.
 *   a-death-trace  no turn, no action: a-death's reconnection read from the
 *               page's own trace, for the run that looked for the button.
 *   a-reconnect no turn. After a relaunch (A resumed at boot): A's idle engine
 *               killed, the Reconnect button clicked.
 *   stop        the instance closed from its window (WM_CLOSE). No turn.
 *   summary     no app: per-item verdicts derived from the stored phases.
 *   rederive    no app: a-reload's stage verdict from its stored stages.
 *
 * The isolated test mode (ADR 0003) only: a fresh data folder per launch
 * under --base, no WEBVIEW2_* variable, the staged engine as the only local
 * engine, CDP on MUSE_CDP_PORT (9333). The harness refuses an exe without the
 * switch, stops an app that writes no test-mode.pid, and stops before driving
 * anything unless the WebView2 profile lies under the data folder. It never
 * attaches to an app it did not start. The exe runs from a copy in --bin
 * (bin/builds.json names the commit each copy was built from): a rebuild of
 * the shared target cannot swap the binary between a close and a relaunch.
 *
 * Order used on 06/10/2026: launch --exe muse-desktop-prefix.exe --build
 * prefix, probe, p-double, p-restart, stale --conv p, stop; launch --exe
 * muse-desktop-87c6929.exe, q-restart, stop, msp-orphan-prompt.mjs --key
 * msp-raw-1, relaunch, q-double, stop, msp-orphan-prompt.mjs --key msp-raw-2,
 * relaunch --exe muse-desktop-b2811dd.exe, q-double --as q-double-2, a-reload,
 * a-death, a-death-trace, stop, relaunch, a-reconnect, stop, rederive, summary.
 *
 * Usage:
 *   node scripts/cdp-m0-05-complement.mjs <phase> [--base G:\muse-proofs\m0-05b\run]
 *     [--bin G:\muse-proofs\m0-05b\bin] [--exe <file>] [--build prefix|fixed]
 *     [--as <key>] [--conv p|q]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-05-complement.json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, join, resolve } from "node:path";

// The isolated instance's own port: 9222 is a developer's app, 9334 and 9335 other proofs'.
process.env.MUSE_CDP_PORT ??= "9333";
const { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const PHASE = process.argv[2];
const BASE = argValue("--base", "G:\\muse-proofs\\m0-05b\\run");
const BIN = argValue("--bin", "G:\\muse-proofs\\m0-05b\\bin");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-05-complement.json");
const ENGINE = resolve(argValue("--engine", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const STATE = join(BASE, "harness-state.json");
const FOLDERS = { p: join(BASE, "p"), q: join(BASE, "q"), a: join(BASE, "a") };
const J = JSON.stringify;

// The tool takes 2-3 options per question (m0-05-questions.json, stuck).
const FRUIT = 'Before anything else, call your request_user_input tool exactly once, with one single-select question: id "fruit", header "Fruit", question "Which fruit should I name?", options "Apple", "Banana", "Cherry". After my answer, reply with only the fruit I picked, in capital letters. Use no other tool.';
// The reliable Ask-posture prompt: a compound command the host cannot clear statically.
const POWERSHELL = "Use your PowerShell tool to run EXACTLY this command, unchanged, once: $m = 'm05'; Set-Content -Path (Join-Path (Get-Location) 'probe.txt') -Value $m";
const APPROVAL_LINE = "Approval cancelled: Muse stopped before you answered, so the action did not run.";
const INPUT_RESTART_LINE = "Input cancelled: Muse closed before you answered.";

// ---- state, record, redaction ------------------------------------------------

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));
const parse = (text) => { try { return JSON.parse(text); } catch { return text ?? null; } };
const pathKey = (p) => String(p ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function redact(value) {
  const pairs = [[FOLDERS.p, "<folder P>"], [FOLDERS.q, "<folder Q>"], [FOLDERS.a, "<folder A>"], [BASE, "<proof>"], [BIN, "<bin>"], [resolve("."), "<repo>"]];
  return redactor(pairs)(value);
}

function engineVersion() {
  try {
    return execFileSync(ENGINE, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

/** The binary this instance runs: its copy, the commit it was built from, its SHA-256 now. */
function exeFacts() {
  const s = state();
  if (!s.exe) return {};
  return { build: s.build, buildCommit: readJson(join(BIN, "builds.json"), {})[basename(s.exe)]?.commit ?? null, exe: basename(s.exe), exeSha256: sha256(s.exe) };
}

function merge(key, result) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m0-05-complement.v1",
    ticket: "M0-05",
    complements: ["m0-05-questions.json", "m0-05-06-approvals.json"],
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.platform = `win32 ${release()}, debug build in its isolated test mode (ADR 0003), WebView2 over CDP`;
  record.engine = engineVersion();
  record.phases[key] = redact({ headAtPhase: gitHead(), ...exeFacts(), ...result });
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[key];
}

// ---- app and engine processes ------------------------------------------------

const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
const ps = (command) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
const alive = (pid) => {
  try { return lines(ps(`Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`)).length > 0; } catch { return false; }
};
const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };

/**
 * The isolated test mode, started from PowerShell: no WEBVIEW2_* variable,
 * the staged engine as the only local engine, CDP through the WebView2
 * options. `restart` reopens the same data folder; any other launch takes a
 * fresh one. Refused for an exe without the switch; stopped when no
 * test-mode.pid names it within 10 s.
 */
async function launchApp({ restart = false, exe = null } = {}) {
  const s = state();
  const file = exe ? resolve(BIN, exe) : restart ? s.exe : "";
  if (!file || !existsSync(file)) throw new Error("no exe: pass --exe <file in --bin>");
  if (!readFileSync(file).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  const launches = (s.launches ?? 0) + (restart ? 0 : 1);
  const data = restart ? s.data : join(BASE, `appdata-${launches}`);
  if (!restart && existsSync(data)) throw new Error(`${data} exists: every launch takes a fresh data folder`);
  mkdirSync(data, { recursive: true });
  const pid = Number(ps([
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${data}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${J([ENGINE.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${file}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")).trim());
  saveState({ pid, data, launches, exe: file, startedAt: Date.now(), ...(restart && !exe ? {} : { build: argValue("--build", "fixed") }) });
  const entered = await waitFor(() => { try { return readFileSync(join(data, "test-mode.pid"), "utf8").trim() === String(pid); } catch { return false; } }, 10_000, 100);
  if (!entered) {
    forceKill(pid);
    saveState({ pid: null });
    throw new Error("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  }
  return { pid, at: Date.now() };
}

/** CDP on this harness's instance only: its WebView2 profile must lie under its data folder. */
async function attach({ trace = true } = {}) {
  let app = null;
  await waitFor(async () => { try { app = await openPage(); return true; } catch { return false; } }, 120_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  const { data, pid } = state();
  if (!data || !under(webviewProfile(), data)) {
    app.close();
    if (pid) forceKill(pid);
    saveState({ pid: null });
    throw new Error("the WebView2 browser is not on the test profile: stopped before driving the app");
  }
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  if (trace) await app.ev(INSTALL_IPC_TRACE);
  return app;
}

/** Window close (WM_CLOSE) first; forced only if the app is still there after 20 s. */
async function closeApp(app) {
  app?.close();
  const pid = state().pid;
  if (!pid) return { closed: false, reason: "no pid" };
  const children = engines(pid).map((e) => e.pid);
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await waitFor(() => !alive(pid), 20_000, 1_000));
  if (!graceful) {
    forceKill(pid);
    await waitFor(() => !alive(pid), 10_000, 1_000);
  }
  await sleep(1_500);
  saveState({ pid: null });
  return { graceful, exited: !alive(pid), enginesBefore: children.length, enginesAliveAfter: children.filter((p) => alive(p)).length };
}

/**
 * The app's engine children with their working directory, read from each
 * process's PEB (RTL_USER_PROCESS_PARAMETERS.CurrentDirectory): the bridge
 * spawns one engine per folder, in that folder.
 */
function engines(appPid) {
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class M05Cwd {
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Exit; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr Parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr at, byte[] b, IntPtr n, out IntPtr got);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, IntPtr at, int n) { var b = new byte[n]; IntPtr got; return ReadProcessMemory(h, at, b, (IntPtr)n, out got) ? b : null; }
  public static string Cwd(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out r) != 0) return null;
      var pp = Read(h, pbi.Peb + 0x20, 8); if (pp == null) return null;
      var dos = Read(h, (IntPtr)BitConverter.ToInt64(pp, 0) + 0x38, 16); if (dos == null) return null;
      var s = Read(h, (IntPtr)BitConverter.ToInt64(dos, 8), BitConverter.ToUInt16(dos, 0)); if (s == null) return null;
      return Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
"@
ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(appPid)}" | Where-Object { $_.Name -eq '${basename(ENGINE)}' } | ForEach-Object {
  @{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToString('o'); cwd = [M05Cwd]::Cwd([int]$_.ProcessId) } })
`;
  try {
    const list = JSON.parse(ps(script).trim() || "[]");
    return Array.isArray(list) ? list : [list];
  } catch { return []; }
}
const folderLabel = (cwd) => Object.entries(FOLDERS).find(([, dir]) => pathKey(cwd) === pathKey(dir))?.[0]?.toUpperCase() ?? "other";
const enginesView = (list) => list.map((e) => ({ pid: e.pid, created: e.created, folder: folderLabel(e.cwd) }));

// ---- page side -------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const stored = (sid) => (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid) || null;
  const fiber = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k] : null; };
  const cardKey = (el) => { let f = fiber(el); while (f && f.key == null) f = f.return; return f ? f.key : null; };
  const inputNodes = () => q('section[aria-label="Pending input"] .approval');
  const inputCards = () => inputNodes().map((c) => ({
    key: cardKey(c),
    questions: [...c.querySelectorAll('.input-question')].map((g) => ({
      question: g.getAttribute('aria-label'),
      choices: [...g.querySelectorAll('button')].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') === 'true' })),
    })),
    actions: [...c.querySelectorAll(':scope > .approval-actions button')].map((b) => b.innerText.trim()),
    alert: text(c.querySelector('[role="alert"]')),
  }));
  const approvalSection = () => document.querySelector('section[aria-label="Conversation authorization"]');
  const approvalCards = () => q('section[aria-label="Conversation authorization"] .approval').map((g) => ({
    key: cardKey(g),
    title: text(g.querySelector('.approval-title-row strong')),
    command: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 300) || null,
    scope: text(g.querySelector('.approval-scope')),
    buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => ({ text: b.innerText.trim(), cls: b.className })),
  }));
  // What the approval panel holds (React props): the requirement each card's decision is pinned to.
  const panelApprovals = () => {
    const el = approvalSection();
    let f = el ? fiber(el) : null;
    while (f && !(f.memoizedProps && Array.isArray(f.memoizedProps.approvals))) f = f.return;
    return f ? f.memoizedProps.approvals.map((a) => ({ requestId: a.request_id, requirementId: a.requirementId ?? null })) : [];
  };
  const banner = () => text(document.querySelector('.error-banner span'));
  const connection = () => text(document.querySelector('.task-metadata .connection-state'));
  const health = () => text(document.querySelector('.stream-health'));
  const reconnectButton = () => q('.top-actions button.workspace-button').find((b) => /^Reconnect/.test(b.innerText.trim())) || null;
  const view = () => ({ activeSid: activeSid(), inputs: inputCards(), approvals: approvalCards(), banner: banner(), connection: connection(), health: health(),
    reconnect: reconnectButton() ? { text: reconnectButton().innerText.trim(), disabled: reconnectButton().disabled } : null });
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

const ipc = (app, cmd, max = 2000) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${J(cmd)})
  .map((c) => ({ atMs: c.atMs, args: c.args, ok: c.ok, result: c.result ? c.result.slice(0, ${max}) : c.result }))`);

/** The next completed call to `cmd` after `before` calls. */
async function nextIpc(app, cmd, before, timeoutMs = 60_000) {
  return waitFor(async () => {
    const calls = await ipc(app, cmd);
    return calls.length > before && calls.at(-1).ok !== undefined ? calls.at(-1) : null;
  }, timeoutMs, 300);
}

const inputIdsOf = (result) => [...String(result ?? "").matchAll(/"inputId":"([^"]+)"/g)].map((m) => m[1]);
const approvalIdsOf = (result) => [...new Set([...String(result ?? "").matchAll(/"approvalId":"([^"]+)"/g)].map((m) => m[1]))];

/**
 * Renderer-side tap on poll_events, the path every bridge event takes to the
 * renderer. The harness's own ring reads (marked m05) are left out.
 */
const INSTALL_POLL_TAP = `(() => {
  const tap = window.__m05tap = window.__m05tap || { installed: false, t0: Date.now(), events: [] };
  if (tap.installed) return 'kept';
  tap.installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const response = await original(input, init);
    if (!/^https?:\\/\\/ipc\\.localhost\\/poll_events/.test(url) || /m05/.test(String((init && init.body) || ''))) return response;
    if (response.headers.get('Tauri-Response') !== 'ok') return response;
    try {
      const body = await response.clone().json();
      for (const e of body.events || []) tap.events.push({ atMs: Date.now() - tap.t0, sid: e.session_id, kind: e.kind, payload: String(e.payload || '').slice(0, 600) });
    } catch { /* a poll the tap cannot read stays the app's */ }
    return response;
  };
  return 'installed';
})()`;
const tapEvents = (app, sid, from = 0) => app.ev(`window.__m05tap ? window.__m05tap.events.slice(${from}).filter((e) => e.sid === ${J(sid)}) : []`);
const tapCount = (app) => app.ev("window.__m05tap ? window.__m05tap.events.length : 0");

/**
 * Counts every call of __TAURI_INTERNALS__.invoke, the function the app's
 * invoke() calls. The page refuses a wrapper (the property and the object's
 * invoke are non-writable, non-configurable), so the function is instrumented
 * from the debugger: a breakpoint on each of its calls whose condition records
 * the command and returns false, so it never pauses. poll_events only counted.
 */
async function countInvokes(app) {
  const refused = await app.ev(`(() => {
    const i = window.__TAURI_INTERNALS__, original = i.invoke, wrapper = function () { return original.apply(this, arguments); };
    try { i.invoke = wrapper; } catch { /* strict mode */ }
    const d = Object.getOwnPropertyDescriptor(i, 'invoke');
    return { assignmentTaken: i.invoke === wrapper, writable: d.writable, configurable: d.configurable };
  })()`);
  await app.send("Debugger.enable");
  await app.ev("(globalThis.__m05invoke = { t0: Date.now(), polls: 0, calls: [] }, true)");
  const fn = await app.send("Runtime.evaluate", { expression: "window.__TAURI_INTERNALS__.invoke", objectGroup: "m05" });
  const condition = "(function (c, cmd, args) { if (cmd === 'poll_events') c.polls++; else c.calls.push({ cmd: cmd, atMs: Date.now() - c.t0,"
    + " args: cmd === 'answer_input' || cmd === 'approve' ? JSON.parse(JSON.stringify(args)) : undefined }); return false; })"
    + "(globalThis.__m05invoke || (globalThis.__m05invoke = { t0: Date.now(), polls: 0, calls: [] }), arguments[0], arguments[1])";
  const bp = await app.send("Debugger.setBreakpointOnFunctionCall", { objectId: fn.result.objectId, condition });
  await sleep(1_500);
  const polls = await app.ev("globalThis.__m05invoke.polls");
  return { wrapperRefused: refused, method: "Debugger.setBreakpointOnFunctionCall (condition records, returns false)", installed: Boolean(bp?.breakpointId), pollsSeenIn1500ms: polls };
}

/** Every click and double-click the question card's buttons receive, capture phase, before React. */
const INSTALL_CLICK_LOG = `(() => {
  const log = window.__m05clicks = window.__m05clicks || { t0: Date.now(), events: [], installed: false };
  if (log.installed) return 'kept';
  log.installed = true;
  for (const type of ['click', 'dblclick']) document.addEventListener(type, (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !b.closest('section[aria-label="Pending input"]')) return;
    log.events.push({ type, detail: e.detail, button: (b.innerText || '').trim(), atMs: Date.now() - log.t0 });
  }, true);
  return 'installed';
})()`;

/** What the app's own read-only pending command returns for `sid` (9771bdb's filtered read). */
async function appPending(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${J(sid)} })
    .then((r) => r, (e) => ({ error: String(e).slice(0, 300) }))`);
  if (res?.error) return { error: res.error };
  return {
    userInputs: (res?.userInputs ?? []).map((r) => ({ inputId: r.inputId ?? r.request_id ?? r.userInputId, turnId: r.turnId ?? null })),
    approvals: (res?.approvals ?? []).map((r) => ({
      approvalId: r.approvalId ?? r.request_id, turnId: r.turnId ?? null, requirement: r.currentRequirementId ?? r.requirementId ?? null,
      choices: (r.choices ?? r.availableChoices ?? []).map((c) => ({ choiceId: c.choiceId, label: c.label ?? null, decision: c.decision?.kind ?? c.decision ?? null })),
    })),
  };
}

/** The backend's event ring since the app started (read-only), this conversation's events. */
async function ring(app, sid) {
  const res = await app.ev("window.__TAURI_INTERNALS__.invoke('poll_events', { since: 0, m05: true })");
  return { oldest: res?.oldest ?? null, truncated: res?.truncated ?? null,
    events: (res?.events ?? []).filter((e) => e.session_id === sid).map((e) => ({ seq: e.seq, kind: e.kind, payload: String(e.payload ?? "").slice(0, 300) })) };
}

async function select(app, sid) {
  await app.ev(page(`const b = row(${J(sid)})?.querySelector('button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${J(sid)};`)), 15_000, 300);
  await sleep(800);
}

/** Refuse to act unless `sid` is listed, active and runs in `folder`. */
async function guard(app, sid, folder) {
  if (!sid) throw new Error("no test conversation for this phase");
  if (!(await app.ev(page(`return Boolean(row(${J(sid)}));`)))) throw new Error("refusing: the test conversation is not in the sidebar");
  if ((await app.ev(page("return activeSid();"))) !== sid) await select(app, sid);
  const r = await app.ev(page(`const s = stored(${J(sid)}); return { active: activeSid(), workspace: s?.workspace ?? null };`));
  if (r.active !== sid) throw new Error("refusing: the active conversation is not the test conversation");
  if (pathKey(r.workspace) !== pathKey(folder)) throw new Error("refusing: the test conversation does not run in its test folder");
}

/** Centre of the element `find` returns (page-side), scrolled into view. */
async function centre(app, find) {
  return app.ev(page(`
    const el = (() => { ${find} })();
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    await pause(150);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `));
}

/** Real mouse clicks through CDP Input: clickCount 2 on the second press makes a double-click. */
async function mouse(app, find, count = 1) {
  const box = await centre(app, find);
  if (!box) return { clicked: false };
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  for (let n = 1; n <= count; n++) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: n });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: n });
  }
  return { clicked: true, count };
}
const inputButton = (label) => `return [...(inputNodes()[0]?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === ${J(label)}) || null;`;
const approvalButton = (label) => `return q('section[aria-label="Conversation authorization"] .approval-actions button').find((b) => b.innerText.trim() === ${J(label)}) || null;`;

const fullLog = (app, sid) => app.ev(page(`
  return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ') }));
`));
/** The transcript from the last user entry carrying `prompt` onward. */
async function turnLog(app, sid, prompt) {
  const log = await fullLog(app, sid);
  const start = log.findLastIndex((e) => e.role === "user" && e.text.includes(prompt.slice(0, 40)));
  return (start >= 0 ? log.slice(start) : log.slice(-12)).map((e) => ({ role: e.role, text: e.text.slice(0, 300) }));
}
const reply = (entries) => {
  const asked = entries.findLastIndex((e) => e.role === "tool" && e.text.startsWith("Input requested:"));
  return entries.slice(asked + 1).filter((e) => e.role === "assistant").map((e) => e.text).join(" ").trim();
};

/** Welcome screen -> "New project from a folder…" (the folder dialog answered) -> first message -> Start. */
async function startViaWelcome(app, folder, message) {
  mkdirSync(folder, { recursive: true });
  const before = (await ipc(app, "start_session")).length;
  const sends = (await ipc(app, "send_input")).length;
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${J(folder)}), true)`);
  const outcome = await app.ev(page(`
    q('.primary-nav button[aria-label="New conversation"]')[0]?.click();
    let picker = null;
    for (let i = 0; i < 50 && !picker; i++) { picker = document.querySelector('details.project-picker-control'); if (!picker) await pause(100); }
    if (!picker) return { started: false, reason: 'no project picker' };
    picker.open = true;
    await pause(300);
    const add = document.querySelector('.project-option-new');
    if (!add) return { started: false, reason: 'no new-project option' };
    add.click();
    let note = '';
    for (let i = 0; i < 80; i++) { note = text(document.querySelector('.welcome-project-note')) || ''; if (note.includes(${J(basename(folder))})) break; await pause(100); }
    if (!note.includes(${J(basename(folder))})) return { started: false, reason: 'project not selected: ' + note };
    setValue(document.querySelector('textarea[aria-label="Your first message"]'), ${J(message)});
    await pause(300);
    const start = document.querySelector('button.welcome-send');
    if (!start || start.disabled) return { started: false, reason: 'start disabled' };
    start.click();
    return { started: true };
  `));
  if (!outcome.started) throw new Error(`could not start from the welcome screen: ${outcome.reason}`);
  const call = await nextIpc(app, "start_session", before, 90_000);
  const meta = parse(call?.result);
  if (!call?.ok || !meta?.session_id) throw new Error(`start_session failed: ${J(call?.result ?? null)}`);
  const send = await nextIpc(app, "send_input", sends, 60_000);
  return { sid: meta.session_id, startSession: { ok: call.ok, authorizationMode: call.args?.authorizationMode ?? null,
    sandboxMode: call.args?.sandboxMode ?? null, hostApprovalMode: meta.approval_mode ?? null }, sendInput: { ok: send?.ok ?? null } };
}

/** A follow-up through the composer of the active conversation. */
async function followUp(app, prompt) {
  const sends = (await ipc(app, "send_input")).length;
  // A conversation reopened after a relaunch resumes first: its composer waits for the connection.
  await waitFor(() => app.ev(page("return connection() === 'Connected';")), 90_000, 500);
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { sent: false, reason: 'no composer' };
    setValue(field, ${J(prompt)});
    let send = null;
    for (let i = 0; i < 60; i++) { await pause(500); send = document.querySelector('button.send'); if (send && !send.disabled) break; }
    if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
    send.click();
    return { sent: true };
  `));
  if (!sent.sent) throw new Error(`prompt not sent: ${sent.reason}`);
  const call = await nextIpc(app, "send_input", sends, 60_000);
  return { sendInput: { ok: call?.ok ?? null } };
}

/** Wait for a card of `kind` ('inputs' | 'approvals') in the active conversation. */
async function waitCard(app, kind, timeoutMs = 240_000) {
  const t0 = Date.now();
  const allowedFirst = [];
  const ui = await waitFor(async () => {
    const v = await app.ev(page("return view();"));
    if (kind === "inputs" && v.inputs.length === 0 && v.approvals.length > 0 && allowedFirst.length < 4) {
      // Under Ask, an action the host does not clear asks first: allowed once, as a user would, and recorded.
      allowedFirst.push({ atMs: Date.now() - t0, card: v.approvals[0], click: await mouse(app, approvalButton("Allow once")) });
      await sleep(1_500);
      return null;
    }
    return v[kind].length > 0 ? v : null;
  }, timeoutMs, 800);
  return ui ? { msToCard: Date.now() - t0, view: ui, approvalsAllowedFirst: allowedFirst } : null;
}

/** Wait until the turn is over: not running, no card, nothing in progress. */
async function untilIdle(app, sid, timeoutMs = 180_000) {
  const t0 = Date.now();
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${J(sid)}) };`));
    return s.running === "false" && s.inputs.length === 0 && s.approvals.length === 0
      && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "") ? s : null;
  }, timeoutMs, 800);
  return { idle: Boolean(done), msToIdle: done ? Date.now() - t0 : null };
}

/** Reload the window with the IPC trace and the poll tap installed from its first script. */
async function tracedReload(app) {
  await app.send("Page.enable");
  const { identifier } = await app.send("Page.addScriptToEvaluateOnNewDocument", { source: `${INSTALL_IPC_TRACE};\n${INSTALL_POLL_TAP};` });
  await app.send("Page.reload", { ignoreCache: false });
  const t0 = Date.now();
  await sleep(2_000);
  await app.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  return t0;
}

// ---- phases ------------------------------------------------------------------------

async function launch() {
  if (state().pid && alive(state().pid)) throw new Error("this harness's instance is still running: run stop first");
  mkdirSync(BASE, { recursive: true });
  const exe = argValue("--exe", null);
  if (!exe) throw new Error("launch needs --exe <file in --bin>");
  const { pid } = await launchApp({ exe });
  const app = await attach();
  return { app, result: { liveTurns: 0, started: true, pidRecorded: Boolean(pid), isolation: { testModeMarker: true, webviewProfileUnderTestFolder: true, cdpPort: PORT } } };
}

async function relaunch() {
  if (state().pid && alive(state().pid)) throw new Error("this harness's instance is still running: run stop first");
  const exe = argValue("--exe", null);
  const { pid } = await launchApp({ restart: true, exe });
  const app = await attach();
  return { app, result: { liveTurns: 0, started: true, sameDataFolder: true, exeSwitched: Boolean(exe), pidRecorded: Boolean(pid), isolation: { testModeMarker: true, webviewProfileUnderTestFolder: true, cdpPort: PORT } } };
}

async function probe(app) {
  const wrap = await countInvokes(app);
  const profile = await app.ev(page(`return { sessions: (store('muse-desktop.sessions.v1', '[]') || []).length, posture: localStorage.getItem('muse-desktop.authorization-mode.v1'),
    welcome: Boolean(document.querySelector('textarea[aria-label="Your first message"]')), newConversation: q('.primary-nav button[aria-label="New conversation"]').length };`));
  return { liveTurns: 0, invokeCounter: wrap, profile, view: await app.ev(page("return view();")), verdict: { emptyProfile: profile.sessions === 0 } };
}

/**
 * (1) Real CDP double-click on Send answer. `reload` (q-double): the window
 * is reloaded with the question pending first, and the boot read recorded.
 */
async function double(app, folder, convKey, { reload }) {
  const s = state();
  const result = { liveTurns: 1 };
  let sid = s[convKey];
  await app.ev(INSTALL_POLL_TAP);
  if (!sid) {
    const started = await startViaWelcome(app, folder, FRUIT);
    sid = started.sid;
    saveState({ [convKey]: sid });
    result.start = started;
    await guard(app, sid, folder);
  } else {
    await guard(app, sid, folder);
    result.start = await followUp(app, FRUIT);
  }
  const asked = await waitCard(app, "inputs");
  if (!asked) throw new Error(`no question card within the bound; transcript: ${J(await turnLog(app, sid, FRUIT))}`);
  result.card = { msToCard: asked.msToCard, approvalsAllowedFirst: asked.approvalsAllowedFirst, view: asked.view, appPending: await appPending(app, sid) };
  const live = asked.view.inputs[0].key?.split(":")[1] ?? null;
  // The question's transcript line while it waits: on screen, and in the stored log a restart reads back.
  await sleep(1_500);
  result.card.inputLine = {
    rendered: await app.ev(page("return /Input requested: request_user_input/.test(document.querySelector('.stream')?.innerText || '');")),
    stored: (await turnLog(app, sid, FRUIT)).some((e) => e.role === "tool" && e.text.startsWith("Input requested:")),
  };
  if (reload) {
    const t0 = await tracedReload(app);
    const back = await waitFor(async () => {
      const ui = await app.ev(page("return view();"));
      return ui.activeSid === sid && ui.inputs.length > 0 ? ui : null;
    }, 30_000, 500);
    await sleep(1_500);
    const boot = (await ipc(app, "list_pending_requests")).filter((c) => c.args?.sessionId === sid);
    result.reload = {
      msToCard: back ? Date.now() - t0 : null,
      inputLineRendered: await app.ev(page("return /Input requested: request_user_input/.test(document.querySelector('.stream')?.innerText || '');")),
      view: await app.ev(page("return view();")),
      bootListPending: boot.map((c) => ({ ok: c.ok, userInputIds: inputIdsOf(c.result) })),
      appPending: await appPending(app, sid),
      deadQuestionsLeftByQRestart: s.deadQuestions?.[sid] ?? [],
    };
  }
  result.invokeCounter = await countInvokes(app);
  await app.ev(INSTALL_CLICK_LOG);
  result.pick = await mouse(app, inputButton("Banana"));
  await sleep(400);
  result.beforeSend = await app.ev(page("return view();"));
  const n = { fetch: (await ipc(app, "answer_input")).length, invoke: await app.ev("globalThis.__m05invoke.calls.filter((c) => c.cmd === 'answer_input').length"),
    clicks: await app.ev("window.__m05clicks.events.length"), tap: await tapCount(app) };
  result.doubleClick = await mouse(app, inputButton("Send answer"), 2);
  await sleep(3_000);
  const calls = (await ipc(app, "answer_input")).slice(n.fetch);
  result.after = {
    clicks: await app.ev(`window.__m05clicks.events.slice(${n.clicks})`),
    answerInputFetch: calls.map((c) => ({ atMs: c.atMs, ok: c.ok, args: c.args, result: c.ok ? undefined : String(c.result ?? "").slice(0, 300) })),
    answerInputInvoke: await app.ev(`globalThis.__m05invoke.calls.filter((c) => c.cmd === 'answer_input').slice(${n.invoke})`),
    view: await app.ev(page("return view();")),
  };
  result.end = await untilIdle(app, sid);
  result.settled = (await tapEvents(app, sid, n.tap)).filter((e) => e.kind === "input_settled").map((e) => e.payload);
  result.transcript = await turnLog(app, sid, FRUIT);
  result.reply = reply(result.transcript);
  result.finalView = await app.ev(page("return view();"));
  result.inputLinesAtTheEnd = result.transcript.filter((e) => e.role === "tool" && e.text.startsWith("Input requested:")).length;
  const sendClicks = result.after.clicks.filter((c) => c.type === "click" && c.button === "Send answer").map((c) => c.detail);
  const invokes = result.invokeCounter.installed && result.invokeCounter.pollsSeenIn1500ms > 0 ? result.after.answerInputInvoke.length : null;
  result.measured = {
    sendAnswerClickDetails: sendClicks,
    answerInputCallsOnTheTransport: calls.length,
    answerInputCallsThroughInvoke: invokes,
    refusedCalls: calls.filter((c) => c.ok === false).length,
    bannerAfterTheDoubleClick: result.after.view.banner,
    bannerAtTheEnd: result.finalView.banner,
    inputSettledEvents: result.settled.length,
  };
  result.verdict = {
    realDoubleClickReachedTheButton: sendClicks.length === 2 && sendClicks[0] === 1 && sendClicks[1] === 2,
    oneAnswerSent: calls.length === 1 && (invokes === null || invokes === 1),
    answerAccepted: calls.length >= 1 && calls[0].ok === true,
    noFalseErrorBanner: !result.after.view.banner && !result.finalView.banner && result.after.view.inputs.every((c) => !c.alert),
    settledAnsweredOnce: result.settled.length === 1 && /"outcome":"answered"/.test(result.settled[0] ?? ""),
    turnEnded: result.end.idle,
    replyIsTheAnswer: /\bBANANA\b/.test(result.reply.toUpperCase()) && !/\b(APPLE|CHERRY)\b/.test(result.reply.toUpperCase()),
  };
  if (reload) {
    result.verdict.reloadRebuiltOnlyTheLiveCard = result.reload.view.inputs.length === 1 && result.reload.view.inputs[0].key === `${sid}:${live}`;
    result.verdict.bootReadCarriedOnlyTheLiveQuestion = result.reload.bootListPending.length > 0
      && result.reload.bootListPending.every((c) => c.ok && c.userInputIds.length === 1 && c.userInputIds[0] === live);
  }
  return result;
}

/** (2) A question pending, the app closed from its window, relaunched, the conversation reopened. */
async function restart(app, folder, convKey) {
  const s = state();
  const result = { liveTurns: 1 };
  let sid = s[convKey];
  if (!sid) {
    const started = await startViaWelcome(app, folder, FRUIT);
    sid = started.sid;
    saveState({ [convKey]: sid });
    result.start = started;
    await guard(app, sid, folder);
  } else {
    await guard(app, sid, folder);
    result.start = await followUp(app, FRUIT);
  }
  const asked = await waitCard(app, "inputs");
  if (!asked) throw new Error(`no question card within the bound; transcript: ${J(await turnLog(app, sid, FRUIT))}`);
  const question = asked.view.inputs[0].key?.split(":")[1] ?? null;
  await sleep(1_500);
  result.before = {
    msToCard: asked.msToCard, approvalsAllowedFirst: asked.approvalsAllowedFirst, view: asked.view, appPending: await appPending(app, sid),
    markers: await app.ev(page("return { inputs: localStorage.getItem('muse-desktop.pending-inputs.v1'), approvals: localStorage.getItem('muse-desktop.pending-approvals.v1') };")),
    engines: enginesView(engines(state().pid)),
    transcript: await turnLog(app, sid, FRUIT),
  };
  result.close = await closeApp(app);
  const relaunched = await launchApp({ restart: true });
  const next = await attach();
  result.relaunch = { pidRecorded: Boolean(relaunched.pid) };
  await select(next, sid);
  await guard(next, sid, folder);
  const connected = await waitFor(() => next.ev(page("return connection() === 'Connected' ? view() : null;")), 90_000, 500);
  // A card the resume might bring back: watched for 15 s.
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const v = await next.ev(page("return view();"));
    samples.push({ atS: i, inputs: v.inputs.length, approvals: v.approvals.length });
    await sleep(1_000);
  }
  // The reopened conversation runs no turn: read once a minute has passed since it connected.
  await sleep(Math.max(0, 60_000 - samples.length * 1_000));
  const live = await liveness(next, sid);
  const log = await fullLog(next, sid);
  const asked2 = log.findLastIndex((e) => e.role === "tool" && e.text.startsWith("Input requested:"));
  result.after = {
    connected: Boolean(connected),
    view: await next.ev(page("return view();")),
    cardSamples: samples,
    livenessAfterAMinute: live,
    transcriptTail: log.slice(-6).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })),
    linesAfterTheQuestion: log.slice(asked2 + 1).filter((e) => e.role === "system").map((e) => e.text.slice(0, 200)),
    appPending: await appPending(next, sid),
    resumeEvents: await ring(next, sid),
    engines: enginesView(engines(state().pid)),
    markersAfterBoot: await next.ev(page("return { inputs: localStorage.getItem('muse-desktop.pending-inputs.v1'), approvals: localStorage.getItem('muse-desktop.pending-approvals.v1') };")),
  };
  saveState({ deadQuestions: { ...(state().deadQuestions ?? {}), [sid]: [...new Set([...(state().deadQuestions?.[sid] ?? []), question])] } });
  result.question = question;
  result.measured = {
    cancelLine: result.after.linesAfterTheQuestion.includes(INPUT_RESTART_LINE),
    cardsAfterRelaunch: result.after.view.inputs.length,
    reissuedAfterResume: result.after.resumeEvents.events.filter((e) => e.kind === "input_request").length,
    appReadListsTheQuestion: (result.after.appPending.userInputs ?? []).some((r) => r.inputId === question),
  };
  result.verdict = {
    questionPendingAtClose: Boolean(question) && (result.before.appPending.userInputs ?? []).some((r) => r.inputId === question),
    closedFromItsWindow: result.close.graceful && result.close.exited,
    engineEndedWithTheApp: result.close.enginesBefore >= 1 && result.close.enginesAliveAfter === 0,
    reopenedAndConnected: result.after.connected,
    noPhantomCard: samples.every((x) => x.inputs === 0 && x.approvals === 0),
    transcriptSaysInputCancelled: result.measured.cancelLine,
    lineOnlyOnce: result.after.linesAfterTheQuestion.filter((t) => t === INPUT_RESTART_LINE).length <= 1,
    notLeftWorking: idleNow(live),
  };
  return { app: next, result };
}

/** (4) Ask posture: card with the host's choices, rebuilt by a reload, every stage decided, the turn's end. */
async function aReload(app) {
  if (state().a) throw new Error("conversation A already exists");
  const posture = await app.ev("localStorage.getItem('muse-desktop.authorization-mode.v1')");
  if (posture !== null && posture !== '"ask"' && posture !== "ask") throw new Error(`the posture is not Ask: ${posture}`);
  await app.ev(INSTALL_POLL_TAP);
  const result = { liveTurns: 1, postureStored: posture };
  const started = await startViaWelcome(app, FOLDERS.a, POWERSHELL);
  saveState({ a: started.sid });
  const sid = started.sid;
  result.start = started;
  await guard(app, sid, FOLDERS.a);
  const asked = await waitCard(app, "approvals");
  if (!asked) throw new Error(`no approval card within the bound; transcript: ${J(await turnLog(app, sid, POWERSHELL))}`);
  await sleep(1_000);
  const host = await appPending(app, sid);
  result.card = { msToCard: asked.msToCard, view: await app.ev(page("return view();")), appPending: host, panel: await app.ev(page("return panelApprovals();")) };
  const approvalId = host.approvals[0]?.approvalId ?? null;
  const t0 = await tracedReload(app);
  const back = await waitFor(async () => {
    const ui = await app.ev(page("return view();"));
    return ui.activeSid === sid && ui.approvals.length > 0 ? ui : null;
  }, 30_000, 500);
  await sleep(1_500);
  const boot = (await ipc(app, "list_pending_requests")).filter((c) => c.args?.sessionId === sid);
  result.reload = {
    msToCard: back ? Date.now() - t0 : null,
    view: await app.ev(page("return view();")),
    panel: await app.ev(page("return panelApprovals();")),
    bootListPending: boot.map((c) => ({ ok: c.ok, approvalIds: approvalIdsOf(c.result) })),
    approveCallsBeforeAnyClick: (await ipc(app, "approve")).length,
  };
  // Every stage decided Allow once, each click on the card the panel shows for the host's current stage.
  const allow = host.approvals[0]?.choices.find((c) => c.choiceId === "allow_once")?.label ?? "Allow once";
  result.stages = [];
  for (let i = 0; i < 5; i++) {
    const now = await appPending(app, sid);
    if ((now.approvals ?? []).length === 0) break;
    const requirement = J(now.approvals[0].requirement);
    const painted = await waitFor(async () => (J((await app.ev(page("return panelApprovals();")))[0]?.requirementId ?? null) === requirement ? true : null), 15_000, 300);
    const n = (await ipc(app, "approve")).length;
    const click = await mouse(app, approvalButton(allow));
    const call = await nextIpc(app, "approve", n, 30_000);
    result.stages.push({ requirement: now.approvals[0].requirement, choices: now.approvals[0].choices, cardPinnedToIt: Boolean(painted), click,
      approve: { ok: call?.ok ?? null, requirementSent: call?.args?.requirementId ?? null, result: String(call?.result ?? "").slice(0, 200) } });
    await waitFor(async () => {
      const next = await appPending(app, sid);
      return (next.approvals ?? []).length === 0 || J(next.approvals[0].requirement) !== requirement ? true : null;
    }, 30_000, 500);
    await sleep(800);
  }
  result.end = await untilIdle(app, sid);
  result.finalView = await app.ev(page("return view();"));
  result.transcript = await turnLog(app, sid, POWERSHELL);
  const probe = join(FOLDERS.a, "probe.txt");
  result.probeFile = existsSync(probe) ? readFileSync(probe, "utf8").trim() : null;
  result.measured = { stagesPresentedByTheHost: result.stages.length };
  const buttons = (v) => v.approvals[0]?.buttons.map((b) => b.text) ?? [];
  const hostLabels = host.approvals[0]?.choices.map((c) => c.label) ?? [];
  result.verdict = {
    askPosture: started.startSession.authorizationMode === "ask" && started.startSession.hostApprovalMode === "promptUnmatched",
    cardShowsTheHostChoices: hostLabels.length > 0 && J(buttons(result.card.view)) === J(hostLabels),
    reloadRebuiltTheCard: Boolean(back) && result.reload.view.approvals.length === 1 && result.reload.view.approvals[0].key === `${sid}:${approvalId}`
      && J(buttons(result.reload.view)) === J(hostLabels) && result.reload.approveCallsBeforeAnyClick === 0,
    bootReadKeptTheLiveApproval: result.reload.bootListPending.some((c) => c.ok && c.approvalIds.includes(approvalId)),
    ...stageVerdict(result.stages),
    turnEnded: result.end.idle,
    noErrorBanner: !result.finalView.banner,
  };
  return result;
}

/**
 * Every stage the host presented decided on the card pinned to it, the last
 * decision terminal. How many stages is the host's call: the brief expected
 * two for the prescribed command; their number is recorded, not required.
 */
function stageVerdict(stages) {
  return {
    everyPresentedStageAccepted: stages.length >= 1 && stages.every((x) => x.approve.ok === true && x.cardPinnedToIt),
    lastDecisionTerminal: stages.at(-1)?.approve.result === "true",
  };
}

/** (3) An approval card open, only A's engine killed with the app open, then Reconnect. */
async function aDeath(app) {
  const sid = state().a;
  await guard(app, sid, FOLDERS.a);
  await app.ev(INSTALL_POLL_TAP);
  const result = { liveTurns: 1, start: await followUp(app, POWERSHELL) };
  const asked = await waitCard(app, "approvals");
  if (!asked) throw new Error(`no approval card within the bound; transcript: ${J(await turnLog(app, sid, POWERSHELL))}`);
  await sleep(1_000);
  const appPid = state().pid;
  const list = engines(appPid);
  const victim = list.filter((e) => pathKey(e.cwd) === pathKey(FOLDERS.a));
  if (victim.length !== 1) throw new Error(`expected one engine in A's folder, found ${victim.length}`);
  const others = list.filter((e) => e.pid !== victim[0].pid).map((e) => e.pid);
  const host = await appPending(app, sid);
  result.before = { msToCard: asked.msToCard, view: await app.ev(page("return view();")), appPending: host, engines: enginesView(list),
    victim: { pid: victim[0].pid, parentIsTheApp: true, folder: folderLabel(victim[0].cwd) } };
  const approvalId = host.approvals[0]?.approvalId ?? null;
  const from = await tapCount(app);
  const decides = (await ipc(app, "approve")).length;
  const killAt = await app.ev("Date.now() - window.__baselineIpc.t0");
  execFileSync("taskkill", ["/F", "/PID", String(victim[0].pid)], { stdio: "ignore" });
  const t0 = Date.now();
  const exited = await waitFor(async () => (await tapEvents(app, sid, from)).find((e) => e.kind === "host_exited") ?? null, 30_000, 300);
  result.after = { msToHostExited: exited ? Date.now() - t0 : null };
  await sleep(2_500);
  const log = await turnLog(app, sid, POWERSHELL);
  Object.assign(result.after, {
    view: await app.ev(page("return view();")),
    appAlive: alive(appPid),
    victimAlive: alive(victim[0].pid),
    otherEnginesAlive: others.filter((pid) => alive(pid)).length,
    otherEnginesBefore: others.length,
    transcript: log,
  });
  // A conversation started in this run is resumed by the app itself right
  // after host_exited (resume on open); one resumed at boot waits for Reconnect.
  const resumeSinceKill = async () => (await ipc(app, "resume_session")).filter((c) => c.atMs >= killAt && c.args?.sessionId === sid);
  const reconnectFrom = from;
  result.reconnect = (await resumeSinceKill()).length > 0
    ? { by: "the app, right after host_exited (resume on open)" }
    : { by: "the Reconnect button", click: await mouse(app, "return reconnectButton();") };
  const resumed = await waitFor(async () => { const c = (await resumeSinceKill()).at(-1); return c && c.ok !== undefined ? c : null; }, 120_000, 300);
  const connected = await waitFor(() => app.ev(page("return connection() === 'Connected' ? view() : null;")), 60_000, 500);
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const v = await app.ev(page("return view();"));
    samples.push({ atS: i, inputs: v.inputs.length, approvals: v.approvals.length });
    await sleep(1_000);
  }
  const meta = resumed?.ok ? parse(resumed.result) : null;
  const now = engines(appPid);
  Object.assign(result.reconnect, {
    resumeSession: { ok: resumed?.ok ?? null, running: meta?.running ?? null, error: resumed?.ok ? undefined : String(resumed?.result ?? "").slice(0, 300) },
    connection: connected?.connection ?? null,
    engines: enginesView(now),
    newEngineInA: now.some((e) => pathKey(e.cwd) === pathKey(FOLDERS.a) && e.pid !== victim[0].pid),
    cardSamples: samples,
    view: await app.ev(page("return view();")),
    appPending: await appPending(app, sid),
    eventsAfterResume: (await tapEvents(app, sid, reconnectFrom)).filter((e) => e.kind !== "host_exited").map((e) => ({ kind: e.kind, payload: e.payload.slice(0, 200) })),
    approveCallsSinceTheKill: (await ipc(app, "approve")).length - decides,
    transcriptTail: (await fullLog(app, sid)).slice(-5).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })),
  });
  result.measured = {
    approvalRequestsReissuedAfterResume: result.reconnect.eventsAfterResume.filter((e) => e.kind === "tool_request").length,
    approvalLines: log.filter((e) => e.role === "system" && e.text === APPROVAL_LINE).length,
  };
  result.verdict = {
    approvalPendingAtTheKill: Boolean(approvalId) && result.before.view.approvals.length === 1,
    onlyAsEngineKilled: !result.after.victimAlive && result.after.appAlive && result.after.otherEnginesAlive === result.after.otherEnginesBefore,
    hostExitedReported: Boolean(exited),
    cardRemoved: result.after.view.approvals.length === 0,
    transcriptSaysApprovalCancelled: result.measured.approvalLines === 1,
    reconnectWorks: result.reconnect.resumeSession.ok === true && result.reconnect.connection === "Connected" && result.reconnect.newEngineInA,
    noPhantomCard: samples.every((x) => x.approvals === 0 && x.inputs === 0),
    reissuedRequestsIgnored: result.measured.approvalRequestsReissuedAfterResume > 0 && samples.every((x) => x.approvals === 0),
    noDecisionSent: result.reconnect.approveCallsSinceTheKill === 0,
  };
  return result;
}

/** Whether the conversation still shows a running turn: row dot, health line, Stop and Guide offered. */
const liveness = (app, sid) => app.ev(page(`return { running: running(${J(sid)}), health: health(),
  turnControls: q('button').map((b) => (b.innerText || '').trim()).filter((t) => t === 'Stop' || t === 'Guide') };`));
const idleNow = (l) => l.running === "false" && !/working|No recent host update/i.test(l.health ?? "") && l.turnControls.length === 0;

/** No turn: the reopened conversation's liveness, read again (--conv p|q). */
async function stale(app) {
  const which = argValue("--conv", "q");
  const sid = state()[which];
  await guard(app, sid, FOLDERS[which]);
  const now = await liveness(app, sid);
  return { liveTurns: 0, conversation: which.toUpperCase(), secondsSinceTheInstanceStarted: Math.round((Date.now() - state().startedAt) / 1000),
    liveness: now, view: await app.ev(page("return view();")), verdict: { idle: idleNow(now) } };
}

/**
 * No turn, no action: a-death's reconnect read again from the page's own IPC
 * trace and poll tap (attached without resetting them), for a run whose
 * harness looked for the Reconnect button after the app had resumed by itself.
 */
async function aDeathTrace(app) {
  const sid = state().a;
  const record = readJson(OUT, null);
  const p = record?.phases?.["a-death"];
  if (!p) throw new Error("no a-death record");
  const facts = await app.ev(`(() => {
    const calls = window.__baselineIpc.calls.filter((c) => c.args && c.args.sessionId === ${J(sid)});
    const events = window.__m05tap.events.filter((e) => e.sid === ${J(sid)});
    const exited = events.find((e) => e.kind === 'host_exited');
    return {
      hostExitedAtMs: exited ? exited.atMs : null,
      resumeSince: calls.filter((c) => c.cmd === 'resume_session' && exited && c.atMs >= exited.atMs).map((c) => ({ atMs: c.atMs, ok: c.ok, result: String(c.result || '').slice(0, 300) })),
      approveSince: calls.filter((c) => c.cmd === 'approve' && exited && c.atMs >= exited.atMs).length,
      eventsSince: events.filter((e) => exited && e.atMs > exited.atMs).map((e) => ({ atMs: e.atMs, kind: e.kind, payload: e.payload.slice(0, 200) })),
    };
  })()`);
  const resume = facts.resumeSince[0] ?? null;
  const flag = (name) => { const m = String(resume?.result ?? "").match(new RegExp(`"${name}":(true|false)`)); return m ? m[1] === "true" : null; };
  p.reconnect.by = "the app, right after host_exited (resume on open)";
  p.reconnect.autoResume = { msAfterHostExited: resume ? resume.atMs - facts.hostExitedAtMs : null, ok: resume?.ok ?? null, running: flag("running"), loaded: flag("loaded"),
    eventsAfterHostExited: facts.eventsSince, approveCallsSinceHostExited: facts.approveSince };
  p.measured.approvalRequestsReissuedAfterResume = facts.eventsSince.filter((e) => e.kind === "tool_request").length;
  delete p.measured.reissuedApprovalRequestsAfterResume;
  p.verdict.reconnectWorks = resume?.ok === true && p.reconnect.connection === "Connected" && p.reconnect.newEngineInA === true;
  p.verdict.reissuedRequestsIgnored = p.measured.approvalRequestsReissuedAfterResume > 0 && p.verdict.noPhantomCard === true;
  p.note = "The Reconnect click found no button: A was started in this run, so the app resumed it by itself right after host_exited. reconnect.autoResume, the reissue count and verdict.reconnectWorks were read after the phase (a-death-trace) from the page's own IPC trace and poll tap, no action taken.";
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return { liveTurns: 0, readFrom: "the page's own IPC trace and poll tap, not reset", facts: { hostExitedAtMs: facts.hostExitedAtMs, resume: p.reconnect.autoResume },
    verdict: { reconnectWorks: p.verdict.reconnectWorks, reissuedRequestsIgnored: p.verdict.reissuedRequestsIgnored } };
}

/**
 * No turn: the Reconnect button itself. After a relaunch A is resumed at boot,
 * so the app leaves its reconnection to the user: A's idle engine killed, then
 * Reconnect clicked.
 */
async function aReconnect(app) {
  const sid = state().a;
  await guard(app, sid, FOLDERS.a);
  await app.ev(INSTALL_POLL_TAP);
  await waitFor(() => app.ev(page("return connection() === 'Connected';")), 90_000, 500);
  const appPid = state().pid;
  const list = engines(appPid);
  const victim = list.filter((e) => pathKey(e.cwd) === pathKey(FOLDERS.a));
  if (victim.length !== 1) throw new Error(`expected one engine in A's folder, found ${victim.length}`);
  const from = await tapCount(app);
  const killAt = await app.ev("Date.now() - window.__baselineIpc.t0");
  execFileSync("taskkill", ["/F", "/PID", String(victim[0].pid)], { stdio: "ignore" });
  const exited = await waitFor(async () => (await tapEvents(app, sid, from)).find((e) => e.kind === "host_exited") ?? null, 30_000, 300);
  await sleep(3_000);
  const resumeSinceKill = async () => (await ipc(app, "resume_session")).filter((c) => c.atMs >= killAt && c.args?.sessionId === sid);
  const result = { liveTurns: 0, killed: { folder: folderLabel(victim[0].cwd), parentIsTheApp: true }, hostExited: Boolean(exited),
    beforeClick: { view: await app.ev(page("return view();")), resumesSinceKill: (await resumeSinceKill()).length } };
  result.click = await mouse(app, "return reconnectButton();");
  const resumed = await waitFor(async () => { const c = (await resumeSinceKill()).at(-1); return c && c.ok !== undefined ? c : null; }, 120_000, 300);
  const connected = await waitFor(() => app.ev(page("return connection() === 'Connected';")), 60_000, 500);
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const v = await app.ev(page("return view();"));
    samples.push({ atS: i, inputs: v.inputs.length, approvals: v.approvals.length });
    await sleep(1_000);
  }
  const now = engines(appPid);
  result.after = { resumeSession: { ok: resumed?.ok ?? null, running: /"running":true/.test(resumed?.result ?? "") }, connected: Boolean(connected),
    engines: enginesView(now), cardSamples: samples, view: await app.ev(page("return view();")),
    eventsSinceKill: (await tapEvents(app, sid, from)).map((e) => ({ kind: e.kind, payload: e.payload.slice(0, 160) })) };
  result.verdict = {
    leftToTheUser: result.beforeClick.resumesSinceKill === 0 && result.beforeClick.view.reconnect?.disabled === false,
    reconnectClicked: result.click.clicked === true,
    reconnectWorks: resumed?.ok === true && Boolean(connected) && now.some((e) => pathKey(e.cwd) === pathKey(FOLDERS.a) && e.pid !== victim[0].pid),
    noPhantomCard: samples.every((x) => x.inputs === 0 && x.approvals === 0),
  };
  return result;
}

async function stopPhase(app) {
  const close = await closeApp(app);
  return { liveTurns: 0, close, verdict: { closedFromItsWindow: close.graceful && close.exited, enginesEnded: close.enginesAliveAfter === 0 } };
}

/** Per-item verdicts, derived from the stored phases: no app. */
function summary() {
  const record = readJson(OUT, null);
  if (!record) throw new Error("no record");
  const p = record.phases;
  const all = (v) => Boolean(v) && Object.values(v).every((x) => x === true);
  const inputLines = (t) => (t ?? []).filter((e) => e.role === "tool" && e.text.startsWith("Input requested:")).length;
  const raw = (key) => p[key] && {
    resumeSession: p[key].resume?.session ?? null,
    listsAfterResume: (p[key].listPendingAfterResume?.userInputs ?? []).map((u) => ({ userInputId: u.userInputId, turnId: u.turnId })),
    reissued: p[key].verdict?.questionReissuedAfterResume ?? null,
  };
  const dead = p["q-restart"]?.question ?? null;
  const listsDead = (key) => (p[key]?.listPendingAfterResume?.userInputs ?? []).some((u) => u.userInputId === dead);
  record.summary = {
    "1 double answer": {
      prefix: p["p-double"]?.measured ?? null,
      fixed: p["q-double"]?.measured ?? null,
      fixedAgain: p["q-double-2"]?.measured ?? null,
      verdict: all(p["q-double"]?.verdict) && all(p["q-double-2"]?.verdict) ? "pass" : "fail",
    },
    "2 restart with a question pending": {
      prefix: p["p-restart"]?.measured ?? null,
      fixed: p["q-restart"]?.measured ?? null,
      verdict: all(p["q-restart"]?.verdict) ? "pass" : "fail",
    },
    "3 host death with an approval card": {
      measured: p["a-death"]?.measured ?? null,
      reconnectedBy: p["a-death"]?.reconnect?.by ?? null,
      reconnectButtonAfterABootResume: p["a-reconnect"]?.verdict ?? null,
      verdict: all(p["a-death"]?.verdict) && all(p["a-reconnect"]?.verdict) ? "pass" : "fail",
    },
    "4 approval regression after 9771bdb": {
      stagesPresentedByTheHost: p["a-reload"]?.stages?.length ?? null,
      verdict: all(p["a-reload"]?.verdict) ? "pass" : "fail",
    },
    "5 9771bdb discriminating": {
      deadQuestion: dead,
      hostBefore: raw("msp-raw-1"),
      appReadAfterRestart: p["q-restart"]?.after?.appPending ?? null,
      appBootReadDuringTheNextTurn: p["q-double"]?.reload?.bootListPending ?? null,
      hostAfter: raw("msp-raw-2"),
      verdict: Boolean(dead) && listsDead("msp-raw-1") && listsDead("msp-raw-2")
        && p["msp-raw-1"]?.resume?.session?.activeTurnId === null
        && !(p["q-restart"]?.after?.appPending?.userInputs ?? [{}]).some((u) => u.inputId === dead)
        && p["q-restart"]?.verdict?.noPhantomCard === true
        && p["q-double"]?.verdict?.bootReadCarriedOnlyTheLiveQuestion === true
        && p["q-double"]?.verdict?.reloadRebuiltOnlyTheLiveCard === true ? "pass" : "fail",
    },
    "found on the way: a conversation reopened after the restart stayed working": {
      prefix: p["stale-p"]?.liveness ?? null,
      fixed: p["q-restart"]?.after?.livenessAfterAMinute ?? null,
      verdict: p["stale-p"]?.verdict?.idle === false && p["q-restart"]?.verdict?.notLeftWorking === true ? "fixed" : "open",
    },
    "found on the way: a waiting question's line lost by a reload or a restart": {
      before: p["q-double"] && { storedWhileWaiting: p["q-double"].card?.inputLine?.stored ?? null, linesAtTheEnd: inputLines(p["q-double"].transcript) },
      after: p["q-double-2"] && { storedWhileWaiting: p["q-double-2"].card?.inputLine?.stored ?? null, renderedAfterTheReload: p["q-double-2"].reload?.inputLineRendered ?? null,
        linesAtTheEnd: inputLines(p["q-double-2"].transcript) },
      verdict: p["q-double"]?.card?.inputLine?.stored === false && inputLines(p["q-double"]?.transcript) === 0
        && p["q-double-2"]?.card?.inputLine?.stored === true && p["q-double-2"]?.reload?.inputLineRendered === true
        && inputLines(p["q-double-2"]?.transcript) === 1 ? "fixed" : "open",
    },
  };
  record.liveTurnsDetail = Object.entries(p).filter(([, v]) => (v.liveTurns ?? 0) > 0)
    .map(([key, v]) => ({ phase: key, build: v.build, buildCommit: v.buildCommit, exeSha256: v.exeSha256, liveTurns: v.liveTurns }));
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.summary;
}

// ---- main ---------------------------------------------------------------------------

const PHASES = {
  probe,
  "p-double": (app) => double(app, FOLDERS.p, "p", { reload: false }),
  "q-double": (app) => double(app, FOLDERS.q, "q", { reload: true }),
  "a-reload": aReload,
  "a-death": aDeath,
  stale,
  "a-death-trace": aDeathTrace,
  "a-reconnect": aReconnect,
  stop: stopPhase,
};
if (PHASE === "rederive") {
  // a-reload's stage verdict recomputed from its stored stages: no app, no turn.
  const record = readJson(OUT, null);
  const p = record?.phases?.["a-reload"];
  if (!p?.stages) throw new Error("no stored a-reload stages");
  delete p.verdict.everyStageAccepted;
  Object.assign(p.verdict, stageVerdict(p.stages));
  p.measured = { ...(p.measured ?? {}), stagesPresentedByTheHost: p.stages.length };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}
`);
  process.stdout.write(`${JSON.stringify({ verdict: p.verdict, measured: p.measured }, null, 2)}
`);
  process.exit(0);
}
if (PHASE === "summary") {
  process.stdout.write(`${JSON.stringify(summary(), null, 2)}\n`);
  process.exit(0);
}
if (!["launch", "relaunch", "p-restart", "q-restart"].includes(PHASE) && !PHASES[PHASE]) {
  process.stderr.write("usage: cdp-m0-05-complement.mjs <launch|relaunch|probe|p-double|p-restart|q-restart|stale|q-double|a-reload|a-death|a-death-trace|a-reconnect|stop|summary|rederive>"
    + " [--base dir] [--bin dir] [--exe file] [--build prefix|fixed] [--out file]\n");
  process.exit(1);
}
let app = null;
let key = argValue("--as", PHASE === "stale" ? `stale-${argValue("--conv", "q")}` : PHASE);
if (PHASE === "stop") {
  // One record per stop: numbered by data folder and order on it.
  saveState({ stops: (state().stops ?? 0) + 1 });
  key = `stop-${state().launches}.${state().stops}`;
}
try {
  let result;
  if (PHASE === "launch") ({ app, result } = await launch());
  else if (PHASE === "relaunch") ({ app, result } = await relaunch());
  else {
    if (!state().pid || !alive(state().pid)) throw new Error("the harness's app instance is not running: run launch first");
    app = await attach({ trace: PHASE !== "a-death-trace" });
    if (PHASE === "p-restart" || PHASE === "q-restart") {
      ({ app, result } = await restart(app, PHASE === "p-restart" ? FOLDERS.p : FOLDERS.q, PHASE === "p-restart" ? "p" : "q"));
    } else result = await PHASES[PHASE](app);
  }
  if (PHASE !== "stop" && app) {
    result.consoleErrors = app.errors.slice(0, 20);
    result.bundle = await app.ev("[...document.scripts].map((s) => s.src.split('/').pop()).filter(Boolean)");
  }
  // Launches are numbered by data folder, relaunches by order on it.
  if (PHASE === "launch") key = `launch-${state().launches}`;
  if (PHASE === "relaunch" && !process.argv.includes("--as")) {
    saveState({ relaunches: (state().relaunches ?? 0) + 1 });
    key = `relaunch-${state().launches}.${state().relaunches}`;
  }
  const written = merge(key, result);
  process.stdout.write(`${JSON.stringify(written.verdict ?? written, null, 2)}\n`);
} catch (error) {
  merge(`${key}-failure-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`, { failure: String(error?.message ?? error).slice(0, 600), consoleErrors: app?.errors.slice(0, 20) ?? [] });
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  app?.close();
}
