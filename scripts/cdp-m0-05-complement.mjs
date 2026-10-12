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
 * Final run (m0-05-final.json), conversations A and B in folders a and b:
 *   pair        2 turns. B asks a bound multi-select question, then A a
 *               single-select one: both wait at once (2). A's exact
 *               input_request event is copied into B through a poll_events
 *               response (1; the host mints a fresh id per question, so a real
 *               collision cannot be produced). A answered with real clicks
 *               while B waits; then B: one box, refused -32057, then the
 *               second box on the same card, no reload, accepted (4). A reload
 *               drops the forged card at the end.
 *   skip        1 turn. (3) Two questions in a row in A: Skip clicked once on
 *               the first, double-clicked on the second; cancel_input counted
 *               on the transport and through invoke (countInvokes).
 *   skip-double 1 turn, only if skip got no second question: one question,
 *               Skip double-clicked.
 *   q-death     1 turn. (5) A question card, only A's engine killed.
 *   b-restart   1 turn. (5) A question pending in B, the app closed from its
 *               window, relaunched (q-restart's steps).
 *   stale-kill  1 turn. (5) A two-stage approval in A: two single clicks on
 *               Allow once before the card repaints the next stage, the second
 *               refused -32053 and said calmly; the card left pending, the
 *               app force-killed (taskkill /F), relaunched on the same data
 *               folder, A reopened.
 *   final-summary  no app: per-item verdicts of the final record.
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
 * Final run (06/10/2026), one build, MUSE_CDP_PORT=9335, --base
 * G:\muse-proofs\m0-05c, --bin G:\muse-proofs\m0-05c\bin, --engine the staged
 * engine, --out .../m0-05-final.json: launch --exe muse-desktop-final.exe,
 * probe, pair, skip, q-death, b-restart, stale-kill, stop, final-summary.
 *
 * Usage:
 *   node scripts/cdp-m0-05-complement.mjs <phase> [--base G:\muse-proofs\m0-05b\run]
 *     [--bin G:\muse-proofs\m0-05b\bin] [--exe <file>] [--build prefix|fixed]
 *     [--as <key>] [--conv p|q] [--engine <muse exe>]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-05-complement.json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// The isolated instance's own port: 9222 is a developer's app; the final run passed MUSE_CDP_PORT=9335.
process.env.MUSE_CDP_PORT ??= "9333";
const { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const PHASE = process.argv[2];
const BASE = argValue("--base", "G:\\muse-proofs\\m0-05b\\run");
const BIN = argValue("--bin", "G:\\muse-proofs\\m0-05b\\bin");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-05-complement.json");
const ENGINE = resolve(argValue("--engine", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const STATE = join(BASE, "harness-state.json");
const FOLDERS = { p: join(BASE, "p"), q: join(BASE, "q"), a: join(BASE, "a"), b: join(BASE, "b") };
const J = JSON.stringify;

// The tool takes 2-3 options per question (m0-05-questions.json, stuck).
const FRUIT = 'Before anything else, call your request_user_input tool exactly once, with one single-select question: id "fruit", header "Fruit", question "Which fruit should I name?", options "Apple", "Banana", "Cherry". After my answer, reply with only the fruit I picked, in capital letters. Use no other tool.';
// The reliable Ask-posture prompt: a compound command the host cannot clear statically.
const POWERSHELL = "Use your PowerShell tool to run EXACTLY this command, unchanged, once: $m = 'm05'; Set-Content -Path (Join-Path (Get-Location) 'probe.txt') -Value $m";
// The bound multi-select question of m0-05-questions.json (answer-b): one box is refused -32057.
const COLORS = 'Before anything else, call your request_user_input tool exactly once, with one multi-select question: id "colors", header "Colors", question "Pick exactly two colors", options "Red", "Green", "Blue", selection {"mode": "multiple", "min_selections": 2, "max_selections": 2}. After my answer, reply with only the colors I picked, in capital letters, joined by a plus sign. Use no other tool.';
// Two questions in one turn, the second asked whatever happened to the first.
const SKIP2 = 'Before anything else, call your request_user_input tool twice, one call after the other, never both questions in one call. First call: one single-select question, id "first", header "First", question "Which fruit comes first?", options "Apple", "Banana", "Cherry". Second call, made even if I skip the first question: one single-select question, id "second", header "Second", question "Which fruit comes second?", options "Apple", "Banana", "Cherry". Then reply with exactly one line, first=X second=Y, where X and Y are the fruits I picked in capital letters, or SKIPPED for a question I skipped. Use no other tool.';
// skip-double's single question, if skip got no second one.
const SKIP1 = 'Before anything else, call your request_user_input tool exactly once, with one single-select question: id "only", header "Only", question "Which fruit should I name?", options "Apple", "Banana", "Cherry". Then reply with exactly one line, choice=X, where X is the fruit I picked in capital letters, or SKIPPED if I skipped the question. Use no other tool.';
// The recipe of m0-05-06-approvals.json (allow-fixed, two, forged): two stages each time.
const TWO_STAGE = "Use your PowerShell tool to run exactly this command in the workspace, unchanged, once: $m = 'm05-final'; Set-Content -Path probe.txt -Value $m";
const APPROVAL_LINE = "Approval cancelled: Muse stopped before you answered, so the action did not run.";
const APPROVAL_RESTART_LINE = "Approval cancelled: Muse closed before you answered, so the action did not run.";
const INPUT_RESTART_LINE = "Input cancelled: Muse closed before you answered.";
const INPUT_STOPPED_LINE = "Input cancelled: Muse stopped before you answered.";
const STALE_NOTICE = "This approval changed before your answer reached Muse; the card now shows the current step.";

// ---- state, record, redaction ------------------------------------------------

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));
const parse = (text) => { try { return JSON.parse(text); } catch { return text ?? null; } };
const pathKey = (p) => String(p ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function redact(value) {
  const pairs = [[FOLDERS.p, "<folder P>"], [FOLDERS.q, "<folder Q>"], [FOLDERS.a, "<folder A>"], [FOLDERS.b, "<folder B>"], [BASE, "<proof>"], [BIN, "<bin>"],
    [dirname(ENGINE), "<engine dir>"], [resolve("."), "<repo>"]];
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
  const name = basename(OUT, ".json");
  const record = readJson(OUT, {
    schema: `muse-desktop.${name}.v1`,
    ticket: "M0-05",
    complements: ["m0-05-questions.json", "m0-05-06-approvals.json", ...(name === "m0-05-complement" ? [] : ["m0-05-complement.json"])],
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.platform = `win32 ${release()}, debug build in its isolated test mode (ADR 0003), WebView2 over CDP`;
  record.engine = engineVersion();
  record.engineSha256 ??= sha256(ENGINE);
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
  const taken = () => fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError");
  // A force-killed instance's WebView2 browser can hold the port a few seconds.
  if (restart) await waitFor(async () => !(await taken()), 30_000, 1_000);
  if (await taken()) throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
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
  const cardNode = (key) => inputNodes().find((c) => cardKey(c) === key) || null;
  const inputCards = () => inputNodes().map((c) => ({
    key: cardKey(c),
    questions: [...c.querySelectorAll('.input-question')].map((g) => ({
      question: g.getAttribute('aria-label'),
      choices: [...g.querySelectorAll('button')].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') === 'true' })),
      boxes: [...g.querySelectorAll('label.check')].map((l) => ({ label: text(l), checked: l.querySelector('input').checked })),
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
      for (const e of body.events || []) tap.events.push({ atMs: Date.now() - tap.t0, sid: e.session_id, kind: e.kind, payload: String(e.payload || '').slice(0, 2000) });
    } catch { /* a poll the tap cannot read stays the app's */ }
    return response;
  };
  return 'installed';
})()`;
const tapEvents = (app, sid, from = 0) => app.ev(`window.__m05tap ? window.__m05tap.events.slice(${from}).filter((e) => e.sid === ${J(sid)}) : []`);
const tapCount = (app) => app.ev("window.__m05tap ? window.__m05tap.events.length : 0");

/**
 * The pair phase's forgery, on the same path (cdp-m0-05-06-approvals.mjs,
 * forged): every input_request the bridge delivers is kept whole, and a queued
 * event is appended to the next poll_events response the app reads.
 */
const INSTALL_FORGE = `(() => {
  const forge = window.__m05forge = window.__m05forge || { installed: false, queue: [], applied: [], seen: [] };
  if (forge.installed) return 'kept';
  forge.installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!/^https?:\\/\\/ipc\\.localhost\\/poll_events/.test(url) || /m05/.test(String((init && init.body) || ''))) return original(input, init);
    const response = await original(input, init);
    if (response.headers.get('Tauri-Response') !== 'ok') return response;
    const body = await response.clone().json();
    for (const e of body.events || []) if (e.kind === 'input_request') forge.seen.push(JSON.parse(JSON.stringify(e)));
    if (forge.queue.length === 0) return response;
    const forged = forge.queue.splice(0);
    forge.applied.push(...forged.map((e) => ({ session_id: e.session_id, kind: e.kind, seq: e.seq })));
    body.events = [...(body.events || []), ...forged];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
  };
  return 'installed';
})()`;

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
    + " args: cmd === 'answer_input' || cmd === 'cancel_input' || cmd === 'approve' ? JSON.parse(JSON.stringify(args)) : undefined }); return false; })"
    + "(globalThis.__m05invoke || (globalThis.__m05invoke = { t0: Date.now(), polls: 0, calls: [] }), arguments[0], arguments[1])";
  const bp = await app.send("Debugger.setBreakpointOnFunctionCall", { objectId: fn.result.objectId, condition });
  await sleep(1_500);
  const polls = await app.ev("globalThis.__m05invoke.polls");
  return { wrapperRefused: refused, method: "Debugger.setBreakpointOnFunctionCall (condition records, returns false)", installed: Boolean(bp?.breakpointId), pollsSeenIn1500ms: polls };
}

/** Every click and double-click the question and approval cards' buttons receive, capture phase, before React. */
const INSTALL_CLICK_LOG = `(() => {
  const log = window.__m05clicks = window.__m05clicks || { t0: Date.now(), events: [], installed: false };
  if (log.installed) return 'kept';
  log.installed = true;
  for (const type of ['click', 'dblclick']) document.addEventListener(type, (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !b.closest('section[aria-label="Pending input"], section[aria-label="Conversation authorization"]')) return;
    log.events.push({ type, detail: e.detail, button: (b.innerText || '').trim(), atMs: Date.now() - log.t0 });
  }, true);
  return 'installed';
})()`;

/**
 * What the app's list_pending_requests returns for `sid` (9771bdb's filtered
 * read). Not read-only: the command also rebuilds the app's approval registry
 * for that conversation from the same read (drops the approvals it does not
 * list, re-pins the listed ones to their current requirement).
 */
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
// A button or a checkbox of the question card keyed `key` ("<session>:<question>").
const keyButton = (key, label) => `return [...(cardNode(${J(key)})?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === ${J(label)}) || null;`;
const keyBox = (key, label) => `const l = [...(cardNode(${J(key)})?.querySelectorAll('.input-question label.check') ?? [])].find((n) => text(n) === ${J(label)});
  return l ? l.querySelector('input') : null;`;

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
    // The note names the selected folder: "Runs in <name>. ..." or "Runs in <name> with ...".
    const named = (n) => n.includes(${J(`Runs in ${basename(folder)}.`)}) || n.includes(${J(`Runs in ${basename(folder)} with`)});
    let note = '';
    for (let i = 0; i < 80; i++) { note = text(document.querySelector('.welcome-project-note')) || ''; if (named(note)) break; await pause(100); }
    if (!named(note)) return { started: false, reason: 'project not selected: ' + note };
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

/**
 * Wait until the turn is over: not running, no card, nothing in progress.
 * `except`: a card key left out (the pair phase's forged card, which keeps
 * the health line on "Waiting for your answer").
 */
async function untilIdle(app, sid, timeoutMs = 180_000, except = null) {
  const t0 = Date.now();
  const busy = except ? /working|resuming|stopping|retrying/i : /working|resuming|waiting|stopping|retrying/i;
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${J(sid)}) };`));
    return s.running === "false" && s.inputs.every((c) => c.key === except) && s.approvals.length === 0
      && !busy.test(s.health ?? "") ? s : null;
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

/**
 * (3) An approval card open (q-death, final 5: a question card), only A's
 * engine killed with the app open, then its reconnection. The keys of a-death's
 * record are kept for the approval card.
 */
async function aDeath(app, { prompt = POWERSHELL, kind = "approvals" } = {}) {
  const K = kind === "inputs"
    ? { pending: "questionPendingAtTheKill", says: "transcriptSaysInputCancelled", line: INPUT_STOPPED_LINE, request: "input_request",
      lines: "inputLines", reissued: "inputRequestsReissuedAfterResume", calls: "answerCallsSinceTheKill", none: "noAnswerSent", cmds: ["answer_input", "cancel_input"] }
    : { pending: "approvalPendingAtTheKill", says: "transcriptSaysApprovalCancelled", line: APPROVAL_LINE, request: "tool_request",
      lines: "approvalLines", reissued: "approvalRequestsReissuedAfterResume", calls: "approveCallsSinceTheKill", none: "noDecisionSent", cmds: ["approve"] };
  const sends = async () => (await Promise.all(K.cmds.map((cmd) => ipc(app, cmd)))).flat().length;
  const sid = state().a;
  await guard(app, sid, FOLDERS.a);
  await app.ev(INSTALL_POLL_TAP);
  const result = { liveTurns: 1, start: await followUp(app, prompt) };
  const asked = await waitCard(app, kind);
  if (!asked) throw new Error(`no ${kind} card within the bound; transcript: ${J(await turnLog(app, sid, prompt))}`);
  await sleep(1_000);
  const appPid = state().pid;
  const list = engines(appPid);
  const victim = list.filter((e) => pathKey(e.cwd) === pathKey(FOLDERS.a));
  if (victim.length !== 1) throw new Error(`expected one engine in A's folder, found ${victim.length}`);
  const others = list.filter((e) => e.pid !== victim[0].pid).map((e) => e.pid);
  const host = await appPending(app, sid);
  result.before = { msToCard: asked.msToCard, view: await app.ev(page("return view();")), appPending: host, engines: enginesView(list),
    victim: { pid: victim[0].pid, parentIsTheApp: true, folder: folderLabel(victim[0].cwd) } };
  const pendingId = kind === "inputs" ? host.userInputs?.[0]?.inputId ?? null : host.approvals[0]?.approvalId ?? null;
  const from = await tapCount(app);
  const decides = await sends();
  const killAt = await app.ev("Date.now() - window.__baselineIpc.t0");
  execFileSync("taskkill", ["/F", "/PID", String(victim[0].pid)], { stdio: "ignore" });
  const t0 = Date.now();
  const exited = await waitFor(async () => (await tapEvents(app, sid, from)).find((e) => e.kind === "host_exited") ?? null, 30_000, 300);
  result.after = { msToHostExited: exited ? Date.now() - t0 : null };
  await sleep(2_500);
  const log = await turnLog(app, sid, prompt);
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
    [K.calls]: (await sends()) - decides,
    transcriptTail: (await fullLog(app, sid)).slice(-5).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })),
  });
  result.measured = {
    [K.reissued]: result.reconnect.eventsAfterResume.filter((e) => e.kind === K.request).length,
    [K.lines]: log.filter((e) => e.role === "system" && e.text === K.line).length,
  };
  result.verdict = {
    [K.pending]: Boolean(pendingId) && result.before.view[kind].length === 1,
    onlyAsEngineKilled: !result.after.victimAlive && result.after.appAlive && result.after.otherEnginesAlive === result.after.otherEnginesBefore,
    hostExitedReported: Boolean(exited),
    cardRemoved: result.after.view[kind].length === 0,
    [K.says]: result.measured[K.lines] === 1,
    reconnectWorks: result.reconnect.resumeSession.ok === true && result.reconnect.connection === "Connected" && result.reconnect.newEngineInA,
    noPhantomCard: samples.every((x) => x.approvals === 0 && x.inputs === 0),
    // A question: the count of re-issued requests is recorded, not required (the engine's call).
    reissuedRequestsIgnored: (kind === "inputs" || result.measured[K.reissued] > 0) && samples.every((x) => x[kind] === 0),
    [K.none]: result.reconnect[K.calls] === 0,
  };
  return result;
}

