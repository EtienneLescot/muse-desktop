#!/usr/bin/env node

/**
 * M2-05 native acceptance: one conversation moved Local -> worktree -> Local
 * through the real "Move to worktree" / "Move back to local" action, on host
 * 1.4.2 (same session, `turn/start.workspaceRoots`). A test Git repository
 * under --base and one test conversation; every phase refuses to act unless
 * that conversation is the active one and runs under --base.
 *
 * Phases, in order, on one app instance this harness started (recorded on
 * 05/10/2026 on the user's profile; the harness now starts the isolated
 * test mode only, see below):
 *   launch      start the CDP-enabled build.
 *   setup       no turn. Test repository (initial commit, files rewritten by
 *               Git). The test conversation: every UI start needs a project
 *               root or the global default folder, and the profile holds the
 *               5-project maximum, so the native start_session runs directly
 *               with the user's global posture and isolation, then a reload
 *               lets the app adopt it (restore_sessions). No turn. Reads what
 *               window.confirm is in the page (the dialog plugin's call).
 *   confirm-defect  no turn, pre-fix build only. Move to worktree and back
 *               with the harness ready to answer Cancel: no question shows,
 *               the work moves (window.confirm = refused plugin call).
 *   turn-local  1 turn. Code word + shell `Get-Location` in Local; terminal
 *               opened in Local, "Run in Muse" state with a typed command.
 *   move        no turn. Tracked (unstaged, staged, staged new, deleted),
 *               binary, untracked (text + binary) and ignored changes in
 *               Local, then Move to worktree twice: the native question
 *               answered Cancel (nothing moves), then OK. Bytes and git status
 *               on both sides before/after; header, Changes, Files, Terminal,
 *               Run in Muse, user_shell guard.
 *   turn-worktree 1 turn. Same session: shell `Get-Location` + the code word.
 *   restart     1 turn. Graceful close, relaunch, resume_session of the moved
 *               conversation, then shell `Get-Location` again.
 *   back        no turn. Move back to local: round trip byte for byte.
 *   conflict    no turn. Move to worktree again, then Local edits the same
 *               line differently: Move back to local is refused (UI preview
 *               and a direct handoff_move call), both sides unchanged.
 *   failure     no turn. A Local file the move must overwrite is held open by
 *               another process (FileShare.Read, no delete): the move fails
 *               after writing; both sides restored; Local watched meanwhile.
 *   final       no turn. Same move with a read-only Local file instead: Git
 *               for Windows clears the attribute and the move succeeds.
 *   cleanup     no turn. Test conversation deleted through the UI, the
 *               user's projects byte-identical, his selection given back, app
 *               closed gracefully.
 *   ignored-count  no turn, after launch. A fresh test conversation in Local,
 *               Move to worktree, the question read, Cancel: one ignored
 *               item, not the app's .muse entries. Run cleanup again after.
 * Utilities: `stop` closes this harness's instance between builds (no
 * record); `rederive` rechecks stored verdicts without the app.
 *
 * Complement (06/10/2026), phases `c-*`, recorded in m2-05-handoff-complement.json.
 * Two conversations in one test repository: A, started from the welcome
 * screen, and C, A's "Fork conversation" in Local, or a direct start_session
 * (declared in the record) when the host refuses the fork.
 *   c-launch    the isolated instance (below), a fresh data folder.
 *   c-setup     no turn. The test repository; the profile is empty.
 *   c-start     1 turn. A starts in Local with a shell step; while its card
 *               waits, A's Move action is read and clicked. Then the fork, C.
 *   c-send-during-move  no turn. A moves to a worktree with bulk files to keep
 *               the move busy; meanwhile A's composer is read and C sends
 *               through the real composer (refused or queued, never a turn).
 *   c-file-tools  1 turn. A, in the worktree: shell, read_file on a file that
 *               differs between the two folders, write_file of a new file.
 *               While its first card waits: A's own Move, a direct
 *               handoff_move, and C's Move to worktree through the UI.
 *   c-held-tracked / c-held-untracked  no turn. C moves Local to a new
 *               worktree while another process holds a Local file open
 *               (FileShare.Read, no delete): a tracked file Git must rewrite,
 *               or an untracked file it must delete. Both folders watched.
 *   c-conflict  no turn. A's Move back to local refused on a conflict, in the
 *               UI and through a direct handoff_move, both folders watched.
 *   c-stop      the instance closed from its window.
 *   c-rehearse-start  rehearsal only, no turn: A and C by a direct
 *               start_session each, adopted on a reload.
 * --rehearse refuses send_input in the page in c-send-during-move; --as <key>
 * records a phase under another key (a run on another build).
 *
 * Every phase runs on the isolated test mode (ADR 0003): a fresh data folder
 * per launch under --base, no WEBVIEW2_* variable, the staged engine
 * (--engine) as the only local engine, CDP on MUSE_CDP_PORT (9333). The
 * harness refuses an exe without the switch, stops an app that writes no
 * test-mode.pid, and stops before driving anything unless the WebView2
 * profile lies under the data folder. It never attaches to an app it did
 * not start.
 *
 * Usage:
 *   node scripts/cdp-m2-05-handoff.mjs <phase> [--base G:\muse-proofs\m2-05]
 *     [--exe <muse-desktop.exe>] [--engine <muse exe>] [--out <record>] [--as <key>]
 * Each phase merges its path-free result into --out (m2-05-handoff.json, or
 * m2-05-handoff-complement.json for the c-* phases).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, join, relative, resolve } from "node:path";

// The isolated instance's own port: 9222 is a developer's app, 9334 and 9335 other proofs'.
process.env.MUSE_CDP_PORT ??= "9333";
const { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const PHASE = process.argv[2];
const COMPLEMENT = String(PHASE).startsWith("c-");
const BASE = argValue("--base", COMPLEMENT ? "G:\\muse-proofs\\m2-05b\\run" : "G:\\muse-proofs\\m2-05");
const OUT = argValue("--out", `docs/evidence/2026-10-05-roadmap-closure/${COMPLEMENT ? "m2-05-handoff-complement" : "m2-05-handoff"}.json`);
const EXE = resolve(argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe"));
const ENGINE = resolve(argValue("--engine", join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe")));
const AS = argValue("--as", PHASE);
const REHEARSE = process.argv.includes("--rehearse");
const REPO = join(BASE, "repo");
const STATE = join(BASE, "harness-state.json");
const CODE_WORD = "TANGERINE-205";
const J = JSON.stringify;

// ---- state, record, redaction ------------------------------------------------

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => readJson(STATE, {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));
const sha = (data) => createHash("sha256").update(data ?? "").digest("hex").slice(0, 16);

function redact(value) {
  const s = state();
  // Worktree paths come back canonical (`\\?\G:\…`) and are shown without the
  // prefix: the plain form matches both (the redactor eats an optional prefix).
  const pairs = [[REPO, "<local>"], [BASE, "<proof>"]];
  for (const [key, label] of [["w0", "<worktree 0>"], ["w1", "<worktree 1>"], ["w2", "<worktree 2>"], ["w3", "<worktree 3>"], ["wc", "<worktree c>"]]) {
    if (s[key]) pairs.unshift([s[key].replace(/^\\\\\?\\/, ""), label]);
  }
  return redactor(pairs)(value);
}

function engineVersion() {
  try {
    return execFileSync(ENGINE, ["--version"], { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

const exeSha256 = () => createHash("sha256").update(readFileSync(EXE)).digest("hex");
/** No uncommitted change outside the harnesses and the docs: the exe can be rebuilt from `commit`. */
const productTreeClean = () => execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude)scripts", ":(exclude)docs"], { encoding: "utf8" }).trim() === "";

function merge(result) {
  const record = readJson(OUT, COMPLEMENT ? {
    schema: "muse-desktop.m2-05-handoff-complement.v1",
    ticket: "M2-05",
    complements: "m2-05-handoff.json",
    phases: {},
  } : {
    schema: "muse-desktop.m2-05-handoff.v1",
    ticket: "M2-05",
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  if (COMPLEMENT) record.platform = `win32 ${release()}, debug build in its isolated test mode (ADR 0003), WebView2 over CDP`;
  record.phases[AS] = redact({ commit: record.commit, productTreeClean: productTreeClean(), exeSha256: exeSha256(), ...result });
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[AS];
}

// ---- disk and Git, read outside the app ----------------------------------------

const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);

/** sha256/16 of every file under `root`, `.git` and `.muse` at its top left out. */
function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && (entry.name === ".git" || entry.name === ".muse")) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(full);
      else out[rel] = entry.isFile() ? sha(readFileSync(full)) : "<not a file>";
    }
  };
  walk(root);
  return bulked(Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** The complement's bulk/ files (thousands) as one entry: their count and a hash of every path and hash. */
function bulked(files) {
  const bulk = Object.entries(files).filter(([path]) => path.startsWith("bulk/"));
  if (bulk.length === 0) return files;
  const rest = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith("bulk/")));
  return { ...rest, [`bulk/ (${bulk.length} files)`]: sha(bulk.map(([p, h]) => `${p}:${h}`).join("\n")) };
}

