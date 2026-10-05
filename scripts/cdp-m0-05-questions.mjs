#!/usr/bin/env node

/**
 * M0-05 questions, native acceptance on Windows with Muse 1.4.2: the model's
 * `request_user_input` tool raises a question (userInput/request), the app
 * paints it as an "Input needed" card, and the card survives the incidents the
 * ticket names. Each test conversation runs in its own folder under --base
 * (--folder, one engine per folder); every phase refuses to act unless that
 * conversation is the active one and runs in that folder.
 *
 * Phases, on one app instance this harness started:
 *   launch   start the CDP-enabled build (refused if any muse-desktop runs).
 *   setup    no turn. The folder and its test conversation. Every UI start
 *            needs a project root or the global default folder, both the
 *            user's, and the profile holds the 5-project maximum: the native
 *            start_session runs directly with the user's global posture and
 *            isolation (no connector servers), then a reload lets the app
 *            adopt it (restore_sessions).
 *   death    1 turn. (4) A question pending, then only the conversation's
 *            engine is killed: the muse.exe child of the app whose working
 *            directory is the folder. The app stays open. Card, transcript,
 *            connection and the bridge's host_exited events are read after the
 *            exit. --build pre-fix (this build without the host_exited hunk of
 *            d01fefa) also answers the card left on screen; the fixed build
 *            presses Reconnect and reads what the new engine lists.
 *   orphan   no turn. After a death and a relaunch, the conversation resumed
 *            on a new engine: a card for the killed engine's question, or not,
 *            and an answer to it when there is one.
 *   stuck    no turn, in the instance that sent the conversation's last turn:
 *            that turn as the engine recorded it (its session log) against the
 *            events that reached the app (the poll tap).
 *   answer   1 turn. A pick-exactly-two question. (3) One box ticked and sent:
 *            the host refuses it (-32057, min_selections 2) and the card keeps
 *            the tick, same DOM node. (2) The page reloaded with the question
 *            pending: the card comes back from list_pending_requests with no
 *            action and no replayed event. (1) Two boxes ticked and sent: the
 *            turn goes on with both labels. If the model set no bound, the
 *            first answer is rewritten in transit to a label the question
 *            lacks (recorded as forged).
 *   finish   no new turn. The running turn's question answered with valid
 *            picks, then the turn's end: do events still reach the app?
 *   cleanup  no turn. Every test conversation deleted through the UI, the
 *            user's projects, posture and isolation compared byte for byte,
 *            his selection given back, app closed gracefully.
 *   stop     closes this harness's instance between builds (no record).
 *   rederive reads the stored answer turn again (reply, verdict): no app.
 *
 * Order used on 05-06/10/2026 (see the record's liveTurnsDetail): launch,
 * setup, death (pre-fix); stop, launch, orphan (head); stop, launch, orphan,
 * answer (it got no event back), stuck; setup --folder b; stop, launch, death,
 * answer, finish (--folder b); stop, launch, orphan, answer (--folder b);
 * cleanup. msp-orphan-prompt.mjs ran between head and the first fixed build,
 * with the app closed.
 *
 * Usage:
 *   node scripts/cdp-m0-05-questions.mjs <phase> [--folder ws] [--build fixed|head|pre-fix]
 *     [--base G:\muse-proofs\m0-05-questions] [--exe <muse-desktop.exe>]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m0-05-questions.json]
 * Each phase merges its path-free result into --out, keyed by phase, build
 * (when not fixed) and folder (when not ws). The app is started with
 * MUSE_NO_AUTO_UPDATE=1 and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
 * --remote-debugging-port=9222 (MUSE_CDP_PORT overrides the port).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const PHASE = process.argv[2];
const BUILD = argValue("--build", "fixed");
const FOLDER = argValue("--folder", "ws");
const BASE = argValue("--base", "G:\\muse-proofs\\m0-05-questions");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m0-05-questions.json");
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const WS = join(BASE, FOLDER);
const STATE = join(BASE, "harness-state.json");
const SHOTS = "docs/evidence/2026-10-05-roadmap-closure/shots";
const KEY = [PHASE, BUILD === "fixed" ? null : BUILD, FOLDER === "ws" ? null : FOLDER].filter(Boolean).join("-");
const SHOT = (name) => [`m0-05-q-${name}`, BUILD === "fixed" ? null : BUILD, FOLDER === "ws" ? null : FOLDER].filter(Boolean).join("-");
const J = JSON.stringify;

// The tool takes 2-3 options per question.
const PROMPTS = {
  death: 'Before anything else, call your request_user_input tool exactly once, with one single-select question: id "fruit", header "Fruit", question "Which fruit should I name?", options "Apple", "Banana", "Cherry". After my answer, reply with only the fruit I picked, in capital letters. Use no other tool.',
  answer: 'Before anything else, call your request_user_input tool exactly once, with one multi-select question: id "colors", header "Colors", question "Pick exactly two colors", options "Red", "Green", "Blue", selection {"mode": "multiple", "min_selections": 2, "max_selections": 2}. After my answer, reply with only the colors I picked, in capital letters, joined by a plus sign. Use no other tool.',
};

// ---- state, record, redaction ------------------------------------------------

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state = () => {
  const s = readJson(STATE, {});
  // First runs kept one conversation, in "ws", under `sid`.
  return s.conversations || !s.sid ? s : { ...s, conversations: [{ folder: "ws", sid: s.sid }] };
};
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));
const conversation = () => (state().conversations ?? []).find((c) => c.folder === FOLDER) ?? null;
const sha = (data) => createHash("sha256").update(data ?? "").digest("hex").slice(0, 16);
const parse = (text) => { try { return JSON.parse(text); } catch { return text ?? null; } };
const pathKey = (p) => String(p ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const redact = redactor([[WS, "<test folder>"], [BASE, "<proof>"]]);

function engineVersion() {
  try {
    return execFileSync(join("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe"), ["--version"],
      { encoding: "utf8", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim();
  } catch { return null; }
}

function merge(result) {
  const record = readJson(OUT, {
    schema: "muse-desktop.m0-05-questions.v1",
    ticket: "M0-05",
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    phases: {},
  });
  record.commit = gitHead();
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.phases[KEY] = redact({ build: BUILD, commit: record.commit, ...result });
  record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  return record.phases[KEY];
}

// ---- app and engine processes ------------------------------------------------

const lines = (text) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
const ps = (command) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });

function appPids() {
  try { return lines(ps("Get-Process -Name muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }")).map(Number); } catch { return []; }
}
const alive = (pid) => {
  try { return lines(ps(`Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`)).length > 0; } catch { return false; }
};

/** Started the way a user does, from PowerShell, with the proof environment. */
function launchApp() {
  const pid = ps(`$env:MUSE_NO_AUTO_UPDATE='1'; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; (Start-Process -FilePath '${EXE}' -PassThru).Id`).trim();
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
 * The app's muse.exe children with their working directory, read from each
 * process's PEB (RTL_USER_PROCESS_PARAMETERS.CurrentDirectory): the bridge
 * spawns one engine per folder with that folder as its working directory, so
 * this is what tells the test conversation's engine from the user's.
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
ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(appPid)}" | Where-Object { $_.Name -eq 'muse.exe' } | ForEach-Object {
  @{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToString('o'); cwd = [M05Cwd]::Cwd([int]$_.ProcessId) } })