/** A question as the bridge delivered it (the forge keeps every input_request whole). */
async function delivered(app, sid, inputId) {
  const e = await app.ev(`(window.__m05forge ? window.__m05forge.seen : []).find((x) => x.session_id === ${J(sid)} && x.payload.includes(${J(`"inputId":"${inputId}"`)})) || null`);
  const p = e ? parse(e.payload) : null;
  return p && { inputId: p.inputId, toolName: p.toolName, questions: (p.questions ?? []).map((x) => ({ id: x.id, mode: x.mode,
    minSelections: x.minSelections ?? null, maxSelections: x.maxSelections ?? null, options: (x.options ?? []).map((o) => o.label) })) };
}
const markers = (app) => app.ev(page("return { inputs: store('muse-desktop.pending-inputs.v1', '[]'), approvals: store('muse-desktop.pending-approvals.v1', '[]') };"));
const invokeCalls = (app, cmd, from = 0) => app.ev(`globalThis.__m05invoke ? globalThis.__m05invoke.calls.filter((c) => c.cmd === ${J(cmd)}).slice(${from}) : []`);
const sentLabels = (args) => (args?.answers ?? []).flatMap((a) => a.selectedLabels ?? (a.selectedLabel ? [a.selectedLabel] : []));
const words = (text) => String(text ?? "").toUpperCase().match(/[A-Z]+/g) ?? [];

