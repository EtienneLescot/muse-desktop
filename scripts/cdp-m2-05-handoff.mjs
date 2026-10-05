#!/usr/bin/env node

/**
 * M2-05 native acceptance: one conversation moved Local -> worktree -> Local
 * through the real "Move to worktree" / "Move back to local" action, on host
 * 1.4.2 (same session, `turn/start.workspaceRoots`). A test Git repository
 * under --base and one test conversation; every phase refuses to act unless
 * that conversation is the active one and runs under --base.
 *
 * Phases, in order, on one app instance this harness started:
 *   launch      start the CDP-enabled build (refused if another instance runs).
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
 * Usage:
 *   node scripts/cdp-m2-05-handoff.mjs <phase> [--base G:\muse-proofs\m2-05]
 *     [--exe <muse-desktop.exe>] [--out docs/evidence/2026-10-05-roadmap-closure/m2-05-handoff.json]
 * Each phase merges its path-free result into --out.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const PHASE = process.argv[2];
const BASE = argValue("--base", "G:\\muse-proofs\\m2-05");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m2-05-handoff.json");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
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
  for (const [key, label] of [["w0", "<worktree 0>"], ["w1", "<worktree 1>"], ["w2", "<worktree 2>"]]) {
    if (s[key]) pairs.unshift([s[key].replace(/^\\\\\?\\/, ""), label]);
  }
  return redactor(pairs)(value);
}

function engineVersion() {
  try {
    return execFileSync(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"), ["--version"],
      { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

function merge(result) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m2-05-handoff.v1",
    ticket: "M2-05",
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  record.phases[PHASE] = redact({ commit: record.commit, ...result });
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[PHASE];
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
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What one checkout holds: porcelain status, index vs HEAD, branch, bytes. */
function side(dir) {
  return {
    branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: lines(git(dir, ["status", "--porcelain=v1", "-uall"])),
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

/** Started the way a user does, from PowerShell, with the proof environment. */
function launchApp() {
  const pid = execFileSync("powershell", ["-NoProfile", "-Command",
    `$env:MUSE_NO_AUTO_UPDATE='1'; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; (Start-Process -FilePath '${EXE}' -PassThru).Id`],
  { encoding: "utf8" }).trim();
  saveState({ pid: Number(pid) });
  return Number(pid);
}

async function attach() {
  let app = null;
  await waitFor(async () => { try { app = await openPage(); return true; } catch { return false; } }, 60_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
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
async function guard(app, workspace) {
  const s = state();
  if (!s.sid) throw new Error("no test conversation: run setup first");
  if (!(await app.ev(page(`return Boolean(row(${J(s.sid)}));`)))) throw new Error("refusing: the test conversation is not in the sidebar");
  if ((await app.ev(page("return activeSid();"))) !== s.sid) await select(app, s.sid);
  const r = await app.ev(page(`const s = stored(${J(s.sid)}); return { active: activeSid(), workspace: s?.workspace ?? null, host: s?.host_workspace ?? null };`));
  if (r.active !== s.sid) throw new Error("refusing: the active conversation is not the test conversation");
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
async function liveTurn(app, sid, prompt) {
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
  const t0 = Date.now();
  const approvals = [];
  let sawRunning = false;
  const done = await waitFor(async () => {
    const v = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || [];
      return { running: running(${J(sid)}), cards: q('.approvals .approval').length, open: log.some((e) => e.open),
        assistant: log.slice(${before}).some((e) => e.role === 'assistant' && String(e.text || '').trim()) };
    `));
    if (v.running === "true") sawRunning = true;
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
  return { prompt, sendInput: call ? { sessionId: call.args?.sessionId ?? null, ok: call.ok } : null, finished: Boolean(done), ms: Date.now() - t0, approvals, entries };
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
  const foreign = appPids();
  if (foreign.length > 0) throw new Error(`blocked: ${foreign.length} muse-desktop process(es) not started by this harness are running`);
  mkdirSync(BASE, { recursive: true });
  const pid = launchApp();
  const app = await attach();
  return { app, result: { started: true, pidRecorded: Boolean(pid) } };
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
  launchApp();
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

// ---- main ---------------------------------------------------------------------------

const PHASES = { setup, "confirm-defect": confirmDefect, "turn-local": turnLocal, move, "turn-worktree": turnWorktree, back, conflict, failure, final: finalMove, "ignored-count": ignoredCount, cleanup };
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
if (PHASE !== "launch" && PHASE !== "restart" && !PHASES[PHASE]) {
  process.stderr.write("usage: cdp-m2-05-handoff.mjs <launch|stop|setup|confirm-defect|turn-local|move|turn-worktree|restart|back|conflict|failure|final|ignored-count|cleanup|rederive> [--base dir] [--exe path] [--out file]\n");
  process.exit(1);
}
let app = null;
try {
  let result;
  if (PHASE === "launch") {
    ({ app, result } = await launch());
  } else {
    if (!state().pid || !alive(state().pid)) throw new Error("the harness's app instance is not running: run launch first");
    app = await attach();
    if (PHASE === "restart") ({ app, result } = await restart(app));
    else result = await PHASES[PHASE](app);
  }
  if (PHASE !== "cleanup" && app) {
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