`;
  const list = JSON.parse(ps(script).trim() || "[]");
  return (Array.isArray(list) ? list : [list]).map((p) => ({ ...p, test: pathKey(p.cwd) === pathKey(WS) }));
}
/** Path-free view: the test engine in full, the others (the user's, other test folders) as a count. */
const enginesView = (list) => ({ test: list.filter((e) => e.test).map((e) => ({ pid: e.pid, created: e.created, cwd: "<test folder>" })),
  others: list.filter((e) => !e.test).length });

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
  const button = (label, root) => q('button', root).find((b) => (b.innerText || '').trim() === label) || null;
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const stored = (sid) => (store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === sid) || null;
  const cardKey = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    let f = k ? el[k] : null;
    while (f && f.key == null) f = f.return;
    return f ? f.key : null;
  };
  const cardNodes = () => q('section[aria-label="Pending input"] .approval');
  const cards = () => cardNodes().map((c) => ({
    key: cardKey(c),
    title: text(c.querySelector('strong')),
    questions: [...c.querySelectorAll('.input-question')].map((g) => ({
      header: text(g.querySelector('.muted')),
      question: g.getAttribute('aria-label'),
      choices: [...g.querySelectorAll('button')].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') === 'true' })),
      boxes: [...g.querySelectorAll('label.check')].map((l) => ({ label: text(l), checked: l.querySelector('input').checked })),
    })),
    actions: [...c.querySelectorAll(':scope > .approval-actions button')].map((b) => b.innerText.trim()),
  }));
  const banner = () => text(document.querySelector('.error-banner span'));
  const connection = () => text(document.querySelector('.task-metadata .connection-state'));
  const health = () => text(document.querySelector('.stream-health'));
  const reconnectButton = () => q('.top-actions button.workspace-button').find((b) => /^Reconnect/.test(b.innerText.trim())) || null;
  const view = () => ({ activeSid: activeSid(), cards: cards(), banner: banner(), connection: connection(), health: health(),
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

/** The question ids a list_pending_requests answer carries (read from its text: it may be cut). */
const inputIdsOf = (result) => [...String(result ?? "").matchAll(/"inputId":"([^"]+)"/g)].map((m) => m[1]);

/** The test conversation's resume, pending reads and answers since `fromMs` (trace clock), summarized. */
async function callsSince(app, sid, fromMs) {
  const calls = await app.ev(`window.__baselineIpc.calls.filter((c) => c.atMs >= ${fromMs} && c.args && c.args.sessionId === ${J(sid)}
    && ['resume_session', 'list_pending_requests', 'answer_input'].includes(c.cmd)).map((c) => ({ atMs: c.atMs, cmd: c.cmd, ok: c.ok, result: c.result }))`);
  return calls.map((c) => ({ ms: c.atMs - fromMs, cmd: c.cmd, ok: c.ok,
    ...(c.cmd === "resume_session" && c.ok ? { running: /"running":true/.test(c.result ?? "") } : {}),
    ...(c.cmd === "list_pending_requests" && c.ok ? { userInputIds: inputIdsOf(c.result) } : {}),
    ...(c.ok ? {} : { error: String(c.result ?? "").slice(0, 300) }) }));
}

/**
 * Renderer-side tap on poll_events, the path every bridge event takes to the
 * renderer: the test conversation's events with their payload, the others by
 * kind only (they are the user's).
 */
const INSTALL_POLL_TAP = (sid) => `(() => {
  const tap = window.__m05tap = window.__m05tap || { installed: false, t0: Date.now(), events: [], others: {} };
  tap.sid = ${J(sid)};
  if (tap.installed) return 'kept';
  tap.installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const response = await original(input, init);
    if (!/^https?:\\/\\/ipc\\.localhost\\/poll_events/.test(url) || response.headers.get('Tauri-Response') !== 'ok') return response;
    try {
      const body = await response.clone().json();
      for (const e of body.events || []) {
        if (e.session_id === tap.sid) tap.events.push({ atMs: Date.now() - tap.t0, kind: e.kind, payload: String(e.payload || '').slice(0, 600) });
        else tap.others[e.kind] = (tap.others[e.kind] || 0) + 1;
      }
    } catch { /* a poll the tap cannot read stays the app's */ }
    return response;
  };
  return 'installed';
})()`;
const tapEvents = (app, from = 0) => app.ev(`window.__m05tap ? window.__m05tap.events.slice(${from}) : []`);

/**
 * Forged input, used only when the model set no selection bound: the next
 * answer_input leaves the renderer with its labels replaced by one the question
 * does not offer, as no click in the card can produce it. One shot.
 */
const INSTALL_REWRITE = `(() => {
  const rw = window.__m05rewrite = { armed: true, original: null, sent: null };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!rw.armed || !/^https?:\\/\\/ipc\\.localhost\\/answer_input/.test(url) || typeof (init && init.body) !== 'string') return original(input, init);
    rw.armed = false;
    const body = JSON.parse(init.body);
    rw.original = JSON.parse(init.body).answers;
    body.answers = body.answers.map((a) => a.selectedLabels ? { questionId: a.questionId, selectedLabels: ['Not an option'] }
      : { questionId: a.questionId, selectedLabel: 'Not an option' });
    rw.sent = body.answers;
    return original(input, { ...init, body: JSON.stringify(body) });
  };
  return 'armed';
})()`;

/** A question as the bridge shapes it (live input_request or pending row), options by label. */
const normPrompt = (r) => r && ({ inputId: r.inputId ?? r.request_id, toolName: r.toolName,
  questions: (r.questions ?? []).map((x) => ({ id: x.id, header: x.header, question: x.question, mode: x.mode,
    minSelections: x.minSelections ?? null, maxSelections: x.maxSelections ?? null, options: (x.options ?? []).map((o) => o.label) })) });

/** What the engine lists as pending for `sid`, through the app's own read-only command. */
async function hostInputs(app, sid) {
  const res = await app.ev(`window.__TAURI_INTERNALS__.invoke('list_pending_requests', { sessionId: ${J(sid)} })
    .then((r) => r, (e) => ({ error: String(e).slice(0, 300) }))`);
  if (res?.error) return { error: res.error };
  return (res?.userInputs ?? []).map(normPrompt);
}

async function select(app, sid) {
  await app.ev(page(`const b = row(${J(sid)})?.querySelector('button.session-select'); if (b) b.click(); return !!b;`));
  await waitFor(() => app.ev(page(`return activeSid() === ${J(sid)};`)), 15_000, 300);
  await sleep(800);
}

/**
 * Refuse to act unless the folder's test conversation is listed, active and
 * runs in that folder: nothing this harness sends may reach a user conversation.
 */
async function guard(app) {
  const c = conversation();
  if (!c) throw new Error(`no test conversation in ${FOLDER}: run setup first`);
  if (!(await app.ev(page(`return Boolean(row(${J(c.sid)}));`)))) throw new Error("refusing: the test conversation is not in the sidebar");
  if ((await app.ev(page("return activeSid();"))) !== c.sid) await select(app, c.sid);
  const r = await app.ev(page(`const s = stored(${J(c.sid)}); return { active: activeSid(), workspace: s?.workspace ?? null };`));
  if (r.active !== c.sid) throw new Error("refusing: the active conversation is not the test conversation");
  if (pathKey(r.workspace) !== pathKey(WS)) throw new Error("refusing: the test conversation does not run in the test folder");
  return c;
}

/** A real mouse click at the centre of the element `find` returns (page-side expression). */
async function mouse(app, find) {
  const box = await app.ev(page(`
    const el = (() => { ${find} })();
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    await pause(150);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `));
  if (!box) return { clicked: false };
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(400);
  return { clicked: true };
}
const inCard = (sel, label, i) => `return [...(cardNodes()[${i}]?.querySelectorAll(${J(sel)}) ?? [])].find((n) => text(n) === ${J(label)}) || null;`;
const tick = (app, label, i = 0) => mouse(app, `const l = (() => { ${inCard(".input-question label.check", label, i)} })(); return l ? l.querySelector('input') : null;`);
const choose = (app, label, i = 0) => mouse(app, inCard(".input-question .approval-actions button", label, i));
const action = (app, label, i = 0) => mouse(app, `return [...(cardNodes()[${i}]?.querySelectorAll(':scope > .approval-actions button') ?? [])].find((b) => b.innerText.trim() === ${J(label)}) || null;`);

/** Persisted transcript of `sid` (role + text), flattened. */
const fullLog = (app, sid) => app.ev(page(`
  return (store('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ') }));