/** What one checkout holds: porcelain status, index vs HEAD, branch, bytes. */
function side(dir) {
  const status = lines(git(dir, ["status", "--porcelain=v1", "-uall"]));
  const bulk = status.filter((l) => l.slice(3).startsWith("bulk/"));
  return {
    branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: bulk.length === 0 ? status : [...status.filter((l) => !bulk.includes(l)), `${[...new Set(bulk.map((l) => l.slice(0, 2)))].join("|")} bulk/ (${bulk.length} files)`],
    staged: lines(git(dir, ["diff", "--cached", "--name-status"])),
    files: hashTree(dir),
  };
}
const handoffRefs = () => lines(git(REPO, ["for-each-ref", "--format=%(refname)", "refs/muse/handoff"]));
/** Same content whatever the key order (also for nested side() snapshots). */
const canonical = (v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const sameMap = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const without = (map, keys) => Object.fromEntries(Object.entries(map).filter(([k]) => !keys.includes(k)));
const pathKey = (p) => String(p ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const underBase = (p) => pathKey(p).startsWith(pathKey(BASE) + "\\");
const readOnly = (file) => (statSync(file).mode & 0o200) === 0;

// ---- app lifecycle --------------------------------------------------------------

function appPids() {
  try {
    return lines(execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-Process -Name muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"], { encoding: "utf8" })).map(Number);
  } catch { return []; }
}
const alive = (pid) => appPids().includes(Number(pid));

const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };

/**
 * The isolated test mode (ADR 0003), started from PowerShell: no WEBVIEW2_*
 * variable, a fresh data folder per launch, the staged engine as the only
 * local engine, CDP through the WebView2 options. Refused for an exe without
 * the switch; stopped when no test-mode.pid names it within 10 s.
 */
async function launchApp({ restart = false } = {}) {
  if (!readFileSync(EXE).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  // A restart reopens the same profile; any other launch takes a fresh one.
  const launches = (state().launches ?? 0) + (restart ? 0 : 1);
  const data = join(BASE, `appdata-${launches}`);
  if (!restart && existsSync(data)) throw new Error(`${data} exists: every launch takes a fresh data folder`);
  mkdirSync(data, { recursive: true });
  const pid = Number(execFileSync("powershell", ["-NoProfile", "-Command", [
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${data}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${J([ENGINE.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${EXE}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")], { encoding: "utf8" }).trim());
  saveState({ pid, data, launches });
  const entered = await waitFor(() => { try { return readFileSync(join(data, "test-mode.pid"), "utf8").trim() === String(pid); } catch { return false; } }, 10_000, 100);
  if (!entered) {
    forceKill(pid);
    saveState({ pid: null });
    throw new Error("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  }
  return pid;
}

/** CDP on this harness's instance only: its WebView2 profile must lie under its data folder. */
async function attach() {
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
  await app.ev(INSTALL_IPC_TRACE);
  return app;
}

/** Window close (WM_CLOSE) first; force only if the app is still there after 20 s. */
async function closeApp(app) {
  app?.close();
  const pid = state().pid;
  if (!pid) return { closed: false, reason: "no pid" };
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await waitFor(() => !alive(pid), 20_000, 1_000));
  if (!graceful) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
    await waitFor(() => !alive(pid), 10_000, 1_000);
  }
  saveState({ pid: null });
  return { graceful, exited: !alive(pid) };
}

/**
 * The app's native question (a TaskDialog, class #32770), found by Win32 and
 * read through UI Automation: title, text, buttons. Its buttons expose no
 * UIA pattern, so `answer` ("OK" | "Cancel" | null to only look) is pressed
 * with TDM_CLICK_BUTTON, the TaskDialog's own button-press message (IDOK 1,
 * IDCANCEL 2; Windows names them in its language: OK / Annuler).
 * `found: false` when none appeared in time.
 */
function nativeDialog(pid, answer, timeoutMs) {
  const id = { OK: 1, Cancel: 2 }[answer] ?? 0;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class M205 {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (p == pid && c.ToString() == "#32770" && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
"@
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$h = [IntPtr]::Zero
while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) { $h = [M205]::Find(${Number(pid)}); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 } }
if ($h -eq [IntPtr]::Zero) { '{"found":false}'; exit }
$A = [System.Windows.Automation.AutomationElement]
$d = $A::FromHandle($h)
$all = @($d.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
$texts = @($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } | ForEach-Object { $_.Current.Name })
$buttons = @($all | Where-Object { $_.Current.ClassName -eq 'CCPushButton' -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button })
# Read everything before the press: the dialog is gone right after.
$title = $d.Current.Name
$names = @($buttons | ForEach-Object { [string]$_.Current.Name })
$clicked = $null
if (${id} -gt 0) {
  $b = $buttons | Where-Object { $_.Current.AutomationId -eq 'CommandButton_${id}' -or $_.Current.AutomationId -eq '${id}' } | Select-Object -First 1
  if ($b) { $clicked = $b.Current.Name; [void][M205]::PostMessage($h, 0x466, [IntPtr]${id}, [IntPtr]::Zero) }
}
$json = @{ found = $true; title = $title; texts = $texts; buttons = $names; answer = ${answer === null ? "$null" : `'${answer}'`}; clicked = $clicked } | ConvertTo-Json -Compress -Depth 4
# ASCII only, whatever the console code page: the bullets of the question survive.
[regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    child.stdout.setEncoding("utf8");
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", () => {
      try { resolve(JSON.parse(out.trim().split("\n").at(-1))); } catch { resolve({ found: null, error: (err || out).slice(0, 300) }); }
    });
  });
}

// ---- page side -------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label, root) => q('button', root).find((b) => (b.innerText || '').trim() === label) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const stored = (sid) => (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid) || null;
  const header = () => {
    const spans = [...document.querySelectorAll('.task-metadata span[title]')];
    return {
      eyebrow: text(document.querySelector('.task-heading .eyebrow')),
      path: spans.find((s) => s.getAttribute('title') !== 'Host-reported Git branch' && !s.className.includes('connection'))?.getAttribute('title') ?? null,
      branch: text(spans.find((s) => s.getAttribute('title') === 'Host-reported Git branch')) ?? null,
      connection: text(document.querySelector('.task-metadata .connection-state')),
    };
  };
  const banner = () => text(document.querySelector('.error-banner span'));
`;
const page = (body) => `(async () => { ${H} ${body} })()`;

const ipc = (app, cmd, max = 2000) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${J(cmd)})
  .map((c) => ({ atMs: c.atMs, args: c.args, ok: c.ok, blocked: c.blockedByHarness === true, result: c.result ? c.result.slice(0, ${max}) : c.result }))`);
const parse = (text) => { try { return JSON.parse(text); } catch { return text ?? null; } };

/** The next answer to `cmd` after `before` calls. */
async function nextIpc(app, cmd, before, timeoutMs = 60_000) {
  return waitFor(async () => {
    const calls = await ipc(app, cmd);
    return calls.length > before && calls.at(-1).result !== undefined ? calls.at(-1) : null;
  }, timeoutMs, 400);
}

async function select(app, sid) {
  await app.ev(page(`const b = row(${J(sid)})?.querySelector('button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${J(sid)};`)), 15_000, 300);
  await sleep(800);
}

/**
 * Refuse to act unless the test conversation is the active one, its folder
 * under --base and, when given, `workspace`. Returns its stored row.
 */
async function guard(app, workspace, sid = state().sid) {
  if (!sid) throw new Error("no test conversation: run setup first");
  if (!(await app.ev(page(`return Boolean(row(${J(sid)}));`)))) throw new Error("refusing: the test conversation is not in the sidebar");
  if ((await app.ev(page("return activeSid();"))) !== sid) await select(app, sid);
  const r = await app.ev(page(`const s = stored(${J(sid)}); return { active: activeSid(), workspace: s?.workspace ?? null, host: s?.host_workspace ?? null };`));
  if (r.active !== sid) throw new Error("refusing: the active conversation is not the test conversation");
  if (!underBase(r.workspace)) throw new Error("refusing: the test conversation does not run under the proof folder");
  if (workspace && pathKey(r.workspace) !== pathKey(workspace)) throw new Error(`refusing: the test conversation is not in the expected folder (${pathKey(r.workspace)})`);
  return r;
}

async function workTab(app, label) {
  return app.ev(page(`
    if (!document.querySelector('nav.work-tabs')) { document.querySelector('button[aria-label="Show work panel"]')?.click(); await pause(500); }
    const tab = q('nav.work-tabs button').find((b) => b.textContent.trim() === ${J(label)});
    if (!tab) return false;
    tab.click();
    await pause(500);
    return true;
  `));
}

/** Changes, Files and Terminal as the panels show them; "Run in Muse" with a typed command. */
async function panels(app, sid) {
  const out = {};
  const gs = (await ipc(app, "git_status")).length;
  await workTab(app, "Changes");
  const status = await nextIpc(app, "git_status", gs, 20_000);
  const st = parse(status?.result);
  await sleep(600);
  out.changes = {
    repoRoot: st?.repoRoot ?? null,
    branch: st?.branch ?? null,
    files: (st?.files ?? []).map((f) => `${f.status ?? ""} ${f.path}`.trim()).slice(0, 20),
    panel: await app.ev(page("return { repo: text(document.querySelector('.review-panel-head h2')), branch: text(document.querySelector('.review-repo-meta strong')), count: text(document.querySelector('.review-count')) };")),
  };
  const fl = (await ipc(app, "files_list")).length;
  await workTab(app, "Files");
  let files = await nextIpc(app, "files_list", fl, 10_000);
  if (!files) {
    await app.ev(page("button('Refresh', document.querySelector('.files-panel'))?.click(); return true;"));
    files = await nextIpc(app, "files_list", fl, 15_000);
  }
  const fr = parse(files?.result);
  out.files = { root: fr?.root ?? null, entries: (fr?.entries ?? []).map((e) => e.path).sort() };
  const to = (await ipc(app, "terminal_open")).length;
  await workTab(app, "Terminal");
  await app.ev(page("button('Open terminal')?.click(); return true;"));
  const opened = await nextIpc(app, "terminal_open", to, 20_000);
  const info = parse(opened?.result);
  await waitFor(() => app.ev("Boolean(document.querySelector('form.terminal-input input'))"), 10_000, 300);
  await app.ev("(document.querySelector('form.terminal-input input').focus(), true)");
  await app.send("Input.insertText", { text: "echo m2-05" });
  await sleep(400);
  out.terminal = {
    opened: opened ? opened.ok : null,
    cwd: info?.cwd ?? null,
    meta: await app.ev(page("return text(document.querySelector('.terminal-meta'));")),
    runInMuse: await app.ev(page("const b = document.querySelector('button.terminal-muse'); return b ? { disabled: b.disabled, title: b.title } : null;")),
  };
  await app.ev(page("const i = document.querySelector('form.terminal-input input'); if (i) setValue(i, ''); return true;"));
  return out;
}

/** The conversation's Actions dialog, then one of its actions (clicked after this returns). */
async function clickAction(app, sid, label) {
  return app.ev(page(`
    const actions = row(${J(sid)})?.querySelector("button[aria-label^='Actions for']");
    if (!actions) return { clicked: false, reason: 'no actions button' };
    actions.click();
    await pause(500);
    const dialog = document.querySelector('dialog[open]');
    const all = dialog ? [...dialog.querySelectorAll('button')] : [];
    const b = all.find((n) => (n.innerText || '').trim() === ${J(label)});
    if (!b) return { clicked: false, reason: 'no such action', actions: all.map((n) => (n.innerText || '').trim()).filter(Boolean) };
    if (b.disabled) return { clicked: false, reason: 'disabled', title: b.title };
    setTimeout(() => b.click(), 0);
    return { clicked: true };
  `));
}

/**
 * Drive the real Move action. The confirmation is the app's native dialog,
 * answered with `answer` ("OK", "Cancel") through UI Automation; `expectMove`
 * says whether a handoff_move call should follow (refused or cancelled: no).
 */
async function moveThroughUi(app, sid, label, { answer = "OK", expectMove = answer === "OK", dialogMs = 60_000 } = {}) {
  const count = async (cmd) => (await ipc(app, cmd)).length;
  const before = { confirm: await count("plugin:dialog|confirm"), preview: await count("handoff_preview"), move: await count("handoff_move"), create: await count("git_worktree_create_for_workspace") };
  const t0 = Date.now();
  const click = await clickAction(app, sid, label);
  if (!click.clicked) return { label, click };
  const out = { label, click, dialog: await nativeDialog(state().pid, answer, dialogMs) };
  const preview = await nextIpc(app, "handoff_preview", before.preview, 30_000);
  out.preview = preview ? { target: preview.args?.target ?? null, ok: preview.ok, result: parse(preview.result) } : null;
  const moved = await nextIpc(app, "handoff_move", before.move, expectMove ? 120_000 : 5_000);
  out.move = moved ? { target: moved.args?.target ?? null, ok: moved.ok, result: parse(moved.result) } : null;
  out.moveCalls = (await count("handoff_move")) - before.move;
  out.confirmCalls = (await ipc(app, "plugin:dialog|confirm")).slice(before.confirm).map((c) => ({ ok: c.ok, result: parse(c.result) }));
  out.worktreeCreated = (await ipc(app, "git_worktree_create_for_workspace")).slice(before.create).map((c) => ({ ok: c.ok, result: parse(c.result) }));
  await waitFor(() => app.ev(page("return !q('button').some((b) => /^(Checking what will move|Creating a worktree|Moving the work|Starting Muse there)/.test((b.innerText || '').trim()));")), 30_000, 400);
  await sleep(1_000);
  out.ms = Date.now() - t0;
  out.banner = await app.ev(page("return banner();"));
  return out;
}

async function sessionView(app, sid) {
  return app.ev(page(`
    const s = stored(${J(sid)});
    const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
    const sys = log.filter((e) => e.role === 'system').slice(-2).map((e) => String(e.text || '').slice(0, 500));
    return { active: activeSid(), sessions: (store('muse-desktop.sessions.v1', '[]') || []).length,
      stored: s ? { workspace: s.workspace, host_workspace: s.host_workspace ?? null } : null,
      header: header(), logEntries: log.length, lastSystemNotes: sys };
  `));
}

// ---- live turns -------------------------------------------------------------------

async function pendingChoices(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${J(sid)} })`);
  const rows = Array.isArray(res?.approvals) ? res.approvals : [];
  return rows.map((r) => (r.choices ?? r.availableChoices ?? []).map((c) => ({ label: c.label ?? null, decision: c.decision?.kind ?? c.decision, scope: c.scope ?? null })));
}

/** Send through the composer, answer approval cards with the narrowest allow, wait for the end. */
async function liveTurn(app, sid, prompt, options = {}) {
  const before = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).length;`));
  const sends = (await ipc(app, "send_input")).length;
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { sent: false, reason: 'no composer' };
    setValue(field, ${J(prompt)});
    await pause(300);
    const send = document.querySelector('button.send');
    if (!send || send.disabled) return { sent: false, reason: 'send disabled' };
    send.click();
    return { sent: true };
  `));
  if (!sent.sent) throw new Error(`turn not sent: ${sent.reason}`);
  return waitTurn(app, sid, { prompt, before, sends, ...options });
}

/**
 * Until the turn of `sid` ends, answering its cards. `onCard` runs once, when
 * the first card shows and before it is answered (the turn is running and
 * waits for the user); the conversation is selected again after it.
 */
async function waitTurn(app, sid, { prompt, before, sends, onCard = null }) {
  const t0 = Date.now();
  const approvals = [];
  let sawRunning = false;
  let hooked = false;
  const done = await waitFor(async () => {
    const v = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
      return { running: running(${J(sid)}), cards: q('.approvals .approval').length, open: log.some((e) => e.open),
        assistant: log.slice(${before}).some((e) => e.role === 'assistant' && String(e.text || '').trim()) };
    `));
    if (v.running === "true") sawRunning = true;
    if (v.cards > 0 && onCard && !hooked) {
      hooked = true;
      await onCard();
      await select(app, sid);
      return null;
    }
    if (v.cards > 0) {
      const choices = (await pendingChoices(app, sid))[0] ?? [];
      const allow = choices.filter((c) => !/^(abort|denied)/.test(String(c.decision)));
      const pick = allow.find((c) => /once|turn/i.test(`${c.scope} ${c.label}`)) ?? allow[0];
      if (pick) {
        const clicked = await app.ev(page(`const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === ${J(pick.label)}); if (b) b.click(); return !!b;`));
        approvals.push({ choices: choices.map((c) => `${c.label} [${c.decision}${c.scope ? `/${c.scope}` : ""}]`), clicked: pick.label, ok: clicked });
        await sleep(2_000);
      }
      return null;
    }
    return (sawRunning || Date.now() - t0 > 15_000) && v.running === "false" && !v.open && v.assistant ? v : null;
  }, 300_000, 1_000);
  const call = (await ipc(app, "send_input")).slice(sends)[0] ?? null;
  const entries = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).slice(${before}).map((e) => ({ role: e.role, text: String(e.text || '').slice(0, 1500) }));`));
  return { prompt, sendInput: call ? { sessionId: call.args?.sessionId ?? null, ok: call.ok } : null, finished: Boolean(done), ms: Date.now() - t0, approvals, cardHookRan: hooked, entries };
}

/**
 * Where the model's shell said it ran. The transcript shows the tool row
 * ("powershell · …") and then the command's own output block (Get-Location's
 * "Path / ----" table), which is what counts as `shell`; the model's answer
 * after it is `answer`. Works on live paths and on a stored, redacted record
 * (labels), so `rederive` can recheck a turn without running it again.
 */
function reportedCwd(turn) {
  const s = state();
  const places = [[REPO, "local"], ...(s.w1 ? [[s.w1, "worktree 1"]] : []), ...(s.w2 ? [[s.w2, "worktree 2"]] : [])];
  const found = [];
  for (const e of turn.entries.filter((x) => x.role === "tool" || x.role === "assistant")) {
    const from = /^\s*Path\s*\r?\n\s*-{4}/.test(e.text) ? "shell" : e.role === "tool" ? "tool" : "answer";
    for (const m of e.text.matchAll(/(?:\\\\\?\\)?[A-Za-z]:\\[^\s"'`<>|*]*|<(local|worktree \d)>(\\[^\s"'`<>|*]*)?/g)) {
      const raw = m[0].replace(/[.,;:)\]]+$/, "");
      const hit = m[1] !== undefined
        ? (m[2] ? "other" : m[1])
        : places.filter(([p]) => pathKey(raw) === pathKey(p)).map(([, label]) => label)[0] ?? "other";
      found.push({ from, place: hit, extendedPrefix: m[1] !== undefined ? null : raw.startsWith("\\\\?\\") });
    }
  }
  const unique = [...new Map(found.map((f) => [`${f.from}|${f.place}|${f.extendedPrefix}`, f])).values()];
  return {
    toolRows: turn.entries.filter((e) => e.role === "tool").length,
    reported: unique,
    answer: (turn.entries.filter((e) => e.role === "assistant").at(-1)?.text ?? "").slice(0, 400),
    codeWord: turn.entries.some((e) => e.role === "assistant" && e.text.includes(CODE_WORD)),
  };
}
const shellIn = (cwd, place) => cwd.reported.some((r) => r.from === "shell" && r.place === place);