/**
 * (1, 2, 4) B asks a bound multi-select question, then A a single-select one:
 * both wait at once. A's exact input_request event is copied into B (forge).
 * A answered with real clicks while B waits; then B's own card: one box,
 * refused by the host's bound, then the second box on the same card, no
 * reload, accepted. A reload at the end drops the forged card.
 */
async function pair(app) {
  if (state().a || state().b) throw new Error("conversations A and B already exist: pair needs a fresh data folder");
  await app.ev(INSTALL_POLL_TAP);
  await app.ev(INSTALL_FORGE);
  // Any reload replaces the page and loses this mark.
  const pageMark = await app.ev("(window.__m05page = window.__m05page || String(Math.random()).slice(2))");
  const result = { liveTurns: 2 };

  // B first: its question waits through everything A does.
  const b = await startViaWelcome(app, FOLDERS.b, COLORS);
  saveState({ b: b.sid });
  await guard(app, b.sid, FOLDERS.b);
  const bAsked = await waitCard(app, "inputs");
  if (!bAsked) throw new Error(`no question card in B within the bound; transcript: ${J(await turnLog(app, b.sid, COLORS))}`);
  const keyB = bAsked.view.inputs[0].key;
  const idB = keyB?.split(":")[1] ?? null;
  result.b = { start: b, msToCard: bAsked.msToCard, approvalsAllowedFirst: bAsked.approvalsAllowedFirst, card: bAsked.view.inputs[0], question: await delivered(app, b.sid, idB) };

  const a = await startViaWelcome(app, FOLDERS.a, FRUIT);
  saveState({ a: a.sid });
  await guard(app, a.sid, FOLDERS.a);
  const aAsked = await waitCard(app, "inputs");
  if (!aAsked) throw new Error(`no question card in A within the bound; transcript: ${J(await turnLog(app, a.sid, FRUIT))}`);
  const keyA = aAsked.view.inputs[0].key;
  const idA = keyA?.split(":")[1] ?? null;
  result.a = { start: a, msToCard: aAsked.msToCard, approvalsAllowedFirst: aAsked.approvalsAllowedFirst, card: aAsked.view.inputs[0] };
  await sleep(1_500);
  result.bothWaiting = { markers: await markers(app), hostA: await appPending(app, a.sid), hostB: await appPending(app, b.sid) };

  // (1) A's input_request, as the bridge delivered it, copied into B: only session_id changes.
  const live = await waitFor(() => app.ev(`window.__m05forge.seen.find((e) => e.session_id === ${J(a.sid)} && e.payload.includes(${J(`"inputId":"${idA}"`)})) || null`), 10_000, 300);
  if (!live) throw new Error("A's input_request was not seen on poll_events");
  await app.ev(`(window.__m05forge.queue.push(Object.assign(JSON.parse(${J(J(live))}), { session_id: ${J(b.sid)} })), true)`);
  result.forged = { from: "A's input_request event, every field kept but session_id", seq: live.seq, payload: parse(live.payload),
    applied: Boolean(await waitFor(() => app.ev("window.__m05forge.applied.length > 0"), 10_000, 200)) };
  await sleep(1_000);
  await guard(app, b.sid, FOLDERS.b);
  result.bBefore = await app.ev(page("return view();"));
  await guard(app, a.sid, FOLDERS.a);
  result.aBefore = await app.ev(page("return view();"));

  // (1, 2) A answered with real clicks, B waiting.
  result.invokeCounter = await countInvokes(app);
  await app.ev(INSTALL_CLICK_LOG);
  const n = { fetch: (await ipc(app, "answer_input")).length, tap: await tapCount(app) };
  result.answerA = { pick: await mouse(app, keyButton(keyA, "Banana")) };
  await sleep(400);
  result.answerA.send = await mouse(app, keyButton(keyA, "Send answer"));
  await nextIpc(app, "answer_input", n.fetch, 30_000);
  result.answerA.end = await untilIdle(app, a.sid);
  result.answerA.answerInputFetch = (await ipc(app, "answer_input")).slice(n.fetch).map((c) => ({ ok: c.ok, args: c.args }));
  result.answerA.answerInputInvoke = await invokeCalls(app, "answer_input");
  result.answerA.transcript = await turnLog(app, a.sid, FRUIT);
  result.answerA.reply = reply(result.answerA.transcript);
  const settledSince = async (sid, from) => (await tapEvents(app, sid, from)).filter((e) => e.kind === "input_settled").map((e) => e.payload);
  result.answerA.settledA = await settledSince(a.sid, n.tap);

  // B after A's answer: both of its cards, its host, its events.
  await guard(app, b.sid, FOLDERS.b);
  result.bAfterA = { view: await app.ev(page("return view();")), host: await appPending(app, b.sid), settledB: await settledSince(b.sid, n.tap), markers: await markers(app) };

  // (4) B's own card: one box, refused by the host's bound (min_selections 2).
  const q0 = result.b.question?.questions?.[0] ?? null;
  const [one, two] = (q0?.options ?? []).slice(1, 3);
  await app.ev(page(`cardNode(${J(keyB)}).dataset.m05 = 'before-refusal'; return true;`));
  const n1 = { fetch: (await ipc(app, "answer_input")).length, invoke: (await invokeCalls(app, "answer_input")).length };
  result.refused = { pick: await mouse(app, keyBox(keyB, one)) };
  await sleep(400);
  result.refused.send = await mouse(app, keyButton(keyB, "Send answer"));
  const refusedCall = await nextIpc(app, "answer_input", n1.fetch, 30_000);
  await sleep(1_500);
  result.refused.call = refusedCall && { ok: refusedCall.ok, args: refusedCall.args, result: String(refusedCall.result ?? "").slice(0, 300) };
  result.refused.after = { view: await app.ev(page("return view();")), sameCardNode: await app.ev(page(`return cardNode(${J(keyB)})?.dataset.m05 === 'before-refusal';`)),
    host: await appPending(app, b.sid) };
  // Then the second box on the same card, no reload: the corrected answer.
  const n2 = { fetch: (await ipc(app, "answer_input")).length, tap: await tapCount(app) };
  result.corrected = { pick: await mouse(app, keyBox(keyB, two)) };
  await sleep(400);
  result.corrected.atSend = { card: (await app.ev(page("return view();"))).inputs.find((c) => c.key === keyB) ?? null,
    sameCardNode: await app.ev(page(`return cardNode(${J(keyB)})?.dataset.m05 === 'before-refusal';`)),
    samePage: (await app.ev("window.__m05page || null")) === pageMark };
  result.corrected.send = await mouse(app, keyButton(keyB, "Send answer"));
  const correctedCall = await nextIpc(app, "answer_input", n2.fetch, 30_000);
  result.corrected.call = correctedCall && { ok: correctedCall.ok, args: correctedCall.args, result: correctedCall.ok ? undefined : String(correctedCall.result ?? "").slice(0, 300) };
  result.corrected.bannerRightAfter = (await app.ev(page("return view();"))).banner;
  result.corrected.end = await untilIdle(app, b.sid, 180_000, `${b.sid}:${idA}`);
  result.corrected.settledB = await settledSince(b.sid, n2.tap);
  result.corrected.transcript = await turnLog(app, b.sid, COLORS);
  result.corrected.reply = reply(result.corrected.transcript);
  result.bAnswersInvoke = (await invokeCalls(app, "answer_input", n1.invoke)).map((c) => c.args);
  result.bAtTheEnd = await app.ev(page("return view();"));

  // Cleanup: a reload drops the forged card; B's host lives on, so no cancel line either.
  await tracedReload(app);
  await guard(app, b.sid, FOLDERS.b);
  await sleep(3_000);
  const logB = await fullLog(app, b.sid);
  result.afterReload = { view: await app.ev(page("return view();")), markers: await markers(app),
    cancelLines: logB.filter((e) => e.role === "system" && /^Input cancelled/.test(e.text)).length };

  const same = (x, y) => J(x) === J(y);
  const cardsOf = (v, key) => v.inputs.filter((c) => c.key === key);
  const fetchA = result.answerA.answerInputFetch;
  const invokeA = result.answerA.answerInputInvoke;
  const forgedKey = `${b.sid}:${idA}`;
  const boxOf = (card, label) => card?.questions?.[0]?.boxes?.find((x) => x.label === label)?.checked ?? null;
  const refusedCard = cardsOf(result.refused.after.view, keyB)[0];
  result.verdict = {
    // (2) two conversations waiting at once
    bothWaitingTogether: Boolean(idA && idB) && result.bothWaiting.markers.inputs?.includes(a.sid) && result.bothWaiting.markers.inputs?.includes(b.sid)
      && (result.bothWaiting.hostA.userInputs ?? []).some((u) => u.inputId === idA) && (result.bothWaiting.hostB.userInputs ?? []).some((u) => u.inputId === idB),
    answerAReachedOnlyA: fetchA.length === 1 && fetchA[0].ok === true && fetchA[0].args?.sessionId === a.sid && fetchA[0].args?.userInputId === idA
      && invokeA.length === 1 && invokeA[0].args?.sessionId === a.sid,
    aTurnEndedWithItsAnswer: result.answerA.end.idle && words(result.answerA.reply).includes("BANANA") && !words(result.answerA.reply).some((w) => w === "APPLE" || w === "CHERRY"),
    bUnchangedWhileAWasAnswered: same(result.bAfterA.view.inputs, result.bBefore.inputs) && (result.bAfterA.host.userInputs ?? []).some((u) => u.inputId === idB)
      && result.bAfterA.settledB.length === 0 && !result.bAfterA.view.banner,
    thenBAnswered: result.corrected.call?.ok === true && result.corrected.call.args?.sessionId === b.sid && result.corrected.end.idle,
    // (1) the same question id in two conversations
    forgedCardInBHasAsId: result.forged.applied && cardsOf(result.bBefore, forgedKey).length === 1 && cardsOf(result.bBefore, keyB).length === 1,
    answerCarriedOnlyAsSession: [...fetchA.map((c) => c.args), ...invokeA.map((c) => c.args)].every((x) => x?.sessionId === a.sid),
    forgedCardInBUntouched: same(cardsOf(result.bAfterA.view, forgedKey), cardsOf(result.bBefore, forgedKey)) && cardsOf(result.bAfterA.view, forgedKey).length === 1,
    forgedQuestionNeverReachedBsHost: !(result.bAfterA.host.userInputs ?? []).some((u) => u.inputId === idA),
    forgedCardGoneAfterAReloadWithNoCancelLine: result.afterReload.view.inputs.length === 0 && result.afterReload.cancelLines === 0,
    // (4) a refused answer, then a corrected one on the same card
    boundSetByTheModel: q0?.mode === "multiple" && q0?.minSelections === 2,
    refused32057: result.refused.call?.ok === false && /-32057/.test(result.refused.call.result),
    refusalShown: /could not be submitted/i.test(result.refused.after.view.banner ?? ""),
    cardKeptWithTheTick: result.refused.after.sameCardNode === true && boxOf(refusedCard, one) === true,
    hostStillWaitingAfterTheRefusal: (result.refused.after.host.userInputs ?? []).some((u) => u.inputId === idB),
    correctedOnTheSameCardWithoutReload: result.corrected.atSend.sameCardNode === true && result.corrected.atSend.samePage === true
      && boxOf(result.corrected.atSend.card, one) === true && boxOf(result.corrected.atSend.card, two) === true,
    correctedAnswerAccepted: result.corrected.call?.ok === true && same(sentLabels(result.corrected.call.args).sort(), [one, two].sort())
      && result.corrected.settledB.some((p) => /"outcome":"answered"/.test(p)),
    oneCallPerAnswerInB: result.bAnswersInvoke.length === 2 && result.bAnswersInvoke.every((x) => x?.sessionId === b.sid),
    noBannerAfterTheCorrection: !result.corrected.bannerRightAfter && !result.bAtTheEnd.banner,
    bTurnContinuedWithBothLabels: result.corrected.end.idle && [one, two].every((l) => words(result.corrected.reply).includes(String(l).toUpperCase()))
      && !(q0?.options ?? []).filter((l) => l !== one && l !== two).some((l) => words(result.corrected.reply).includes(String(l).toUpperCase())),
  };
  return result;
}