`));
/** The transcript from the last user entry carrying `prompt` onward. */
async function turnLog(app, sid, prompt) {
  const log = await fullLog(app, sid);
  const start = log.findLastIndex((e) => e.role === "user" && e.text.includes(prompt.slice(0, 40)));
  return (start >= 0 ? log.slice(start) : log.slice(-12)).map((e) => ({ role: e.role, text: e.text.slice(0, 300) }));
}
/** How many times the transcript says a question was raised. */
const inputLines = (entries) => entries.filter((e) => e.role === "tool" && e.text.startsWith("Input requested:")).length;
/**
 * What the model wrote after the question: a lead-in before it may list every
 * option. The answer's reply fills the placeholder opened when the answer is
 * sent, so it sits before the "Input answered" line.
 */
const reply = (entries) => {
  const asked = entries.findLastIndex((e) => e.role === "tool" && e.text.startsWith("Input requested:"));
  return entries.slice(asked + 1).filter((e) => e.role === "assistant").map((e) => e.text).join(" ").trim();
};
const sentLabels = (call) => (call?.args?.answers ?? []).flatMap((a) => a.selectedLabels ?? (a.selectedLabel ? [a.selectedLabel] : []));
/** The reply names every label sent and no other option of the question. */
const replyMatches = (text, call, options) => {
  const words = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const sent = sentLabels(call).map((l) => l.toUpperCase());
  return sent.length > 0 && sent.every((l) => words.includes(l))
    && options.map((o) => o.toUpperCase()).filter((l) => !sent.includes(l)).every((l) => !words.includes(l));
};

/** Send `prompt` through the composer and wait for the question's card. */
async function ask(app, sid, prompt) {
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
  if (!sent.sent) throw new Error(`prompt not sent: ${sent.reason}`);
  const call = await nextIpc(app, "send_input", sends, 30_000);
  const t0 = Date.now();
  const ui = await waitFor(async () => {
    const v = await app.ev(page("return view();"));
    return v.cards.length > 0 ? v : null;
  }, 240_000, 800);
  if (!ui) throw new Error(`no question card within the bound; transcript: ${J(await turnLog(app, sid, prompt))}`);
  const msToCard = Date.now() - t0;
  const host = await hostInputs(app, sid);
  const events = (await tapEvents(app)).filter((e) => e.kind === "input_request").map((e) => e.payload);
  const shown = ui.cards[0].key?.split(":")[1];
  return { sendInput: { ok: call?.ok ?? null }, msToCard, hostPending: host,
    hostPrompt: (Array.isArray(host) ? host.find((p) => p.inputId === shown) : null)
      ?? normPrompt(events.map(parse).find((p) => p?.inputId === shown)) ?? null,
    card: ui.cards[0], view: ui, inputRequestEvents: events.map((p) => p.slice(0, 400)) };
}

/** Wait until the turn is over: not running, no card, nothing in progress. */
async function untilIdle(app, sid, timeoutMs = 180_000) {
  const t0 = Date.now();
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { ...view(), running: running(${J(sid)}) };`));
    return s.running === "false" && s.cards.length === 0 && !/working|resuming|waiting|stopping|retrying/i.test(s.health ?? "") ? s : null;
  }, timeoutMs, 800);
  return { idle: Boolean(done), msToIdle: done ? Date.now() - t0 : null };
}