// ---- phases ------------------------------------------------------------------------

async function launch() {
  // Other isolated instances may run (test mode skips the single-instance
  // guard): only this harness's port and pid are ever used.
  if (state().pid && alive(state().pid)) throw new Error("this harness's instance is still running: run c-stop first");
  mkdirSync(BASE, { recursive: true });
  const pid = await launchApp();
  const app = await attach();
  return { app, result: { started: true, pidRecorded: Boolean(pid), isolation: { testModeMarker: true, webviewProfileUnderTestFolder: true, dataFolder: state().data, cdpPort: PORT } } };
}

const INITIAL = {
  "README.md": "# m2-05 test repository\n",
  ".gitignore": "*.log\n",
  "src/app.txt": Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  "staged.txt": "staged v1\n",
  "deleted.txt": "this file is deleted in Local\n",
  "crlf.txt": "windows\r\nline endings\r\n",
};
const BLOB_V1 = Buffer.from([0, 255, 13, 10, 137, 80, 78, 71, 0, 10, 26, 0]);
const BLOB_V2 = Buffer.from([0, 255, 13, 10, 137, 80, 78, 71, 0, 10, 26, 0, 1, 2, 3, 13, 10, 0]);
const NEW_BIN = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 13) % 256));

/** The user's projects, selection and global posture, read only. */
async function readUser(app) {
  const user = await app.ev(page(`return { raw: localStorage.getItem('muse-desktop.projects.v1'), names: (store('muse-desktop.projects.v1', '[]') || []).map((p) => p.name),
    active: localStorage.getItem('muse-desktop.active.v1'), posture: localStorage.getItem('muse-desktop.authorization-mode.v1'),
    sandbox: localStorage.getItem('muse-desktop.settings.v1') };`));
  const { parseAuthorizationMode } = await import("../src/lib/authorization.ts");
  const { hostSandboxConfigForProject, parseSandboxSettings } = await import("../src/lib/settings.ts");
  return { ...user, posture: parseAuthorizationMode(parse(user.posture)), isolation: hostSandboxConfigForProject(parseSandboxSettings(parse(user.sandbox))) };
}

/**
 * A test conversation in Local. Every UI start needs a project root or the
 * global default folder: the profile holds the 5-project maximum and both
 * belong to the user. So the native start_session runs directly, with the
 * global posture and isolation the app would send (no connector servers), and
 * a page reload lets the app adopt it (restore_sessions), as it adopts any
 * live session it does not list. No turn.
 */
async function startTestConversation(app, { posture, isolation }) {
  const meta = await app.ev(`window.__TAURI_INTERNALS__.invoke('start_session', ${J({
    workspacePath: REPO, authorizationMode: posture, sandboxMode: isolation.mode,
    sandboxDisableWrite: isolation.disableWrite, sandboxDisableShell: isolation.disableShell })})`);
  if (!meta?.session_id) throw new Error(`start_session failed: ${J(meta)}`);
  saveState({ sid: meta.session_id });
  await app.ev("(setTimeout(() => location.reload(), 50), true)");
  await sleep(6_000);
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  await app.ev(INSTALL_IPC_TRACE);
  const adopted = await waitFor(() => app.ev(page(`return Boolean(row(${J(meta.session_id)}));`)), 60_000, 1_000);
  if (!adopted) throw new Error("the app did not adopt the test conversation after the reload");
  await select(app, meta.session_id);
  return { startSession: { workspace: meta.workspace, durability: meta.session_durability ?? null, approvalMode: meta.approval_mode ?? null },
    adoptedAfterReload: Boolean(adopted), view: await sessionView(app, meta.session_id) };
}

async function setup(app) {
  const s = state();
  if (s.sid || existsSync(REPO)) throw new Error(`${BASE} already holds a run; remove it or pass another --base`);
  const result = {};
  // 1. Kept to compare at cleanup and to start the test conversation as the app would.
  const user = await readUser(app);
  saveState({ userProjectsRaw: user.raw, originalActive: parse(user.active) });
  result.user = { projects: user.names.length, projectsSha: sha(user.raw), posture: user.posture, isolation: user.isolation };

  // 2. The test repository: committed, then every tracked file rewritten by Git
  //    so Local and a fresh worktree hold the same bytes (core.autocrlf as configured).
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "assets"), { recursive: true });
  git(REPO, ["init", "-q", "-b", "main"]);
  git(REPO, ["config", "user.name", "m2-05 proof"]);
  git(REPO, ["config", "user.email", "m2-05@localhost"]);
  for (const [path, content] of Object.entries(INITIAL)) writeFileSync(join(REPO, path), content);
  writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V1);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-q", "-m", "initial"]);
  for (const path of lines(git(REPO, ["ls-files"]))) rmSync(join(REPO, path));
  git(REPO, ["checkout", "--", "."]);
  result.repo = { autocrlf: git(REPO, ["config", "--get", "core.autocrlf"]).trim(), local: side(REPO) };
  saveState({ cleanMap: result.repo.local.files });

  // 3. The test conversation (see startTestConversation).
  result.conversation = await startTestConversation(app, user);
  const meta = { session_id: state().sid };

  // 4. window.confirm as the page sees it (read, never called here).
  result.confirmImplementation = await app.ev("String(window.confirm).includes('plugin:dialog|confirm') ? 'dialog plugin: invoke(plugin:dialog|confirm), returns a Promise' : 'browser confirm()'");
  result.verdict = {
    repoClean: result.repo.local.status.length === 0,
    conversationInLocal: pathKey(result.conversation.view.stored?.workspace) === pathKey(REPO) && result.conversation.view.active === meta.session_id,
    noTurn: result.conversation.view.logEntries === 0,
    confirmIsPluginCall: /dialog plugin/.test(result.confirmImplementation),
  };
  return result;
}

/**
 * Pre-fix build only: the Move action's confirmation as shipped. The dialog
 * plugin replaces window.confirm with a call this app never allowed
 * (dialog:allow-confirm); read synchronously, its Promise counts as "yes".
 * The harness stands ready to answer Cancel: no question ever shows.
 */