/**
 * (3) Skip, in A: `counts` gives the clicks per question in order (1: one
 * click, 2: a real double-click). cancel_input counted on the transport and
 * through invoke; the click details as the card received them.
 */
async function skip(app, prompt, counts) {
  const sid = state().a;
  await guard(app, sid, FOLDERS.a);
  await app.ev(INSTALL_POLL_TAP);
  const result = { liveTurns: 1, start: await followUp(app, prompt) };
  result.invokeCounter = await countInvokes(app);
  await app.ev(INSTALL_CLICK_LOG);
  result.questions = [];
  let previous = null;
  for (const count of counts) {
    // The next card, or the turn's end without one (no card for 15 s while not running).
    let quiet = 0;
    const t0 = Date.now();
    const next = await waitFor(async () => {
      const v = await app.ev(page(`return { ...view(), running: running(${J(sid)}) };`));
      if (v.inputs.length === 0 && v.approvals.length > 0) {
        // Under Ask, an action the host does not clear asks first: allowed once, as a user would, and recorded.
        result.approvalsAllowed = [...(result.approvalsAllowed ?? []), { card: v.approvals[0], click: await mouse(app, approvalButton("Allow once")) }];
        await sleep(1_500);
        return null;
      }
      const card = v.inputs.find((c) => c.key !== previous);
      if (card) return { card, view: v };
      quiet = v.running === "false" && v.inputs.length === 0 ? quiet + 1 : 0;
      return quiet >= 19 ? { none: true, view: v } : null;
    }, 240_000, 800);
    if (!next || next.none) {
      result.questions.push({ asked: false, msWaited: Date.now() - t0, view: next?.view ?? null });
      break;
    }
    await sleep(1_000);
    const key = next.card.key;
    const id = key.split(":")[1];
    const n = { fetch: (await ipc(app, "cancel_input")).length, invoke: (await invokeCalls(app, "cancel_input")).length,
      answers: (await ipc(app, "answer_input")).length, clicks: await app.ev("window.__m05clicks.events.length"), tap: await tapCount(app) };
    const entry = { asked: true, msToCard: Date.now() - t0, inputId: id, card: next.card, clicksSent: count, click: await mouse(app, keyButton(key, "Skip"), count) };
    await sleep(3_000);
    const fetched = (await ipc(app, "cancel_input")).slice(n.fetch);
    Object.assign(entry, {
      clickEvents: await app.ev(`window.__m05clicks.events.slice(${n.clicks})`),
      cancelInputFetch: fetched.map((c) => ({ atMs: c.atMs, ok: c.ok, args: c.args, result: c.ok ? undefined : String(c.result ?? "").slice(0, 300) })),
      cancelInputInvoke: (await invokeCalls(app, "cancel_input", n.invoke)).map((c) => ({ atMs: c.atMs, args: c.args })),
      answerInputCalls: (await ipc(app, "answer_input")).length - n.answers,
      view: await app.ev(page("return view();")),
      settled: (await tapEvents(app, sid, n.tap)).filter((e) => e.kind === "input_settled").map((e) => e.payload),
    });
    result.questions.push(entry);
    previous = key;
  }
  result.end = await untilIdle(app, sid);
  result.transcript = await turnLog(app, sid, prompt);
  result.reply = reply(result.transcript);
  result.finalView = await app.ev(page("return view();"));
  const asked = result.questions.filter((x) => x.asked);
  const skipClicks = (x) => x.clickEvents.filter((c) => c.type === "click" && c.button === "Skip").map((c) => c.detail);
  const perQuestion = asked.flatMap((x, i) => Object.entries({
    clickDetails: J(skipClicks(x)) === J(x.clicksSent === 1 ? [1] : [1, 2]),
    oneCancelOnTheTransport: x.cancelInputFetch.length === 1 && x.cancelInputFetch[0].ok === true
      && x.cancelInputFetch[0].args?.sessionId === sid && x.cancelInputFetch[0].args?.userInputId === x.inputId,
    oneCancelThroughInvoke: result.invokeCounter.installed && result.invokeCounter.pollsSeenIn1500ms > 0 && x.cancelInputInvoke.length === 1,
    noAnswerSent: x.answerInputCalls === 0,
    noBanner: !x.view.banner,
    cardGone: !x.view.inputs.some((c) => c.key === x.card.key),
    settledOnceNotAnswered: x.settled.filter((p) => p.includes(`"inputId":"${x.inputId}"`)).length === 1
      && !x.settled.some((p) => /"outcome":"answered"/.test(p)),
  }).map(([k, v]) => [`q${i + 1}${x.clicksSent === 1 ? "OneClick" : "DoubleClick"}_${k}`, v]));
  result.verdict = {
    everyQuestionAsked: asked.length === counts.length,
    ...Object.fromEntries(perQuestion),
    turnContinuedAfterTheSkip: counts.length < 2 || asked.length === 2,
    turnEnded: result.end.idle,
    noBannerAtTheEnd: !result.finalView.banner,
    replySaysSkipped: words(result.reply).filter((w) => w === "SKIPPED").length === asked.length
      && !words(result.reply).some((w) => w === "APPLE" || w === "BANANA" || w === "CHERRY"),
  };
  return result;
}