async function capture(app, clip, name) {
  if (!clip) return null;
  mkdirSync(SHOTS, { recursive: true });
  const shot = await app.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
  return `shots/${name}.png`;
}

/** The input card only: the sidebar shows the user's own titles. */
const shotCard = async (app, name) => capture(app, await app.ev(page(`
  const n = q('section[aria-label="Pending input"]')[0];
  if (!n) return null;
  n.scrollIntoView({ block: 'center' });
  await pause(200);
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
`)), name);

/** The last `height` pixels of the transcript, scrolled to its end. */
const shotTranscript = async (app, name, height = 420) => capture(app, await app.ev(page(`
  const s = document.querySelector('.stream');
  if (!s) return null;
  let box = s;
  while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
  if (box) box.scrollTop = box.scrollHeight;
  await pause(400);
  const r = s.getBoundingClientRect(), v = (box || s).getBoundingClientRect();
  const bottom = Math.min(r.bottom, v.bottom, window.innerHeight), top = Math.max(v.top, bottom - ${height});
  return { x: r.x, y: top, width: r.width, height: Math.max(1, bottom - top), scale: 1 };
`)), name);

// ---- phases ------------------------------------------------------------------------

async function launch() {
  const running = appPids();
  if (running.length > 0) throw new Error(`blocked: ${running.length} muse-desktop process(es) not started by this harness are running`);
  mkdirSync(BASE, { recursive: true });
  const pid = launchApp();
  const app = await attach();
  return { app, result: { started: true, pidRecorded: Boolean(pid) } };
}

/** The user's projects, selection, posture and isolation, read only. */
async function readUser(app) {
  const user = await app.ev(page(`return { projects: localStorage.getItem('muse-desktop.projects.v1'), active: localStorage.getItem('muse-desktop.active.v1'),
    posture: localStorage.getItem('muse-desktop.authorization-mode.v1'), sandbox: localStorage.getItem('muse-desktop.settings.v1') };`));
  const { parseAuthorizationMode } = await import("../src/lib/authorization.ts");
  const { hostSandboxConfigForProject, parseSandboxSettings } = await import("../src/lib/settings.ts");
  return { ...user, mode: parseAuthorizationMode(parse(user.posture)), isolation: hostSandboxConfigForProject(parseSandboxSettings(parse(user.sandbox))) };
}

async function setup(app) {
  if (conversation()) throw new Error(`${FOLDER} already holds a test conversation; run cleanup or pass another --folder`);
  mkdirSync(WS, { recursive: true });
  const user = await readUser(app);
  // The user's state is read once, before any test conversation: the later ones would see a test selection.
  if (!state().user) saveState({ user: { projects: user.projects, posture: user.posture, sandbox: user.sandbox }, originalActive: parse(user.active) });
  const before = engines(state().pid);
  const meta = await app.ev(`window.__TAURI_INTERNALS__.invoke('start_session', ${J({
    workspacePath: WS, authorizationMode: user.mode, sandboxMode: user.isolation.mode,
    sandboxDisableWrite: user.isolation.disableWrite, sandboxDisableShell: user.isolation.disableShell })})`);
  if (!meta?.session_id) throw new Error(`start_session failed: ${J(meta)}`);
  saveState({ conversations: [...(state().conversations ?? []), { folder: FOLDER, sid: meta.session_id }] });
  await app.ev("(setTimeout(() => location.reload(), 50), true)");
  await sleep(6_000);
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  await app.ev(INSTALL_IPC_TRACE);
  const adopted = await waitFor(() => app.ev(page(`return Boolean(row(${J(meta.session_id)}));`)), 60_000, 1_000);
  if (!adopted) throw new Error("the app did not adopt the test conversation after the reload");
  await select(app, meta.session_id);
  const after = engines(state().pid);
  const result = {
    user: { projectsSha: sha(user.projects), posture: user.mode, isolation: user.isolation },
    startSession: { approvalMode: meta.approval_mode ?? null, durability: meta.session_durability ?? null, sandboxMode: user.isolation.mode },
    engines: { before: enginesView(before), after: enginesView(after) },
    view: await app.ev(page("return view();")),
    logEntries: (await fullLog(app, meta.session_id)).length,
  };
  result.verdict = {
    adoptedAfterReload: Boolean(adopted),
    active: result.view.activeSid === meta.session_id,
    oneEngineInTestFolder: after.filter((e) => e.test).length === 1,
    noTurn: result.logEntries === 0,
  };
  return result;
}