async function confirmDefect(app) {
  const s = state();
  await guard(app, REPO);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  writeFileSync(join(REPO, "probe-before.txt"), "moved with no question\n");
  const before = { local: side(REPO), refs: handoffRefs() };
  const out = await moveThroughUi(app, s.sid, "Move to worktree", { answer: "Cancel", expectMove: true, dialogMs: 8_000 });
  const w0 = out.move?.result?.target ?? null;
  if (w0) saveState({ w0 });
  const moved = w0 ? { local: side(REPO), w0: side(w0), view: await sessionView(app, s.sid) } : null;
  // Put things back with the same unconfirmed action; the probe file goes.
  const back = w0 ? await moveThroughUi(app, s.sid, "Move back to local", { answer: "Cancel", expectMove: true, dialogMs: 8_000 }) : null;
  rmSync(join(REPO, "probe-before.txt"), { force: true });
  const after = { local: side(REPO), view: await sessionView(app, s.sid) };
  const confirmImplementation = await app.ev("String(window.confirm).includes('plugin:dialog|confirm') ? 'dialog plugin: invoke(plugin:dialog|confirm), returns a Promise' : 'browser confirm()'");
  const result = { build: "pre-fix", confirmImplementation, before, action: out, moved, back, after };
  result.verdict = {
    noQuestionShown: out.dialog?.found === false && back?.dialog?.found === false,
    confirmRefused: out.confirmCalls.length === 1 && out.confirmCalls[0].ok === false && /dialog\.confirm not allowed/.test(String(out.confirmCalls[0].result)),
    movedAnyway: out.move?.ok === true && out.move.result?.untracked === 1 && moved?.w0.status.includes("?? probe-before.txt") && moved?.local.status.length === 0,
    movedBackAnyway: back?.move?.ok === true && back.confirmCalls[0]?.ok === false,
    restored: after.local.status.length === 0 && sameMap(after.local.files, s.cleanMap) && pathKey(after.view.stored?.workspace) === pathKey(REPO),
  };
  return result;
}

async function turnLocal(app) {
  const s = state();
  await guard(app, REPO);
  const turn = await liveTurn(app, s.sid, `M2-05 proof, step 1. Remember this code word: ${CODE_WORD}. Run Get-Location with your shell tool now, then reply with only the exact path it printed.`);
  const result = { liveTurns: 1, turn, cwd: reportedCwd(turn), view: await sessionView(app, s.sid) };
  result.panels = await panels(app, s.sid);
  result.verdict = {
    turnFinished: turn.finished,
    shellRan: result.cwd.toolRows > 0,
    modelCwdLocal: shellIn(result.cwd, "local"),
    terminalInLocal: pathKey(result.panels.terminal.cwd) === pathKey(REPO),
    runInMuseUsable: result.panels.terminal.runInMuse?.disabled === false,
  };
  return result;
}

async function move(app) {
  const s = state();
  await guard(app, REPO);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  // 1. Every kind of uncommitted work in Local.
  const app10 = INITIAL["src/app.txt"].split("\n").filter(Boolean);
  app10[2] = "line 3 changed in Local";
  writeFileSync(join(REPO, "src/app.txt"), app10.join("\n") + "\n");
  writeFileSync(join(REPO, "staged.txt"), "staged v2\n");
  writeFileSync(join(REPO, "added.txt"), "added and staged\n");
  git(REPO, ["add", "--", "staged.txt", "added.txt"]);
  rmSync(join(REPO, "deleted.txt"), { force: true });
  writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V2);
  mkdirSync(join(REPO, "notes"), { recursive: true });
  writeFileSync(join(REPO, "notes/todo.md"), "- [ ] untracked note, LF only\n");
  writeFileSync(join(REPO, "assets/new.bin"), NEW_BIN);
  writeFileSync(join(REPO, "build.log"), "ignored, stays in Local\n");
  const before = { local: side(REPO), refs: handoffRefs() };
  saveState({ localBefore: before.local.files, localStatusBefore: before.local.status });
  const viewBefore = await sessionView(app, s.sid);

  // 2. The real action and its native confirmation: Cancel first, then OK.
  const cancelled = await moveThroughUi(app, s.sid, "Move to worktree", { answer: "Cancel" });
  const afterCancel = { local: side(REPO), refs: handoffRefs() };
  const action = await moveThroughUi(app, s.sid, "Move to worktree");
  const w1 = action.move?.result?.target ?? null;
  if (!w1) return { before, action, failure: "no target after the move" };
  saveState({ w1 });
  const after = { local: side(REPO), w1: side(w1), refs: handoffRefs() };
  const view = await sessionView(app, s.sid);
  const ui = await panels(app, s.sid);
  // 3. The supervisor's own guard on Run in Muse (direct call, no host contact when refused).
  const guardCall = await app.ev(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('user_shell', { sessionId: ${J(s.sid)}, commandId: crypto.randomUUID(), commandText: 'echo m2-05-guard' }) }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
  const ignored = ["build.log"];
  const result = { before: { local: before.local, refs: before.refs.length, header: viewBefore.header },
    cancelled: { ...cancelled, localUnchanged: sameMap(afterCancel.local, before.local), refsUnchanged: afterCancel.refs.length === before.refs.length }, action, after: { local: after.local, w1: after.w1, refs: after.refs.length }, view, panels: ui, userShellGuard: guardCall };
  result.verdict = {
    cancelMovesNothing: cancelled.dialog?.found === true && cancelled.dialog.answer === "Cancel" && Boolean(cancelled.dialog.clicked) && cancelled.moveCalls === 0
      && cancelled.worktreeCreated.length === 0 && sameMap(afterCancel.local, before.local) && afterCancel.refs.length === before.refs.length,
    confirmAsked: action.dialog?.found === true && action.dialog.answer === "OK" && Boolean(action.dialog.clicked) && /Move all the uncommitted work/.test((action.dialog.texts ?? []).join(" ")),
    counts: { tracked: action.move?.result?.tracked, untracked: action.move?.result?.untracked, ignored: action.move?.result?.ignored },
    sameSession: action.move?.result?.sameSession === true && view.active === s.sid && view.sessions === viewBefore.sessions,
    worktreeBytesIdentical: sameMap(after.w1.files, without(before.local.files, ignored)),
    localClean: after.local.status.length === 0 && sameMap(after.local.files, { ...s.cleanMap, "build.log": before.local.files["build.log"] }),
    ignoredStayed: after.local.files["build.log"] === before.local.files["build.log"] && !("build.log" in after.w1.files),
    lfKeptLf: readFileSync(join(w1, "notes/todo.md")).includes(Buffer.from("LF only\n")) && !readFileSync(join(w1, "src/app.txt")).includes(13),
    stagingArrivesUnstaged: after.w1.staged.length === 0 && after.w1.status.includes("?? added.txt"),
    snapshotRef: after.refs.length === before.refs.length + 2,
    headerFollows: pathKey(view.stored?.workspace) === pathKey(w1) && pathKey(view.stored?.host_workspace) === pathKey(REPO) && /\.muse\\worktrees\\/.test(view.header.path ?? ""),
    changesBranch: ui.changes.branch,
    changesRoot: pathKey(ui.changes.repoRoot) === pathKey(w1),
    filesRoot: pathKey(ui.files.root) === pathKey(w1) && ui.files.entries.includes("notes") && !ui.files.entries.includes(".muse"),
    terminalInWorktree: pathKey(ui.terminal.cwd) === pathKey(w1),
    runInMuseDisabled: ui.terminal.runInMuse?.disabled === true && /moved from/.test(ui.terminal.runInMuse?.title ?? ""),
    userShellRefused: guardCall.ok === false && /moved from/.test(guardCall.error ?? ""),
    transcriptNote: view.lastSystemNotes.some((t) => /^Moved 5 changed files and 2 untracked files/.test(t) && /now runs there/.test(t)),
  };
  return result;
}

async function turnWorktree(app) {
  const s = state();
  await guard(app, s.w1);
  const turn = await liveTurn(app, s.sid, "M2-05 proof, step 2. Run Get-Location with your shell tool now. Reply with the exact path it printed, then the code word from step 1.");
  const result = { liveTurns: 1, turn, cwd: reportedCwd(turn), view: await sessionView(app, s.sid) };
  result.verdict = {
    turnFinished: turn.finished,
    sameSessionId: turn.sendInput?.sessionId === s.sid,
    shellRan: result.cwd.toolRows > 0,
    modelCwdWorktree: shellIn(result.cwd, "worktree 1"),
    extendedPrefix: result.cwd.reported.some((r) => r.from === "shell" && r.place === "worktree 1" && r.extendedPrefix),
    codeWordRecalled: result.cwd.codeWord,
  };
  return result;
}

async function restart(app) {
  const s = state();
  await guard(app, s.w1);
  // No conversation open at close: the relaunch resumes nothing by itself, so
  // the resume of the moved conversation is the one this phase traces.
  await app.ev(page("q('.primary-nav button[aria-label=\"New conversation\"]')[0]?.click(); await pause(800); return localStorage.getItem('muse-desktop.active.v1');"));
  const close = await closeApp(app);
  await sleep(3_000);
  await launchApp({ restart: true });
  const next = await attach();
  await waitFor(() => next.ev(page(`return Boolean(row(${J(s.sid)}));`)), 60_000, 1_000);
  const storedAtBoot = await next.ev(page(`const r = stored(${J(s.sid)}); return r ? { workspace: r.workspace, host_workspace: r.host_workspace ?? null } : null;`));
  const resumes = (await ipc(next, "resume_session")).length;
  await select(next, s.sid);
  const resumed = await nextIpc(next, "resume_session", resumes, 90_000);
  const meta = parse(resumed?.result);
  await waitFor(() => next.ev(page("return header().connection === 'Connected';")), 30_000, 500);
  await guard(next, s.w1);
  const view = await sessionView(next, s.sid);
  const ui = await panels(next, s.sid);
  const turn = await liveTurn(next, s.sid, "M2-05 proof, step 3, after an app restart. Run Get-Location with your shell tool now, then reply with only the exact path it printed.");
  const result = {
    liveTurns: 1, close, storedAtBoot,
    resume: resumed ? { ok: resumed.ok, workspacePath: resumed.args?.workspacePath ?? null, effectiveWorkspace: resumed.args?.effectiveWorkspace ?? null,
      workspace: meta?.workspace ?? null, hostWorkspace: meta?.host_workspace ?? null, notice: meta?.workspace_notice ?? null } : null,
    view, panels: { changes: ui.changes, files: ui.files.root, terminal: ui.terminal }, turn, cwd: reportedCwd(turn),
  };
  result.verdict = {
    closedGracefully: close.graceful,
    storedInWorktree: pathKey(storedAtBoot?.workspace) === pathKey(s.w1) && pathKey(storedAtBoot?.host_workspace) === pathKey(REPO),
    resumedInWorktree: result.resume?.ok === true && pathKey(result.resume.workspacePath) === pathKey(REPO) && pathKey(result.resume.effectiveWorkspace) === pathKey(s.w1)
      && pathKey(result.resume.workspace) === pathKey(s.w1) && result.resume.notice === null,
    headerInWorktree: /\.muse\\worktrees\\/.test(view.header.path ?? "") && !view.lastSystemNotes.some((t) => /runs in .* again/.test(t)),
    panelsInWorktree: pathKey(ui.changes.repoRoot) === pathKey(s.w1) && pathKey(ui.files.root) === pathKey(s.w1) && pathKey(ui.terminal.cwd) === pathKey(s.w1),
    turnFinished: turn.finished,
    modelCwdWorktree: shellIn(result.cwd, "worktree 1"),
  };
  return { app: next, result };
}