/**
 * (5) A two-stage approval in A. Two single clicks on Allow once, back to
 * back and 12 px apart (clickCount 1 each: not a double-click): the first
 * decides stage 0, the second lands before the card repaints and carries
 * stage 0's token, refused -32053 and said calmly; the app re-reads the card.
 * The card is left pending, the app force-killed (taskkill /F; its engines
 * end on stdin EOF), relaunched on the same data folder, A reopened.
 */
async function staleKill(app) {
  const sid = state().a;
  await guard(app, sid, FOLDERS.a);
  await app.ev(INSTALL_POLL_TAP);
  const from = await tapCount(app);
  const result = { liveTurns: 1, start: await followUp(app, TWO_STAGE) };
  const asked = await waitCard(app, "approvals");
  if (!asked) throw new Error(`no approval card within the bound; transcript: ${J(await turnLog(app, sid, TWO_STAGE))}`);
  await sleep(1_500);
  // The host's word for the card: the tool_request events the bridge delivered, not a pending read (it would re-pin the app's registry).
  const delivered = (await tapEvents(app, sid, from)).filter((e) => e.kind === "tool_request").map((e) => parse(e.payload));
  const panel0 = await app.ev(page("return panelApprovals();"));
  const stage0 = panel0[0]?.requirementId ?? null;
  result.card = { msToCard: asked.msToCard, view: await app.ev(page("return view();")), panel: panel0,
    delivered: delivered.map((r) => ({ approvalId: r?.approvalId ?? null, requirement: r?.currentRequirementId ?? null, updated: r?.updated ?? null, choices: r?.choices ?? null })) };
  result.invokeCounter = await countInvokes(app);
  await app.ev(INSTALL_CLICK_LOG);
  const n = { fetch: (await ipc(app, "approve")).length, reads: (await ipc(app, "list_pending_requests")).length, clicks: await app.ev("window.__m05clicks.events.length") };
  const at = await centre(app, approvalButton("Allow once"));
  if (!at) throw new Error("no Allow once button on the card");
  for (const x of [at.x - 6, at.x + 6]) {
    await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: at.y });
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: at.y, button: "left", clickCount: 1 });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: at.y, button: "left", clickCount: 1 });
  }
  const calls = await waitFor(async () => { const c = (await ipc(app, "approve")).slice(n.fetch); return c.length >= 2 && c.every((x) => x.ok !== undefined) ? c : null; }, 30_000, 200)
    ?? (await ipc(app, "approve")).slice(n.fetch);
  await sleep(2_500);
  const requirementIn = (text) => parse(String(text ?? "").match(/"currentRequirementId":(\{[^}]*\})/)?.[1] ?? "null");
  const reads = (await ipc(app, "list_pending_requests", 4000)).slice(n.reads).filter((c) => c.args?.sessionId === sid);
  result.clicks = {
    events: await app.ev(`window.__m05clicks.events.slice(${n.clicks})`),
    approveFetch: calls.map((c) => ({ atMs: c.atMs, ok: c.ok, requirementSent: c.args?.requirementId ?? null, choiceId: c.args?.choiceId ?? null, result: String(c.result ?? "").slice(0, 300) })),
    approveInvoke: (await invokeCalls(app, "approve")).map((c) => ({ atMs: c.atMs, requirementId: c.args?.requirementId ?? null })),
  };
  result.afterStale = {
    view: await app.ev(page("return view();")),
    panel: await app.ev(page("return panelApprovals();")),
    appReReads: reads.map((c) => ({ atMs: c.atMs, ok: c.ok, requirement: requirementIn(c.result), labels: [...String(c.result ?? "").matchAll(/"label":"([^"]+)"/g)].map((m) => m[1]) })),
  };

  // (5) The card left pending; the marker it wrote reaches disk while a user would read it.
  result.beforeKill = { markers: await markers(app), view: await app.ev(page("return view();")) };
  await sleep(8_000);
  const appPid = state().pid;
  const list = engines(appPid);
  app.close();
  execFileSync("taskkill", ["/F", "/PID", String(appPid)], { stdio: "ignore" });
  const appGone = await waitFor(() => !alive(appPid), 10_000, 500);
  const enginesGone = await waitFor(() => list.every((e) => !alive(e.pid)), 20_000, 1_000);
  const leftover = list.filter((e) => alive(e.pid));
  for (const e of leftover) forceKill(e.pid);
  saveState({ pid: null });
  result.kill = { by: "taskkill /F of the app alone", appExited: Boolean(appGone), engines: enginesView(list), enginesEndedWithin20s: Boolean(enginesGone), enginesKilledByTheHarness: leftover.length };
  const relaunched = await launchApp({ restart: true });
  const next = await attach();
  result.relaunch = { pidRecorded: Boolean(relaunched.pid) };
  await guard(next, sid, FOLDERS.a);
  const connected = await waitFor(() => next.ev(page("return connection() === 'Connected';")), 90_000, 500);
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const v = await next.ev(page("return view();"));
    samples.push({ atS: i, inputs: v.inputs.length, approvals: v.approvals.length });
    await sleep(1_000);
  }
  await sleep(30_000);
  const log = await fullLog(next, sid);
  const requested = log.findLastIndex((e) => e.role === "tool" && e.text.startsWith("Approval requested:"));
  Object.assign(result.relaunch, {
    connected: Boolean(connected),
    view: await next.ev(page("return view();")),
    cardSamples: samples,
    linesAfterTheRequest: log.slice(requested + 1).filter((e) => e.role === "system").map((e) => e.text.slice(0, 200)),
    transcriptTail: log.slice(-6).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })),
    markersAfterBoot: await markers(next),
    approveCalls: (await ipc(next, "approve")).length,
    livenessAfterAbout45s: await liveness(next, sid),
  });

  const after = result.afterStale;
  const reread = after.appReReads.at(-1) ?? null;
  const sameToken = (x, y) => J(x) === J(y);
  const clickDetails = result.clicks.events.filter((c) => c.type === "click" && c.button === "Allow once").map((c) => c.detail);
  result.verdict = {
    // the stale click
    cardOnStage0: stage0?.sourceIndex === 0,
    twoSingleClicksReachedTheButton: J(clickDetails) === J([1, 1]),
    twoDecisionsPinnedToStage0: calls.length === 2 && calls.every((c) => sameToken(c.args?.requirementId, stage0)) && result.clicks.approveInvoke.length === 2,
    // Whichever the host took first: one decides stage 0 (not terminal), the other is stale.
    oneDecidedStage0: calls.filter((c) => c.ok === true && c.result === "false").length === 1,
    otherRefusedStale: calls.filter((c) => c.ok === false && /-32053/.test(c.result ?? "")).length === 1,
    calmNotice: after.view.banner === STALE_NOTICE,
    cardReReadByTheApp: Boolean(reread?.ok),
    cardShowsTheCurrentStep: Boolean(reread?.requirement) && sameToken(after.panel[0]?.requirementId, reread.requirement) && !sameToken(reread.requirement, stage0),
    stillDecidable: after.view.approvals.length === 1 && J(after.view.approvals[0].buttons.map((b) => b.text)) === J(reread?.labels ?? null),
    // the force-kill
    approvalPendingAtTheKill: result.beforeKill.view.approvals.length === 1 && (result.beforeKill.markers.approvals ?? []).includes(sid),
    appForceKilled: result.kill.appExited,
    enginesEndedWithTheApp: result.kill.enginesEndedWithin20s && result.kill.enginesKilledByTheHarness === 0,
    reopenedAndConnected: result.relaunch.connected,
    noCardAfterTheRelaunch: samples.every((x) => x.inputs === 0 && x.approvals === 0),
    cancelLineOnce: requested >= 0 && result.relaunch.linesAfterTheRequest.filter((t) => t === APPROVAL_RESTART_LINE).length === 1,
    markerReadOnce: !(result.relaunch.markersAfterBoot.approvals ?? []).includes(sid),
    noDecisionSent: result.relaunch.approveCalls === 0,
    notLeftWorking: idleNow(result.relaunch.livenessAfterAbout45s),
  };
  return { app: next, result };
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