async function death(app) {
  const s = await guard(app);
  const appPid = state().pid;
  await app.ev(INSTALL_POLL_TAP(s.sid));
  const asked = await ask(app, s.sid, PROMPTS.death);
  const result = { liveTurns: 1, ...asked };
  result.shotBefore = await shotCard(app, SHOT("death-card"));
  const list = engines(appPid);
  const victim = list.filter((e) => e.test);
  if (victim.length !== 1) throw new Error(`expected one engine in the test folder, found ${victim.length}`);
  const others = list.filter((e) => !e.test).map((e) => e.pid);
  result.before = { engines: enginesView(list), hostPending: await hostInputs(app, s.sid), view: await app.ev(page("return view();")) };
  const from = (await tapEvents(app)).length;
  const killAt = await app.ev("Date.now() - window.__baselineIpc.t0");
  execFileSync("taskkill", ["/F", "/PID", String(victim[0].pid)], { stdio: "ignore" });
  const t0 = Date.now();
  const exited = await waitFor(async () => (await tapEvents(app, from)).find((e) => e.kind === "host_exited") ?? null, 30_000, 300);
  const msToHostExited = exited ? Date.now() - t0 : null;
  await sleep(2_500);
  const log = await turnLog(app, s.sid, PROMPTS.death);
  result.after = {
    msToHostExited,
    hostExitedEvent: exited,
    testEvents: (await tapEvents(app, from)).map((e) => ({ kind: e.kind, payload: e.payload.slice(0, 200) })),
    otherSessionsEventKinds: await app.ev("window.__m05tap.others"),
    appAlive: alive(appPid),
    victimAlive: alive(victim[0].pid),
    otherEnginesAlive: others.filter((pid) => alive(pid)).length,
    otherEnginesBefore: others.length,
    view: await app.ev(page("return view();")),
    transcript: log,
    inputRequestedLines: inputLines(log),
  };
  result.shotAfter = await shotTranscript(app, SHOT("death-transcript"));
  const notice = log.some((e) => e.role === "system" && e.text === "Input cancelled: Muse stopped before you answered.");
  if (BUILD !== "fixed") {
    // The card left on screen: pick an answer and send it, as a user would.
    const n = (await ipc(app, "answer_input")).length;
    result.staleAnswer = { choose: await choose(app, "Banana"), send: await action(app, "Send answer") };
    result.staleAnswer.call = await nextIpc(app, "answer_input", n, 30_000);
    await sleep(1_000);
    result.staleAnswer.view = await app.ev(page("return view();"));
    result.staleAnswer.shot = await shotCard(app, SHOT("death-stale-answer"));
    result.callsSinceKill = await callsSince(app, s.sid, killAt);
    result.verdict = {
      testEngineKilled: !result.after.victimAlive && result.after.appAlive,
      otherEnginesUntouched: result.after.otherEnginesAlive === result.after.otherEnginesBefore,
      hostExitedOnlyForTheTestConversation: Boolean(exited) && !(result.after.otherSessionsEventKinds?.host_exited > 0),
      disconnected: result.after.view.connection === "Disconnected",
      cardStayedOnScreen: result.after.view.cards.length === 1,
      noCancelledNotice: !notice,
      staleAnswerFails: result.staleAnswer.call?.ok === false,
    };
    return result;
  }
  // Reconnect from the top bar, as the transcript says.
  const resumes = (await ipc(app, "resume_session")).length;
  result.reconnect = { click: await mouse(app, "return reconnectButton();") };
  const resumed = await nextIpc(app, "resume_session", resumes, 120_000);
  const connected = await waitFor(() => app.ev(page("return connection() === 'Connected' ? view() : null;")), 60_000, 500);
  await sleep(4_000);
  const meta = resumed?.ok ? parse(resumed.result) : null;
  const newEngines = engines(appPid);
  result.reconnect = {
    ...result.reconnect,
    resumeSession: { ok: resumed?.ok ?? null, running: meta?.running ?? null, loaded: meta?.loaded ?? null, error: resumed?.ok ? undefined : String(resumed?.result ?? "").slice(0, 300) },
    connection: connected?.connection ?? null,
    engines: enginesView(newEngines),
    newEngineIsAnotherProcess: newEngines.some((e) => e.test && e.pid !== victim[0].pid),
    hostPendingAfterResume: await hostInputs(app, s.sid),
    view: await app.ev(page("return view();")),
    eventsAfterResume: (await tapEvents(app, from)).filter((e) => e.kind !== "host_exited").map((e) => ({ kind: e.kind, payload: e.payload.slice(0, 200) })),
    transcript: await turnLog(app, s.sid, PROMPTS.death),
    callsSinceKill: await callsSince(app, s.sid, killAt),
  };
  result.shotReconnected = await shotTranscript(app, SHOT("death-reconnected"));
  result.verdict = {
    testEngineKilled: !result.after.victimAlive && result.after.appAlive,
    otherEnginesUntouched: result.after.otherEnginesAlive === result.after.otherEnginesBefore,
    hostExitedOnlyForTheTestConversation: Boolean(exited) && !(result.after.otherSessionsEventKinds?.host_exited > 0),
    cardRemoved: result.after.view.cards.length === 0,
    transcriptSaysInputCancelled: notice,
    disconnected: result.after.view.connection === "Disconnected",
    reconnectWorks: result.reconnect.resumeSession.ok === true && result.reconnect.connection === "Connected" && result.reconnect.newEngineIsAnotherProcess,
    noCardAfterReconnect: result.reconnect.view.cards.length === 0,
    engineStillListsTheDeadQuestion: Array.isArray(result.reconnect.hostPendingAfterResume)
      && result.reconnect.hostPendingAfterResume.some((p) => p.inputId === asked.hostPrompt?.inputId),
    oneTranscriptLinePerQuestion: inputLines(result.reconnect.transcript) === 1,
  };
  return result;
}