async function back(app) {
  const s = state();
  await guard(app, s.w1);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const before = { local: side(REPO), w1: side(s.w1), refs: handoffRefs() };
  const action = await moveThroughUi(app, s.sid, "Move back to local");
  const after = { local: side(REPO), w1: side(s.w1), refs: handoffRefs() };
  const view = await sessionView(app, s.sid);
  const ui = await panels(app, s.sid);
  const result = { before, action, after, view, panels: ui };
  result.verdict = {
    confirmAsked: action.dialog?.found === true && action.dialog.answer === "OK" && Boolean(action.dialog.clicked) && /in this folder to Local, including changes made outside/.test((action.dialog.texts ?? []).join(" ")),
    moved: action.move?.ok === true && pathKey(action.move?.result?.target) === pathKey(REPO),
    roundTripBytesIdentical: sameMap(after.local.files, s.localBefore),
    worktreeClean: after.w1.status.length === 0 && sameMap(after.w1.files, s.cleanMap),
    stagingNotRestored: { before: s.localStatusBefore, after: after.local.status },
    conversationHome: pathKey(view.stored?.workspace) === pathKey(REPO) && !/\.muse\\worktrees\\/.test(view.header.path ?? ""),
    panelsHome: pathKey(ui.changes.repoRoot) === pathKey(REPO) && pathKey(ui.files.root) === pathKey(REPO) && pathKey(ui.terminal.cwd) === pathKey(REPO),
    runInMuseBack: ui.terminal.runInMuse?.disabled === false,
    snapshotRef: after.refs.length === before.refs.length + 2,
  };
  return result;
}

async function conflict(app) {
  const s = state();
  await guard(app, REPO);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  // 1. Everything in Local goes to a second worktree.
  const out = await moveThroughUi(app, s.sid, "Move to worktree");
  const w2 = out.move?.result?.target ?? null;
  if (!w2) return { setupMove: out, failure: "no second worktree" };
  saveState({ w2 });
  // 2. Local changes line 3 too, differently.
  const local10 = INITIAL["src/app.txt"].split("\n").filter(Boolean);
  local10[2] = "line 3 changed differently in Local, after the move";
  writeFileSync(join(REPO, "src/app.txt"), local10.join("\n") + "\n");
  const before = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
  // 3. The UI refuses before any confirm, then the supervisor itself.
  const ui = await moveThroughUi(app, s.sid, "Move back to local", { answer: "Cancel", expectMove: false, dialogMs: 10_000 });
  const direct = await app.ev(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('handoff_move', { sessionId: ${J(s.sid)}, target: ${J(REPO)} }) }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
  const after = { local: side(REPO), w2: side(w2), refs: handoffRefs() };
  const view = await sessionView(app, s.sid);
  // 4. The test's own Local edit is discarded for the next phase.
  git(REPO, ["checkout", "--", "src/app.txt"]);
  const result = { setupMove: { ok: out.move?.ok, counts: out.move?.result ? { tracked: out.move.result.tracked, untracked: out.move.result.untracked } : null, w2Status: side(w2).status }, before, ui, direct, after, view, localAfterDiscard: side(REPO).status };
  result.verdict = {
    previewConflict: JSON.stringify(ui.preview?.result?.conflicts) === J(["src/app.txt"]),
    refusedBeforeDialog: ui.dialog?.found === false && ui.moveCalls === 0 && /^Nothing was moved: 1 file would conflict in Local \(src\/app\.txt\)/.test(ui.banner ?? ""),
    supervisorRefuses: direct.ok === false && /nothing was moved: 1 file\(s\) would conflict in the target: src\/app\.txt/.test(direct.error ?? ""),
    localUnchanged: sameMap(after.local, before.local),
    worktreeUnchanged: sameMap(after.w2, before.w2),
    noSnapshotRef: after.refs.length === before.refs.length,
    conversationStays: pathKey(view.stored?.workspace) === pathKey(w2),
  };
  return result;
}

/** A process holding `file` open for reading, sharing reads only (no delete): an editor or viewer would. */
async function holdOpen(file) {
  const hold = join(BASE, "lock.hold");
  const held = join(BASE, "lock.held");
  writeFileSync(hold, "hold\n");
  rmSync(held, { force: true });
  const script = `$fs = [System.IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Set-Content -LiteralPath '${held}' -Value held; while (Test-Path -LiteralPath '${hold}') { Start-Sleep -Milliseconds 200 }; $fs.Close()`;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
  const ready = await waitFor(() => existsSync(held), 15_000, 200);
  return {
    ready: Boolean(ready),
    release: async () => {
      rmSync(hold, { force: true });
      const exited = await waitFor(() => child.exitCode !== null, 10_000, 200);
      rmSync(held, { force: true });
      return Boolean(exited);
    },
  };
}

async function failure(app) {
  const s = state();
  await guard(app, s.w2);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const before = { local: side(REPO), w2: side(s.w2), refs: handoffRefs() };
  const viewBefore = await sessionView(app, s.sid);
  const lock = await holdOpen(join(REPO, "src", "app.txt"));
  if (!lock.ready) throw new Error("the lock holder did not start");
  // Local is watched while the move runs: writes, then the undo.
  const events = [];
  const t0 = Date.now();
  const watcher = watch(REPO, { recursive: true }, (type, name) => {
    const path = String(name ?? "").replaceAll("\\", "/");
    if (!/^(\.git|\.muse)(\/|$)/.test(path)) events.push({ atMs: Date.now() - t0, type, path });
  });
  let action;
  try {
    action = await moveThroughUi(app, s.sid, "Move back to local");
  } finally {
    await sleep(1_000);
    watcher.close();
  }
  const released = await lock.release();
  const after = { local: side(REPO), w2: side(s.w2), refs: handoffRefs() };
  const view = await sessionView(app, s.sid);
  const newRefs = after.refs.filter((r) => !before.refs.includes(r));
  const written = [...new Set(events.map((e) => e.path))].sort();
  const result = { before, lock: { file: "src/app.txt", share: "Read (no Delete)", released }, action, events: events.slice(0, 60), writtenPaths: written, after, newRefs, view };
  result.verdict = {
    confirmAsked: action.dialog?.found === true && action.dialog.answer === "OK" && Boolean(action.dialog.clicked),
    moveFailed: action.move?.ok === false,
    honestMessage: /^The conversation was not moved: the target could not receive the changes; both sides were restored as they were: .*unable to unlink old 'src\/app\.txt'/.test(action.banner ?? ""),
    wroteThenUndid: written.some((p) => p.startsWith("notes")) && written.includes("staged.txt"),
    localRestored: sameMap(after.local, before.local),
    worktreeUntouched: sameMap(after.w2, before.w2),
    snapshotKept: newRefs.length === 2,
    conversationStays: pathKey(view.stored?.workspace) === pathKey(s.w2) && view.logEntries === viewBefore.logEntries,
  };
  return result;
}

async function finalMove(app) {
  const s = state();
  await guard(app, s.w2);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const target = join(REPO, "staged.txt");
  chmodSync(target, 0o444);
  const before = { local: side(REPO), w2: side(s.w2), refs: handoffRefs(), readOnly: readOnly(target) };
  const action = await moveThroughUi(app, s.sid, "Move back to local");
  const after = { local: side(REPO), w2: side(s.w2), refs: handoffRefs(), readOnly: readOnly(target) };
  const view = await sessionView(app, s.sid);
  const result = { before, action, after, view };
  result.verdict = {
    readOnlyDidNotStopTheMove: before.readOnly === true && action.move?.ok === true,
    readOnlyAttributeCleared: after.readOnly === false,
    contentIsTheMovedVersion: readFileSync(target, "utf8") === "staged v2\n",
    localHoldsTheWork: sameMap(after.local.files, s.localBefore),
    worktreeClean: after.w2.status.length === 0,
    conversationHome: pathKey(view.stored?.workspace) === pathKey(REPO),
  };
  return result;
}

/**
 * After the ignored-count fix: a fresh test conversation in Local (the work of
 * the final phase is still there, with build.log ignored and the app's .muse
 * folder), Move to worktree, the question read, Cancel. No turn, nothing
 * moved; run cleanup afterwards to delete the conversation.
 */