/** Per-item verdicts of the final record, derived from its stored phases: no app. */
function finalSummary() {
  const record = readJson(OUT, null);
  if (!record) throw new Error("no record");
  const p = record.phases;
  const pick = (verdict, keys) => Object.fromEntries(keys.map((k) => [k, verdict?.[k] ?? null]));
  const item = (phase, verdict, keys) => {
    const facts = pick(verdict, keys);
    return { phase, verdict: Object.values(facts).every((x) => x === true) ? "pass" : "fail", checks: facts };
  };
  const pair = p.pair?.verdict;
  const stale = p["stale-kill"]?.verdict;
  // Item 3 from skip alone when it got both questions, else its first question and skip-double's.
  const skipBoth = p.skip?.verdict?.everyQuestionAsked === true;
  const skip3 = skipBoth ? p.skip.verdict : {
    ...Object.fromEntries(Object.entries(p.skip?.verdict ?? {}).filter(([k]) => k.startsWith("q1"))),
    ...Object.fromEntries(Object.entries(p["skip-double"]?.verdict ?? { run: false }).map(([k, x]) => [`skipDouble_${k}`, x])),
  };
  const builds = [...new Set(Object.values(p).map((x) => x.exeSha256).filter(Boolean))];
  record.summary = {
    "1 same question id in two conversations": item("pair", pair, ["forgedCardInBHasAsId", "answerAReachedOnlyA", "answerCarriedOnlyAsSession",
      "forgedCardInBUntouched", "forgedQuestionNeverReachedBsHost", "forgedCardGoneAfterAReloadWithNoCancelLine"]),
    "2 two conversations waiting at once": item("pair", pair, ["bothWaitingTogether", "answerAReachedOnlyA", "aTurnEndedWithItsAnswer", "bUnchangedWhileAWasAnswered", "thenBAnswered"]),
    "3 skip, one click and a double-click": item(skipBoth ? "skip" : "skip (first question), skip-double", skip3, Object.keys(skip3)),
    "4 refused answer, then a corrected one on the same card": item("pair", pair, ["boundSetByTheModel", "refused32057", "refusalShown", "cardKeptWithTheTick",
      "hostStillWaitingAfterTheRefusal", "correctedOnTheSameCardWithoutReload", "correctedAnswerAccepted", "oneCallPerAnswerInB", "noBannerAfterTheCorrection", "bTurnContinuedWithBothLabels"]),
    "5a question card when its engine dies, app open": item("q-death", p["q-death"]?.verdict, Object.keys(p["q-death"]?.verdict ?? { missing: null })),
    "5b restart with a question pending": item("b-restart", p["b-restart"]?.verdict, Object.keys(p["b-restart"]?.verdict ?? { missing: null })),
    "5c approval pending at a force-kill, relaunched": item("stale-kill", stale, ["approvalPendingAtTheKill", "appForceKilled", "enginesEndedWithTheApp",
      "reopenedAndConnected", "noCardAfterTheRelaunch", "cancelLineOnce", "markerReadOnce", "noDecisionSent", "notLeftWorking"]),
    "5d stale approval click, said calmly": item("stale-kill", stale, ["cardOnStage0", "twoSingleClicksReachedTheButton", "twoDecisionsPinnedToStage0",
      "oneDecidedStage0", "otherRefusedStale", "calmNotice", "cardReReadByTheApp", "cardShowsTheCurrentStep", "stillDecidable"]),
    "one build": { verdict: builds.length === 1 ? "pass" : "fail", exeSha256: builds },
  };
  record.liveTurnsDetail = Object.entries(p).filter(([, x]) => (x.liveTurns ?? 0) > 0)
    .map(([key, x]) => ({ phase: key, buildCommit: x.buildCommit, exeSha256: x.exeSha256, liveTurns: x.liveTurns }));
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return Object.fromEntries(Object.entries(record.summary).map(([k, x]) => [k, x.verdict]));
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
  pair,
  skip: (app) => skip(app, SKIP2, [1, 2]),
  "skip-double": (app) => skip(app, SKIP1, [2]),
  "q-death": (app) => aDeath(app, { prompt: FRUIT, kind: "inputs" }),
};
// Phases that close the instance and hand back the relaunched one.
const RESTARTS = {
  "p-restart": (app) => restart(app, FOLDERS.p, "p"),
  "q-restart": (app) => restart(app, FOLDERS.q, "q"),
  "b-restart": (app) => restart(app, FOLDERS.b, "b"),
  "stale-kill": staleKill,
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
if (PHASE === "summary" || PHASE === "final-summary") {
  process.stdout.write(`${JSON.stringify(PHASE === "summary" ? summary() : finalSummary(), null, 2)}\n`);
  process.exit(0);
}
if (!["launch", "relaunch"].includes(PHASE) && !PHASES[PHASE] && !RESTARTS[PHASE]) {
  process.stderr.write(`usage: cdp-m0-05-complement.mjs <launch|relaunch|${[...Object.keys(PHASES), ...Object.keys(RESTARTS)].join("|")}|summary|final-summary|rederive>`
    + " [--base dir] [--bin dir] [--exe file] [--build prefix|fixed] [--engine file] [--out file]\n");
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
    if (RESTARTS[PHASE]) ({ app, result } = await RESTARTS[PHASE](app));
    else result = await PHASES[PHASE](app);
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