async function orphan(app) {
  const s = await guard(app);
  const connected = await waitFor(() => app.ev(page("return connection() === 'Connected' ? view() : null;")), 90_000, 500);
  await sleep(3_000);
  const result = { liveTurns: 0, connected: Boolean(connected), view: await app.ev(page("return view();")),
    appPendingRead: await hostInputs(app, s.sid), engines: enginesView(engines(state().pid)),
    transcriptTail: (await fullLog(app, s.sid)).slice(-6).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })) };
  const label = result.view.cards[0]?.questions[0]?.choices[0]?.label;
  if (label) {
    const n = (await ipc(app, "answer_input")).length;
    result.answer = { choose: await choose(app, label), send: await action(app, "Send answer") };
    result.answer.call = await nextIpc(app, "answer_input", n, 30_000);
    await sleep(1_000);
    result.answer.view = await app.ev(page("return view();"));
    result.shot = await shotCard(app, SHOT("orphan"));
  }
  result.verdict = BUILD === "fixed"
    ? { resumedOnANewEngine: result.connected && result.engines.test.length === 1, noCardForTheKilledPrompt: result.view.cards.length === 0 }
    : { resumedOnANewEngine: result.connected && result.engines.test.length === 1, cardForTheKilledPrompt: result.view.cards.length === 1,
      answerRefused: result.answer?.call?.ok === false };
  return result;
}

/** The folder of `sid` in the engine's session store (~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<sid>). */
function sessionDir(store, sid) {
  for (const y of readdirSync(store).filter((n) => /^\d{4}$/.test(n))) {
    for (const m of readdirSync(join(store, y))) {
      for (const d of readdirSync(join(store, y, m))) if (existsSync(join(store, y, m, d, sid))) return join(store, y, m, d, sid);
    }
  }
  throw new Error("the conversation's session log was not found");
}

async function stuck(app) {
  const s = await guard(app);
  const tap = await app.ev("window.__m05tap ? { t0: window.__m05tap.t0, sid: window.__m05tap.sid, events: window.__m05tap.events.map((e) => e.kind) } : null");
  if (!tap || tap.sid !== s.sid) throw new Error("no poll tap for this conversation in the page: run stuck in the instance that sent the turn");
  const store = join(homedir(), ".local", "share", "muse", "sessions");
  const records = readFileSync(join(sessionDir(store, s.sid), "session.jsonl"), "utf8").split("\n").filter(Boolean).map(parse).filter((r) => r && typeof r === "object");
  const started = records.filter((r) => r.payload?.kind === "run" && r.payload.event?.kind === "started").at(-1);
  const run = records.filter((r) => r.payload?.run_id === started?.payload.run_id);
  const at = (r) => new Date(Math.floor(r.recorded_at / 1000)).toISOString();
  const events = (kind) => run.filter((r) => r.payload.event?.kind === kind);
  const viewDir = join(store, ".msp-view-v1", s.sid);
  const viewWrites = Object.fromEntries(readdirSync(viewDir).filter((f) => /^(HEAD\.json|journal-|index-)/.test(f))
    .map((f) => [f.replace(/-\d+(?=\.bin$)/, ""), statSync(join(viewDir, f)).mtime.toISOString()]));
  const result = {
    liveTurns: 0,
    engineRecord: {
      runStartedAt: started ? at(started) : null,
      toolCallsRejected: events("rejected").map((r) => r.payload.event.reason),
      assistantMessages: events("assistant_message_committed").map((r) => r.payload.event.text),
      terminal: events("terminal").map((r) => ({ terminal: r.payload.event.terminal, turnDurationMs: r.payload.event.turn_duration_ms, at: at(r) })),
    },
    engineViewLastWrites: viewWrites,
    app: { tapInstalledAt: new Date(tap.t0).toISOString(), eventsForTheConversation: tap.events,
      view: await app.ev(page(`return { ...view(), running: running(${J(s.sid)}) };`)) },
  };
  result.verdict = {
    tapInstalledBeforeTheTurn: Boolean(started) && tap.t0 < Math.floor(started.recorded_at / 1000),
    engineCompletedTheTurn: result.engineRecord.terminal.some((t) => t.terminal === "completed"),
    modelRepliedInTheEngine: result.engineRecord.assistantMessages.length > 0,
    noEventReachedTheApp: tap.events.length === 0,
    appStillShowsTheTurnRunning: result.app.view.running === "true",
    engineViewNotWrittenSinceBeforeTheTurn: Boolean(started) && Object.values(viewWrites).every((w) => w < result.engineRecord.runStartedAt),
  };
  return result;
}