async function ignoredCount(app) {
  const s = state();
  if (s.sid && (await app.ev(page(`return Boolean(row(${J(s.sid)}));`)))) throw new Error("the previous test conversation is still listed: run cleanup first");
  const conversation = await startTestConversation(app, await readUser(app));
  const sid = state().sid;
  await guard(app, REPO);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const before = { local: side(REPO), refs: handoffRefs(), gitIgnored: lines(git(REPO, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"])) };
  const asked = await moveThroughUi(app, sid, "Move to worktree", { answer: "Cancel" });
  const after = { local: side(REPO), refs: handoffRefs() };
  const question = (asked.dialog?.texts ?? []).join(" ");
  const result = { conversation: { adoptedAfterReload: conversation.adoptedAfterReload }, gitIgnored: before.gitIgnored, asked, preview: asked.preview?.result ?? null };
  result.verdict = {
    gitListsTheAppsEntries: before.gitIgnored.includes(".muse/.gitignore") && before.gitIgnored.includes("build.log"),
    questionCountsOneIgnoredItem: /• 1 ignored item left where they are/.test(question) && asked.preview?.result?.ignored === 1,
    cancelMovesNothing: asked.dialog?.found === true && asked.moveCalls === 0 && sameMap(after.local, before.local) && after.refs.length === before.refs.length,
  };
  return result;
}

async function cleanup(app) {
  const s = state();
  const result = {};
  if (s.sid) {
    result.conversation = await app.ev(page(`
      const actions = row(${J(s.sid)})?.querySelector("button[aria-label^='Actions for']");
      if (!actions) return { deleted: false, reason: 'no row' };
      actions.click();
      await pause(500);
      button('Delete…', document.querySelector('dialog[open]'))?.click();
      await pause(400);
      const confirm = button('Delete conversation', document.querySelector('dialog[open]'));
      confirm?.click();
      await pause(1200);
      return { deleted: !row(${J(s.sid)}), confirmed: Boolean(confirm) };
    `));
  }
  const after = await app.ev("localStorage.getItem('muse-desktop.projects.v1')");
  result.userProjectsUnchanged = sha(after) === sha(s.userProjectsRaw);
  if (s.originalActive) {
    result.originalSelection = await app.ev(page(`const b = row(${J(s.originalActive)})?.querySelector('button.session-select'); if (b) b.click(); await pause(800); return Boolean(b);`));
  }
  result.close = await closeApp(app);
  result.verdict = { conversationDeleted: result.conversation?.deleted === true, userProjectsUnchanged: result.userProjectsUnchanged, closedGracefully: result.close.graceful };
  return result;
}

// ---- complement (06/10/2026): isolated test mode, conversations A and C ---------

const TOKEN_FILE = "docs/item1.txt";
const NEW_FILE = "item1-written.txt";
const C_INITIAL = { ...INITIAL, [TOKEN_FILE]: "item 1, the version both folders share\n" };
const BULK_FILES = Number(argValue("--bulk", "2000"));
const T1 = "M2-05 complement, step 1. Run Get-Location with your shell tool now, then reply with only the exact path it printed.";
const T2 = (s) => `M2-05 complement, step 2. Do exactly these three steps, in this order, once each. 1) Run Get-Location with your shell tool. 2) Use your read_file tool, not the shell, to read ${TOKEN_FILE} in your current workspace. 3) Use your write_file tool, not the shell, to create ${NEW_FILE} in your current workspace with exactly this one line: WRITTEN-${s.written}. Then reply with only the line of ${TOKEN_FILE} that starts with ONLY-IN-WORKTREE, or NONE if it has no such line.`;
const SEND_3B = "M2-05 complement: sent while conversation A moves this folder's work. It must not start a turn.";

/**
 * fs.watch (recursive) on `root` until stop(): every event, timed, with its
 * path relative to `root`. A nameless event is libuv's overflow report
 * (events were lost): recorded as OVERFLOW.
 */
const OVERFLOW = "<no name: events lost>";
function watchTree(root) {
  const events = [];
  const t0 = Date.now();
  const watcher = watch(root, { recursive: true }, (type, name) => {
    events.push({ atMs: Date.now() - t0, type, path: name ? String(name).replaceAll("\\", "/") : OVERFLOW });
  });
  return { stop: async (quietMs = 1_500) => { await sleep(quietMs); watcher.close(); return events; } };
}

/**
 * Local's own files only: one non-recursive watcher per folder, .git and
 * .muse left out, so a burst of Git object writes cannot overflow it. For a
 * step that deletes no folder (a watched folder cannot go while watched).
 */
function watchWorkingTree(root) {
  const dirs = [root];
  for (let i = 0; i < dirs.length; i++) {
    for (const entry of readdirSync(dirs[i], { withFileTypes: true })) {
      if (entry.isDirectory() && !(dirs[i] === root && (entry.name === ".git" || entry.name === ".muse"))) dirs.push(join(dirs[i], entry.name));
    }
  }
  const events = [];
  const t0 = Date.now();
  const watchers = dirs.map((dir) => watch(dir, (type, name) => {
    events.push({ atMs: Date.now() - t0, type, path: name ? [relative(root, dir), String(name)].filter(Boolean).join("/").replaceAll("\\", "/") : OVERFLOW });
  }));
  return { folders: dirs.length, stop: async (quietMs = 1_500) => { await sleep(quietMs); for (const w of watchers) w.close(); return events; } };
}

/** Where an event under Local landed: Local's files, a worktree (`names` labels them), Git, the app's .muse. */
function placeOf(path, names = {}) {
  if (path === OVERFLOW) return "overflow";
  if (path === ".git" || path.startsWith(".git/")) return "git";
  const inWorktree = path.match(/^\.muse\/worktrees\/([^/]+)\/(.+)$/);
  if (inWorktree) return inWorktree[2] === ".git" ? "git" : names[inWorktree[1]] ?? `worktree ${inWorktree[1]}`;
  if (path === ".muse" || path.startsWith(".muse/")) return "app";
  return "local";
}

function summarize(events, place) {
  const by = {};
  for (const event of events) {
    const where = place(event.path);
    by[where] ??= { count: 0, paths: new Set() };
    by[where].count += 1;
    by[where].paths.add(event.path);
  }
  return {
    total: events.length,
    byPlace: Object.fromEntries(Object.entries(by).map(([where, v]) => [where, { count: v.count, paths: [...v.paths].sort().slice(0, 40), morePaths: Math.max(0, v.paths.size - 40) }])),
    first: events.slice(0, 80).map((event) => ({ ...event, place: place(event.path) })),
  };
}
const eventsAt = (summary, where) => summary?.byPlace?.[where]?.count ?? 0;

const composerState = (app) => app.ev(page(`
  const field = document.querySelector('textarea[aria-label="Message Muse"]');
  const send = document.querySelector('button.send');
  return field ? { active: activeSid(), disabled: field.disabled, placeholder: field.placeholder, sendDisabled: send ? send.disabled : null } : { active: activeSid(), found: false };
`));

const logStats = (app, sid) => app.ev(page(`
  const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
  return { entries: log.length, user: log.filter((e) => e.role === 'user').length, assistant: log.filter((e) => e.role === 'assistant').length, running: running(${J(sid)}) };
`));

/** The Move action as the Actions dialog shows it; clicked (a disabled button ignores it); the dialog closed. */
async function moveButtonState(app, sid) {
  const previews = (await ipc(app, "handoff_preview")).length;
  const button = await app.ev(page(`
    const actions = row(${J(sid)})?.querySelector("button[aria-label^='Actions for']");
    if (!actions) return { found: false, reason: 'no actions button' };
    actions.click();
    await pause(500);
    const dialog = document.querySelector('dialog[open]');
    const b = dialog ? [...dialog.querySelectorAll('button')].find((n) => /^(Move to worktree|Move back to local)$/.test((n.innerText || '').trim())) : null;
    const out = b ? { found: true, label: (b.innerText || '').trim(), disabled: b.disabled, title: b.title || null } : { found: false, reason: 'no move action' };
    if (b && b.disabled) b.click();
    await pause(400);
    document.querySelector('dialog[open] button[aria-label="Close"]')?.click();
    await pause(300);
    return out;
  `));
  await sleep(1_500);
  return { ...button, previewCalls: (await ipc(app, "handoff_preview")).length - previews };
}

/** Welcome screen -> "New project from a folder…" (the folder dialog answered) -> first message -> Start. */
async function startViaWelcome(app, folder, message) {
  const before = (await ipc(app, "start_session")).length;
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
    return { started: true, note };
  `));
  if (!outcome.started) throw new Error(`could not start from the welcome screen: ${outcome.reason}`);
  const call = await nextIpc(app, "start_session", before, 90_000);
  const meta = parse(call?.result);
  if (!call?.ok || !meta?.session_id) throw new Error(`start_session failed: ${J(call?.result ?? null)}`);
  return { sid: meta.session_id, note: outcome.note, startSession: { ok: call.ok, workspacePath: call.args?.workspacePath ?? null,
    authorizationMode: call.args?.authorizationMode ?? null, sandboxMode: call.args?.sandboxMode ?? null, hostApprovalMode: meta.approval_mode ?? null } };
}

/** Local's own uncommitted work (items 2 and 4): line 3 changed otherwise than A's, a staged change, a deletion, a binary edit, an untracked note. */
function ensureLocalWork() {
  const lines10 = C_INITIAL["src/app.txt"].split("\n").filter(Boolean);
  lines10[2] = "line 3 changed differently in Local";
  mkdirSync(join(REPO, "notes"), { recursive: true });
  for (const [path, content] of [["src/app.txt", `${lines10.join("\n")}\n`], ["notes/local.md", "- [ ] Local's own note, untracked\n"]]) {
    if (!existsSync(join(REPO, path)) || readFileSync(join(REPO, path), "utf8") !== content) writeFileSync(join(REPO, path), content);
  }
  if (readFileSync(join(REPO, "staged.txt"), "utf8") !== "staged v3, Local's own\n") writeFileSync(join(REPO, "staged.txt"), "staged v3, Local's own\n");
  git(REPO, ["add", "--", "staged.txt"]);
  rmSync(join(REPO, "deleted.txt"), { force: true });
  if (!readFileSync(join(REPO, "assets/blob.bin")).equals(BLOB_V2)) writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V2);
}

async function cSetup(app) {
  if (existsSync(REPO)) throw new Error(`${BASE} already holds a repository; pass another --base`);
  for (const dir of ["src", "assets", "docs"]) mkdirSync(join(REPO, dir), { recursive: true });
  git(REPO, ["init", "-q", "-b", "main"]);
  git(REPO, ["config", "user.name", "m2-05 proof"]);
  git(REPO, ["config", "user.email", "m2-05@localhost"]);
  for (const [path, content] of Object.entries(C_INITIAL)) writeFileSync(join(REPO, path), content);
  writeFileSync(join(REPO, "assets/blob.bin"), BLOB_V1);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-q", "-m", "initial"]);
  // Every tracked file rewritten by Git: Local and a fresh worktree hold the same bytes.
  for (const path of lines(git(REPO, ["ls-files"]))) rmSync(join(REPO, path));
  git(REPO, ["checkout", "--", "."]);
  const local = side(REPO);
  let autocrlf = null;
  try { autocrlf = git(REPO, ["config", "--get", "core.autocrlf"]).trim(); } catch { /* unset */ }
  saveState({ cleanMap: local.files, token: randomBytes(4).toString("hex").toUpperCase(), written: randomBytes(4).toString("hex").toUpperCase() });
  const profile = await app.ev(page("return { projects: (store('muse-desktop.projects.v1', '[]') || []).length, sessions: (store('muse-desktop.sessions.v1', '[]') || []).length, posture: localStorage.getItem('muse-desktop.authorization-mode.v1') };"));
  return { repo: { autocrlf, local }, profile, verdict: { repoClean: local.status.length === 0, emptyProfile: profile.projects === 0 && profile.sessions === 0 } };
}

/** Rehearsal only: A and C by a direct start_session each (no turn), adopted on a reload. */
async function cRehearseStart(app) {
  if (state().a) throw new Error("conversations already exist under this --base");
  const user = await readUser(app);
  const a = await startTestConversation(app, user);
  const aSid = state().sid;
  const c = await startTestConversation(app, user);
  saveState({ a: aSid, c: state().sid, sid: aSid, forgedStart: true });
  await select(app, aSid);
  return { forged: "A and C started by a direct start_session each (no turn), adopted on a reload", a: a.view.stored, c: c.view.stored,
    verdict: { bothInLocal: [a, c].every((x) => pathKey(x.view.stored?.workspace) === pathKey(REPO)) } };
}

async function cStart(app) {
  if (state().a) throw new Error("conversation A already exists under this --base");
  // A dry run (--rehearse) refuses the first message in the page: no turn, no card.
  await app.ev(`(window.__baselineIpc.block = ${REHEARSE ? "['send_input']" : "[]"}, true)`);
  const sends = (await ipc(app, "send_input")).length;
  const started = await startViaWelcome(app, REPO, T1);
  const a = started.sid;
  saveState({ a, sid: a });
  let whileRunning = null;
  const readWhileRunning = async () => {
    whileRunning = { running: await app.ev(page(`return running(${J(a)});`)), composer: await composerState(app), move: await moveButtonState(app, a) };
  };
  const turn = REHEARSE
    ? (await sleep(5_000), await readWhileRunning(), { finished: false, entries: [], rehearsal: true })
    : await waitTurn(app, a, { prompt: T1, before: 0, sends, onCard: readWhileRunning });
  const cwd = reportedCwd(turn);
  const view = await sessionView(app, a);
  // C: A's own "Fork conversation" once the turn is over (no turn).
  const forks = (await ipc(app, "fork_session")).length;
  const click = await clickAction(app, a, "Fork conversation");
  const fork = click.clicked ? await nextIpc(app, "fork_session", forks, 60_000) : null;
  let c = parse(fork?.result)?.session_id ?? null;
  let fallback = null;
  if (c) saveState({ c });
  else if (!REHEARSE) {
    // Declared fallback: C by a direct start_session (no turn), adopted on a reload.
    await startTestConversation(app, await readUser(app));
    c = state().sid;
    saveState({ c, sid: a, forgedStart: true });
    fallback = "the fork failed: C started by a direct start_session (no turn), adopted on a reload";
  }
  await sleep(1_500);
  const cView = c ? await sessionView(app, c) : null;
  await select(app, a);
  const result = { liveTurns: REHEARSE ? 0 : 1, welcome: { note: started.note, startSession: started.startSession }, turn, cwd, whileRunning, view,
    fork: { click, ok: fork?.ok ?? null, result: fork?.ok ? null : fork?.result ?? null, fallback, c: cView } };
  result.verdict = {
    turnFinished: turn.finished,
    startedInLocal: pathKey(started.startSession.workspacePath) === pathKey(REPO) && pathKey(view.stored?.workspace) === pathKey(REPO),
    modelCwdLocal: shellIn(cwd, "local"),
    moveRefusedWhileRunning: whileRunning?.running === "true" && whileRunning.move.found === true && whileRunning.move.disabled === true && whileRunning.move.previewCalls === 0,
    refusalSaysWhy: /respond/i.test(whileRunning?.move.title ?? ""),
    forkInLocal: Boolean(c) && pathKey(cView?.stored?.workspace) === pathKey(REPO),
  };
  return result;
}

/**
 * Item 3, second half: A moves its work (bulk files keep Git busy) while C,
 * idle in the same folder, sends through its composer. No IPC block, except
 * send_input in a rehearsal; the send goes only while the move is seen running.
 */
async function cSendDuringMove(app) {
  const s = state();
  if (!s.c) throw new Error("no conversation C: run c-start first");
  await guard(app, REPO, s.a);
  // 1. A's work in Local: the line only the worktree will hold (item 1), line 3
  //    (item 4), a staged change, an ignored file, bulk files.
  const lines10 = C_INITIAL["src/app.txt"].split("\n").filter(Boolean);
  lines10[2] = "line 3 changed in Local, moved with A";
  writeFileSync(join(REPO, "src/app.txt"), `${lines10.join("\n")}\n`);
  writeFileSync(join(REPO, TOKEN_FILE), `${C_INITIAL[TOKEN_FILE]}ONLY-IN-WORKTREE-${s.token}\n`);
  writeFileSync(join(REPO, "staged.txt"), "staged v2, moved with A\n");
  git(REPO, ["add", "--", "staged.txt"]);
  mkdirSync(join(REPO, "bulk"), { recursive: true });
  for (let i = 0; i < BULK_FILES; i++) writeFileSync(join(REPO, "bulk", `f${String(i).padStart(5, "0")}.txt`), `bulk ${i} ${s.token}\n`);
  writeFileSync(join(REPO, "build.log"), "ignored, stays in Local\n");
  const before = { local: side(REPO), refs: handoffRefs() };
  const cBefore = await logStats(app, s.c);
  await app.ev(`(window.__baselineIpc.block = ${REHEARSE ? "['send_input']" : "[]"}, true)`);
  // 2. A's Move to worktree, answered OK; while it runs, C sends.
  const n = { move: (await ipc(app, "handoff_move")).length, send: (await ipc(app, "send_input")).length };
  const moveCall = async () => (await ipc(app, "handoff_move")).slice(n.move)[0] ?? null;
  const click = await clickAction(app, s.a, "Move to worktree");
  if (!click.clicked) throw new Error(`Move to worktree: ${J(click)}`);
  // The question waits for the preview: one new loose object per bulk file, ~65 ms each on the proof machine.
  const dialog = await nativeDialog(s.pid, "OK", 600_000);
  const started = await waitFor(moveCall, 60_000, 100);
  const tStart = Date.now();
  const composerA = await composerState(app);
  const send = { attempted: false };
  if (started && (await moveCall()).result === undefined) {
    await app.ev(page(`const b = row(${J(s.c)})?.querySelector('button.session-select'); if (b) b.click(); return !!b;`));
    await waitFor(() => app.ev(page(`return activeSid() === ${J(s.c)} && Boolean(document.querySelector('textarea[aria-label="Message Muse"]'));`)), 10_000, 100);
    send.composerC = await composerState(app);
    if ((await moveCall()).result !== undefined) send.reason = "the move ended before C's composer was ready";
    else if (send.composerC?.disabled !== false) send.reason = "C's composer is not usable";
    else {
      send.attempted = true;
      send.click = await app.ev(page(`
        setValue(document.querySelector('textarea[aria-label="Message Muse"]'), ${J(SEND_3B)});
        await pause(200);
        const b = document.querySelector('button.send');
        if (!b || b.disabled) return { clicked: false };
        b.click();
        return { clicked: true };
      `));
      const answered = await waitFor(async () => { const c = (await ipc(app, "send_input")).slice(n.send)[0]; return c?.result !== undefined ? c : null; }, 30_000, 100);
      const moveAtAnswer = await moveCall();
      send.call = answered ? { sessionId: answered.args?.sessionId ?? null, atMs: answered.atMs, ok: answered.ok, blockedByHarness: answered.blocked, result: parse(answered.result) } : null;
      send.moveCallAtMs = started.atMs;
      send.moveStillRunningWhenAnswered = moveAtAnswer?.result === undefined;
    }
  } else send.reason = started ? "the move ended before the send" : "no handoff_move call";
  const moved = await waitFor(async () => { const m = await moveCall(); return m?.result !== undefined ? m : null; }, 300_000, 200);
  const moveSeenMs = Date.now() - tStart;
  await waitFor(() => app.ev(page("return !q('button').some((b) => /^(Checking what will move|Creating a worktree|Moving the work|Starting Muse there)/.test((b.innerText || '').trim()));")), 30_000, 400);
  await sleep(1_500);
  // 3. C as it shows now; its unsent row is discarded (never retried).
  const cAfter = await app.ev(page(`
    return { active: activeSid(), banner: banner(),
      unsent: q('.pending-send').map((n) => ({ text: text(n.querySelector('.pending-send-text')), error: text(n.querySelector('.pending-send-error')) })) };
  `));
  cAfter.log = await logStats(app, s.c);
  cAfter.discarded = cAfter.active === s.c && cAfter.unsent.length > 0
    ? await app.ev(page("const b = q('.pending-send button').find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); await pause(600); return { clicked: Boolean(b), left: q('.pending-send').length };"))
    : null;
  await select(app, s.a);
  const w1 = moved?.ok ? parse(moved.result)?.target ?? null : null;
  if (w1) saveState({ w1 });
  const after = { local: side(REPO), w1: w1 ? side(w1) : null, refs: handoffRefs() };
  const view = await sessionView(app, s.a);
  const result = { bulkFiles: BULK_FILES, rehearsal: REHEARSE, before: { local: before.local, refs: before.refs.length },
    action: { click, dialog, move: moved ? { atMs: moved.atMs, ok: moved.ok, result: parse(moved.result) } : null, moveSeenRunningMs: moveSeenMs },
    composerA, send, cBefore, cAfter, after: { local: after.local, w1: after.w1, refs: after.refs.length }, view };
  result.verdict = {
    moved: moved?.ok === true && after.w1 !== null,
    composerARefusesWithReason: composerA?.active === s.a && composerA.disabled === true && /folder is being moved: send once the move is done/.test(composerA.placeholder ?? ""),
    sendDuringTheMove: send.attempted === true && send.moveStillRunningWhenAnswered === true && send.call?.atMs > send.moveCallAtMs,
    sendRefusedHonestly: send.call?.ok === false && send.call.blockedByHarness === false
      && /this conversation's folder is being moved: send again once the move is done/.test(String(send.call.result)),
    keptAsUnsent: cAfter.unsent.some((u) => /being moved/.test(u.error ?? "")),
    noTurnInC: cAfter.log.assistant === cBefore.assistant && cAfter.log.running !== "true",
    worktreeHoldsTheWork: after.w1 !== null && sameMap(after.w1.files, without(before.local.files, ["build.log"])),
    localClean: after.local.status.length === 0 && sameMap(after.local.files, { ...s.cleanMap, "build.log": before.local.files["build.log"] }),
    snapshotRef: after.refs.length === before.refs.length + 2,
    conversationFollowed: pathKey(view.stored?.workspace) === pathKey(w1),
  };
  return result;
}

/** Items 1 and 3: A's file tools in its worktree; while its first card waits, every way to move. */
async function cFileTools(app) {
  const s = state();
  if (!s.w1 || !s.c) throw new Error("run c-send-during-move first");
  await guard(app, s.w1, s.a);
  mkdirSync(join(REPO, "notes"), { recursive: true });
  writeFileSync(join(REPO, "notes/cross.md"), "Local's own work while A answers in its worktree\n");
  const item1 = () => {
    const local = readFileSync(join(REPO, TOKEN_FILE));
    const worktree = readFileSync(join(s.w1, TOKEN_FILE));
    return { local: sha(local), worktree: sha(worktree), localHasToken: local.includes(s.token), worktreeHasToken: worktree.includes(s.token) };
  };
  const before = { local: side(REPO), w1: side(s.w1), refs: handoffRefs(), item1: item1() };
  await app.ev("(window.__baselineIpc.block = [], true)");
  let whileRunning = null;
  const turn = await liveTurn(app, s.a, T2(s), { onCard: async () => {
    const out = { running: await app.ev(page(`return running(${J(s.a)});`)), card: await app.ev(page("return text(q('.approvals .approval')[0]);")) };
    out.self = await moveButtonState(app, s.a);
    // The supervisor, called directly: A cannot move while it answers.
    out.direct = await app.ev(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('handoff_move', { sessionId: ${J(s.a)}, target: ${J(REPO)} }) }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
    // C, idle in Local (A's host folder), moves through the real UI.
    const watcher = watchTree(REPO);
    await select(app, s.c);
    out.cMove = await moveThroughUi(app, s.c, "Move to worktree");
    const events = await watcher.stop();
    const wc = out.cMove.move?.target ?? null;
    if (wc) saveState({ wc });
    out.cEvents = summarize(events, (p) => placeOf(p, wc ? { [basename(wc)]: "c's new worktree" } : {}));
    out.cWorktree = wc && existsSync(wc) ? side(wc) : null;
    out.cView = await sessionView(app, s.c);
    whileRunning = out;
  } });
  const after = { local: side(REPO), w1: side(s.w1), refs: handoffRefs(), item1: item1() };
  const written = existsSync(join(s.w1, NEW_FILE)) ? readFileSync(join(s.w1, NEW_FILE), "utf8") : null;
  const tools = turn.entries.filter((e) => e.role === "tool").map((e) => e.text.slice(0, 400));
  const answer = turn.entries.filter((e) => e.role === "assistant").at(-1)?.text ?? "";
  const cwd = reportedCwd(turn);
  const result = { liveTurns: 1, before: { item1: before.item1, local: before.local, w1: before.w1, refs: before.refs.length }, turn, cwd, tools, answer,
    written: written === null ? null : { sha: sha(written), text: written }, whileRunning,
    after: { item1: after.item1, local: after.local, w1: after.w1, refs: after.refs.length } };
  result.verdict = {
    turnFinished: turn.finished,
    sameSession: turn.sendInput?.sessionId === s.a,
    modelCwdWorktree: shellIn(cwd, "worktree 1"),
    readFileUsed: tools.some((t) => /^read_file\b/.test(t) && t.includes("item1")),
    readSawTheWorktreeVersion: answer.includes(`ONLY-IN-WORKTREE-${s.token}`) && !before.item1.localHasToken && before.item1.worktreeHasToken,
    writeFileUsed: tools.some((t) => /^write_file\b/.test(t) && t.includes(NEW_FILE)),
    newFileInWorktreeOnly: written?.replace(/\r?\n$/, "") === `WRITTEN-${s.written}` && !existsSync(join(REPO, NEW_FILE)),
    localUntouched: sameMap(after.local, before.local),
    worktreeGainedOnlyTheNewFile: NEW_FILE in after.w1.files && sameMap(without(after.w1.files, [NEW_FILE]), before.w1.files),
    // Item 3, while the turn waited on its first card.
    selfMoveRefused: whileRunning?.running === "true" && whileRunning.self.disabled === true && whileRunning.self.previewCalls === 0,
    selfRefusalSaysWhy: /respond/i.test(whileRunning?.self.title ?? ""),
    supervisorRefusesWhileRunning: whileRunning?.direct.ok === false && /still responding/.test(whileRunning.direct.error ?? ""),
    otherConversationRefused: whileRunning?.cMove.move?.ok === false && /still responding in this folder/.test(J(whileRunning.cMove.move.result)),
    refusalShown: /^The conversation was not moved: a conversation is still responding/.test(whileRunning?.cMove.banner ?? ""),
    refusedMoveTouchedNoLocalFile: eventsAt(whileRunning?.cEvents, "local") === 0 && eventsAt(whileRunning?.cEvents, "overflow") === 0
      && pathKey(whileRunning?.cView.stored?.workspace) === pathKey(REPO),
  };
  return result;
}

/**
 * Item 2: C moves Local to a new worktree while another process holds a Local
 * file open (FileShare.Read, no delete): a tracked file Git must rewrite, or an
 * untracked one it must delete. Local watched, the new worktree included.
 */
async function cHeld(app, untracked) {
  const s = state();
  if (!s.c) throw new Error("no conversation C");
  await guard(app, REPO, s.c);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  ensureLocalWork();
  const held = untracked ? "notes/local.md" : "src/app.txt";
  const before = { local: side(REPO), refs: handoffRefs() };
  const viewBefore = await sessionView(app, s.c);
  const lock = await holdOpen(join(REPO, ...held.split("/")));
  if (!lock.ready) throw new Error("the lock holder did not start");
  const watcher = watchTree(REPO);
  let action;
  let events;
  try {
    action = await moveThroughUi(app, s.c, "Move to worktree");
  } finally {
    events = await watcher.stop();
  }
  const released = await lock.release();
  const target = action.move?.target ?? null;
  if (target) saveState({ [untracked ? "w3" : "w2"]: target });
  const ev = summarize(events, (p) => placeOf(p, target ? { [basename(target)]: "target" } : {}));
  const after = { local: side(REPO), target: target && existsSync(target) ? side(target) : null, refs: handoffRefs() };
  const view = await sessionView(app, s.c);
  const newRefs = after.refs.filter((r) => !before.refs.includes(r));
  const result = { conversationC: s.forgedStart ? "started by a direct start_session, no turn (rehearsal)" : "A's Fork conversation, through the UI",
    held: { path: held, share: "Read (no Delete)", released }, before: { local: before.local, refs: before.refs.length }, action, events: ev,
    after: { local: after.local, target: after.target, refs: after.refs.length }, newRefs, view };
  // What a move reported as done left behind in Local, if it was reported done.
  if (action.move?.ok === true) result.leftInSource = Object.keys(after.local.files).filter((p) => !(p in s.cleanMap) && p !== "build.log");
  result.verdict = {
    confirmAsked: action.dialog?.found === true && action.dialog.answer === "OK" && Boolean(action.dialog.clicked),
    targetReceivedTheWork: (ev.byPlace.target?.paths ?? []).some((p) => p.endsWith("notes/local.md")),
    moveFailed: action.move?.ok === false,
    honestMessage: (untracked
      ? /^The conversation was not moved: the source could not be cleaned; both sides were restored as they were: .*notes\/local\.md/
      : /^The conversation was not moved: the source could not be cleaned; both sides were restored as they were: .*unable to unlink old 'src\/app\.txt'/).test(action.banner ?? ""),
    localByteIdentical: sameMap(after.local, before.local),
    targetBackToItsCheckout: after.target !== null && after.target.status.length === 0 && sameMap(after.target.files, s.cleanMap),
    snapshotKept: newRefs.length === 2,
    heldFileUnchanged: after.local.files[held] === before.local.files[held],
    conversationStays: pathKey(view.stored?.workspace) === pathKey(REPO) && view.logEntries === viewBefore.logEntries,
    noEventLost: eventsAt(ev, "overflow") === 0,
  };
  return result;
}

/** Item 4: A's way back refused on a conflict, in the UI and directly; both folders watched. */
async function cConflict(app) {
  const s = state();
  await guard(app, s.w1, s.a);
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  ensureLocalWork();
  const before = { local: side(REPO), w1: side(s.w1), refs: handoffRefs() };
  // Local's folders one by one (Git's object writes in .git overflowed a
  // recursive watcher on Local in the rehearsal), the worktree recursively
  // (its Git data lives in Local's .git), and Local's .git for the record.
  // The root watcher also sees the .git and .muse folders' own entries change.
  const placeLocal = (p) => placeOf(p);
  const placeWorktree = (p) => (p === OVERFLOW ? "overflow" : p === ".git" ? "git" : "worktree 1");
  const placeGit = (p) => (p === OVERFLOW ? "overflow" : "git");
  const watched = async (act) => {
    const local = watchWorkingTree(REPO);
    const worktree = watchTree(s.w1);
    const gitDir = watchTree(join(REPO, ".git"));
    const outcome = await act();
    return { outcome, localFolders: local.folders, events: { local: summarize(await local.stop(), placeLocal), worktree: summarize(await worktree.stop(0), placeWorktree), git: summarize(await gitDir.stop(0), placeGit) } };
  };
  const ui = await watched(() => moveThroughUi(app, s.a, "Move back to local", { answer: "Cancel", expectMove: false, dialogMs: 10_000 }));
  const direct = await watched(() => app.ev(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('handoff_move', { sessionId: ${J(s.a)}, target: ${J(REPO)} }) }; } catch (e) { return { ok: false, error: String(e) }; } })()`));
  const after = { local: side(REPO), w1: side(s.w1), refs: handoffRefs() };
  const view = await sessionView(app, s.a);
  // The user's files on both sides; a lost-event report on either counts against.
  const userFiles = (e) => eventsAt(e.local, "local") + eventsAt(e.local, "overflow") + eventsAt(e.worktree, "worktree 1") + eventsAt(e.worktree, "overflow");
  const result = { before: { local: before.local, w1: before.w1, refs: before.refs.length }, localFoldersWatched: ui.localFolders, ui: ui.outcome, uiEvents: ui.events, direct: direct.outcome, directEvents: direct.events,
    after: { local: after.local, w1: after.w1, refs: after.refs.length }, view };
  result.verdict = {
    previewConflict: (ui.outcome.preview?.result?.conflicts ?? []).includes("src/app.txt"),
    refusedBeforeTheQuestion: ui.outcome.dialog?.found === false && ui.outcome.moveCalls === 0 && /^Nothing was moved: \d+ files? would conflict in Local \(.*src\/app\.txt/.test(ui.outcome.banner ?? ""),
    supervisorRefuses: direct.outcome.ok === false && /nothing was moved: \d+ file\(s\) would conflict in the target: .*src\/app\.txt/.test(direct.outcome.error ?? ""),
    noFileEventUi: userFiles(ui.events) === 0,
    noFileEventDirect: userFiles(direct.events) === 0,
    localUnchanged: sameMap(after.local, before.local),
    worktreeUnchanged: sameMap(after.w1, before.w1),
    noSnapshotRef: after.refs.length === before.refs.length,
    conversationStays: pathKey(view.stored?.workspace) === pathKey(s.w1),
  };
  return result;
}

async function cStop(app) {
  const close = await closeApp(app);
  return { close, verdict: { closedGracefully: close.graceful, exited: close.exited } };
}

// ---- main ---------------------------------------------------------------------------

const PHASES = { setup, "confirm-defect": confirmDefect, "turn-local": turnLocal, move, "turn-worktree": turnWorktree, back, conflict, failure, final: finalMove, "ignored-count": ignoredCount, cleanup,
  "c-setup": cSetup, "c-rehearse-start": cRehearseStart, "c-start": cStart, "c-send-during-move": cSendDuringMove, "c-file-tools": cFileTools,
  "c-held-tracked": (app) => cHeld(app, false), "c-held-untracked": (app) => cHeld(app, true), "c-conflict": cConflict, "c-stop": cStop };
if (PHASE === "rederive") {
  // Recheck the stored turns with the current classifier: no app, no turn.
  // The live reading (with the `\\?\` flag the redaction removes) stays in `cwd`.
  const record = readJson(OUT, null);
  const out = {};
  for (const [key, place, name] of [["turn-local", "local", "modelCwdLocal"], ["turn-worktree", "worktree 1", "modelCwdWorktree"], ["restart", "worktree 1", "modelCwdWorktree"]]) {
    const phase = record?.phases?.[key];
    if (!phase?.turn?.entries) continue;
    phase.cwdRederived = reportedCwd(phase.turn);
    phase.verdict[name] = shellIn(phase.cwdRederived, place);
    out[key] = { [name]: phase.verdict[name] };
  }
  // The move's Local check, from its stored hashes (an order-sensitive compare once failed it).
  const move = record?.phases?.move;
  if (move?.after?.local && move.before?.local) {
    move.verdict.localClean = move.after.local.status.length === 0
      && sameMap(move.after.local.files, { ...state().cleanMap, "build.log": move.before.local.files["build.log"] });
    out.move = { localClean: move.verdict.localClean };
  }
  // The way back's question, from its stored text (the first pattern expected "to Local?").
  const back = record?.phases?.back;
  if (back?.action?.dialog?.found) {
    back.verdict.confirmAsked = back.action.dialog.answer === "OK" && Boolean(back.action.dialog.clicked)
      && /in this folder to Local, including changes made outside/.test((back.action.dialog.texts ?? []).join(" "));
    out.back = { confirmAsked: back.verdict.confirmAsked };
  }
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}
if (PHASE === "stop") {
  // Between builds: close this harness's instance from its window, record nothing.
  process.stdout.write(`${JSON.stringify(await closeApp(null))}\n`);
  process.exit(0);
}
if (PHASE !== "launch" && PHASE !== "c-launch" && PHASE !== "restart" && !PHASES[PHASE]) {
  process.stderr.write("usage: cdp-m2-05-handoff.mjs <launch|stop|setup|confirm-defect|turn-local|move|turn-worktree|restart|back|conflict|failure|final|ignored-count|cleanup|rederive"
    + "|c-launch|c-setup|c-rehearse-start|c-start|c-send-during-move|c-file-tools|c-held-tracked|c-held-untracked|c-conflict|c-stop>"
    + " [--base dir] [--exe path] [--engine path] [--out file] [--as key] [--bulk n] [--rehearse]\n");
  process.exit(1);
}
let app = null;
try {
  let result;
  if (PHASE === "launch" || PHASE === "c-launch") {
    ({ app, result } = await launch());
  } else {
    if (!state().pid || !alive(state().pid)) throw new Error("the harness's app instance is not running: run launch first");
    app = await attach();
    if (PHASE === "restart") ({ app, result } = await restart(app));
    else result = await PHASES[PHASE](app);
  }
  if (PHASE !== "cleanup" && PHASE !== "c-stop" && app) {
    await app.ev("(window.__baselineIpc.block = [], true)");
    result.consoleErrors = app.errors.slice(0, 20);
  }
  const written = merge(result);
  process.stdout.write(`${JSON.stringify(written.verdict ?? written, null, 2)}\n`);
} catch (error) {
  merge({ failure: String(error?.message ?? error).slice(0, 400), consoleErrors: app?.errors.slice(0, 20) ?? [] });
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  app?.close();
}