async function answer(app) {
  const s = await guard(app);
  await app.ev(INSTALL_POLL_TAP(s.sid));
  const result = { liveTurns: 1, atStart: { view: await app.ev(page("return view();")), hostPending: await hostInputs(app, s.sid) } };
  const asked = await ask(app, s.sid, PROMPTS.answer);
  Object.assign(result, asked);
  const q0 = asked.hostPrompt.questions[0];
  const natural = q0.mode === "multiple" && (q0.minSelections ?? 1) >= 2;
  result.path = natural ? "host bound: one box out of min_selections 2" : "forged: first answer rewritten in transit";
  const [one, two] = [q0.options[1], q0.options[2]];
  const pick = async (label) => (q0.mode === "multiple" ? tick(app, label) : choose(app, label));

  // (3) One box: the host refuses it. The card's DOM node is tagged: the same node after the refusal was never rebuilt.
  await app.ev(page("cardNodes()[0].dataset.m05 = 'before-refusal'; return true;"));
  if (!natural) await app.ev(INSTALL_REWRITE);
  result.refused = { pick: await pick(one) };
  const n0 = (await ipc(app, "answer_input")).length;
  result.refused.send = await action(app, "Send answer");
  result.refused.call = await nextIpc(app, "answer_input", n0, 30_000);
  await sleep(1_500);
  result.refused.rewrite = natural ? null : await app.ev("window.__m05rewrite");
  result.refused.after = { view: await app.ev(page("return view();")), sameCardNode: await app.ev(page("return cardNodes()[0]?.dataset.m05 === 'before-refusal';")),
    hostPending: await hostInputs(app, s.sid) };
  result.shotRefused = await shotCard(app, SHOT("refused-keeps-answer"));

  // (2) The page reloaded with the question pending, traced and tapped from its first script.
  await app.send("Page.enable");
  const { identifier } = await app.send("Page.addScriptToEvaluateOnNewDocument", { source: `${INSTALL_IPC_TRACE};\n${INSTALL_POLL_TAP(s.sid)};` });
  await app.send("Page.reload", { ignoreCache: false });
  const t0 = Date.now();
  await sleep(2_000);
  await app.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  const back = await waitFor(async () => {
    const ui = await app.ev(page("return view();"));
    return ui.activeSid === s.sid && ui.cards.length > 0 ? ui : null;
  }, 30_000, 500);
  const boot = (await ipc(app, "list_pending_requests")).filter((c) => c.args?.sessionId === s.sid);
  result.reloaded = {
    msToCard: back ? Date.now() - t0 : null,
    card: back?.cards[0] ?? null,
    bootListPending: boot.map((c) => ({ ok: c.ok, userInputIds: inputIdsOf(c.result) })),
    inputRequestEventsSinceReload: (await tapEvents(app)).filter((e) => e.kind === "input_request").length,
  };
  result.shotReloaded = await shotCard(app, SHOT("reload-card-back"));

  // (1) A valid answer: the turn goes on with it.
  const labels = natural ? [one, two] : [one];
  result.accepted = { picks: [] };
  for (const label of labels) result.accepted.picks.push(await pick(label));
  result.accepted.before = (await app.ev(page("return view();"))).cards[0] ?? null;
  const n1 = (await ipc(app, "answer_input")).length;
  result.accepted.send = await action(app, "Send answer");
  result.accepted.call = await nextIpc(app, "answer_input", n1, 30_000);
  result.end = await untilIdle(app, s.sid);
  result.events = (await tapEvents(app)).filter((e) => /^input_/.test(e.kind)).map((e) => ({ kind: e.kind, payload: e.payload.slice(0, 300) }));
  result.transcript = await turnLog(app, s.sid, PROMPTS.answer);
  result.reply = reply(result.transcript);
  result.shotEnd = await shotTranscript(app, SHOT("answered-transcript"));

  const box = (card, label) => card?.questions?.[0]?.boxes?.find((b) => b.label === label)?.checked ?? null;
  result.verdict = {
    q1_questionCardRendered: asked.card.questions.length === 1 && asked.card.actions.includes("Send answer"),
    q1_oneTranscriptLinePerQuestion: inputLines(result.transcript) === 1,
    q3_firstAnswerRefused32057: result.refused.call?.ok === false && /-32057/.test(result.refused.call.result ?? ""),
    q3_refusalShownToUser: /could not be submitted/i.test(result.refused.after.view.banner ?? ""),
    q3_cardKeptSameNode: result.refused.after.sameCardNode === true,
    q3_cardKeptTheEditedAnswer: natural ? box(result.refused.after.view.cards[0], one) === true
      : result.refused.after.view.cards[0]?.questions?.[0]?.choices?.some((c) => c.pressed) === true,
    q3_hostStillPendingAfterRefusal: Array.isArray(result.refused.after.hostPending) && result.refused.after.hostPending.length === 1,
    q2_cardBackWithoutAction: Boolean(back),
    q2_sameQuestion: Boolean(back) && back.cards[0].key === `${s.sid}:${asked.hostPrompt.inputId}`,
    q2_onlyTheLiveQuestion: Boolean(back) && back.cards.length === 1,
    q2_cardFromHostPendingList: result.reloaded.bootListPending.some((c) => c.ok && c.userInputIds.includes(asked.hostPrompt.inputId)),
    q2_noReplayedEvent: result.reloaded.inputRequestEventsSinceReload === 0,
    q1_answerAccepted: result.accepted.call?.ok === true && sentLabels(result.accepted.call).length === labels.length,
    q1_settledAnswered: result.events.some((e) => e.kind === "input_settled" && /"outcome":"answered"/.test(e.payload)),
    q1_turnContinuedWithTheAnswer: result.end.idle && replyMatches(result.reply, result.accepted.call, q0.options),
  };
  return result;
}

/**
 * No new turn. The running turn's question (the newest the engine lists, by
 * its card) answered with valid picks, then the turn's end: do the engine's
 * events still reach the app after an answer it refused earlier?
 */
async function finish(app) {
  const s = await guard(app);
  await app.ev(INSTALL_POLL_TAP(s.sid));
  const from = (await tapEvents(app)).length;
  const pending = await hostInputs(app, s.sid);
  const live = Array.isArray(pending) ? pending.at(-1) : null;
  const before = await app.ev(page("return view();"));
  const i = before.cards.findIndex((c) => c.key === `${s.sid}:${live?.inputId}`);
  if (!live || i < 0) throw new Error("no card for the running turn's question");
  const q0 = live.questions[0];
  const labels = q0.mode === "multiple" ? q0.options.slice(0, Math.max(1, q0.minSelections ?? 1)) : [q0.options[0]];
  const result = { liveTurns: 0, question: live, cardsBefore: before.cards.map((c) => c.key), picks: [] };
  for (const label of labels) result.picks.push(await (q0.mode === "multiple" ? tick(app, label, i) : choose(app, label, i)));
  const n = (await ipc(app, "answer_input")).length;
  result.send = await action(app, "Send answer", i);
  result.call = await nextIpc(app, "answer_input", n, 30_000);
  // Not running any more is the end here: a card of a dead turn may stay on screen.
  const t0 = Date.now();
  const ended = await waitFor(async () => ((await app.ev(page(`return running(${J(s.sid)});`))) === "false" ? true : null), 120_000, 800);
  result.end = { idle: Boolean(ended), msToEnd: ended ? Date.now() - t0 : null };
  result.eventsAfterAnswer = (await tapEvents(app, from)).map((e) => e.kind);
  result.view = await app.ev(page("return view();"));
  const log = await fullLog(app, s.sid);
  result.transcriptTail = log.slice(-5).map((e) => ({ role: e.role, text: e.text.slice(0, 200) }));
  const words = log.filter((e) => e.role === "assistant").map((e) => e.text).join(" ").toUpperCase().match(/[A-Z]+/g) ?? [];
  result.verdict = {
    answerAccepted: result.call?.ok === true,
    eventsReachedTheApp: result.eventsAfterAnswer.length > 0,
    turnEnded: result.end.idle,
    replyCarriesTheAnswer: labels.every((l) => words.includes(l.toUpperCase())),
  };
  return result;
}

async function cleanup(app) {
  const s = state();
  const result = { conversations: [] };
  for (const c of s.conversations ?? []) {
    result.conversations.push({ folder: c.folder, ...(await app.ev(page(`
      const actions = row(${J(c.sid)})?.querySelector("button[aria-label^='Actions for']");
      if (!actions) return { deleted: false, reason: 'no row' };
      actions.click();
      await pause(500);
      button('Delete…', document.querySelector('dialog[open]'))?.click();
      await pause(400);
      const confirm = button('Delete conversation', document.querySelector('dialog[open]'));
      confirm?.click();
      await pause(1200);
      return { deleted: !row(${J(c.sid)}), confirmed: Boolean(confirm) };
    `))) });
  }
  if (s.originalActive) {
    result.originalSelection = await app.ev(page(`const b = row(${J(s.originalActive)})?.querySelector('button.session-select'); if (b) b.click(); await pause(800); return Boolean(b);`));
  }
  const now = await app.ev(page(`return { projects: localStorage.getItem('muse-desktop.projects.v1'), posture: localStorage.getItem('muse-desktop.authorization-mode.v1'),
    sandbox: localStorage.getItem('muse-desktop.settings.v1') };`));
  result.user = { projectsUnchanged: now.projects === s.user?.projects, postureUnchanged: now.posture === s.user?.posture, isolationUnchanged: now.sandbox === s.user?.sandbox };
  result.close = await closeApp(app);
  const deleted = result.conversations.length > 0 && result.conversations.every((c) => c.deleted === true);
  result.verdict = { conversationsDeleted: deleted, ...result.user, closedGracefully: result.close.graceful };
  if (deleted) saveState({ conversations: [], deleted: s.conversations });
  return result;
}

// ---- main ---------------------------------------------------------------------------

const PHASES = { setup, death, orphan, stuck, answer, finish, cleanup };
if (PHASE === "rederive") {
  // The stored answer turn read again with the current reply reading: no app, no turn.
  const record = readJson(OUT, null);
  const p = record?.phases?.[["answer", FOLDER === "ws" ? null : FOLDER].filter(Boolean).join("-")];
  if (!p?.transcript || !p.accepted?.call) throw new Error("no stored answer turn for this folder");
  p.reply = reply(p.transcript);
  p.verdict.q1_turnContinuedWithTheAnswer = p.end.idle && replyMatches(p.reply, p.accepted.call, p.hostPrompt.questions[0].options);
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}
`);
  process.stdout.write(`${JSON.stringify({ reply: p.reply, q1_turnContinuedWithTheAnswer: p.verdict.q1_turnContinuedWithTheAnswer })}
`);
  process.exit(0);
}
if (PHASE === "stop") {
  process.stdout.write(`${JSON.stringify(await closeApp(null))}\n`);
  process.exit(0);
}
if (PHASE !== "launch" && !PHASES[PHASE]) {
  process.stderr.write("usage: cdp-m0-05-questions.mjs <launch|setup|death|orphan|stuck|answer|finish|cleanup|stop|rederive> [--folder ws] [--build fixed|head|pre-fix] [--base dir] [--exe path] [--out file]\n");
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
    result = await PHASES[PHASE](app);
  }
  if (PHASE !== "cleanup" && app) {
    result.consoleErrors = app.errors.slice(0, 20);
    // The frontend bundle's hashed name tells the builds apart.
    result.bundle = await app.ev("[...document.scripts].map((s) => s.src.split('/').pop()).filter(Boolean)");
  }
  const written = merge(result);
  process.stdout.write(`${JSON.stringify(written.verdict ?? written, null, 2)}\n`);
} catch (error) {
  merge({ failure: String(error?.message ?? error).slice(0, 600), consoleErrors: app?.errors.slice(0, 20) ?? [] });
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  app?.close();
}
