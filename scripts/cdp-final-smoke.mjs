#!/usr/bin/env node

/**
 * Final Windows smoke on the merged build, the last check before the Windows
 * roadmap closes (06/10/2026). One isolated instance (test mode, ADR 0003),
 * the native Muse 1.4.2 engine as every local engine, two live turns at most.
 *
 *   1 readonly  M0-13 gap 2: a project whose Isolation preference is Read only,
 *               a conversation in it, one live turn asking the model to write a
 *               file. The screen must end on the turn's reply or the host's
 *               refusal, not on "Muse thinking…"; no file; Run in Muse disabled
 *               with its reason; the posture note shown.
 *   2 restart   a project that follows Settings, Isolation "Workspace and
 *               network", Ask posture: its engine argv carries
 *               --sandbox-network enabled. A window reload, then Settings'
 *               "Restart workspace host" on its folder (the old host must stop
 *               cleanly: session_end in its journal), the conversation's
 *               Reconnect, then one live turn whose PowerShell command asks for
 *               approval: the card shows the host's choices, Allow once, the
 *               turn ends and its events reach the screen.
 *   3 close     the window's own Close button: the app exits, and no process of
 *               this instance (engines, WebView2, shells) is left.
 *
 * Usage, from the repo root:
 *   node scripts/cdp-final-smoke.mjs --exe G:\muse-proofs\smoke\bin\muse-desktop-<commit>.exe
 *     --build-commit <commit> [--base G:\muse-proofs\smoke] [--rehearse] [--out <record>]
 *     [--before-fix <a rehearsal record of the build before a fix>] [--only readOnly|restart]
 * --rehearse refuses send_input in the page: the whole run without a model
 * turn, its record under --base. --only runs one of checks 1 and 2 (the
 * close always runs). CDP on MUSE_CDP_PORT, 9333 by default. The harness
 * starts its own instance and never attaches to an app it did not start.
 *
 * Run on 06/10/2026: a rehearsal on 7bda042 found the restart defect fixed in
 * 933ead3 (its record passed as --before-fix), then a rehearsal and the run
 * with the two live turns on 933ead3 (final-smoke-windows.json), whose Allow
 * once met a retryable -32603 fixed in c764d21; check 2 alone again on
 * c764d21 (final-smoke-windows-check2-rerun.json), one live turn.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

process.env.MUSE_CDP_PORT ??= "9333";
const { INSTALL_IPC_TRACE, PORT, argValue, openPage, redactor, sleep, under, waitFor, webviewProfile } = await import("./cdp-harness.mjs");

const J = JSON.stringify;
const REPO = resolve(".");
const EXE = argValue("--exe", null) && resolve(argValue("--exe", null));
const BUILD_COMMIT = argValue("--build-commit", null);
if (!EXE || !BUILD_COMMIT) {
  process.stderr.write("pass --exe <copy of the debug build> and --build-commit <the commit it was built from>\n");
  process.exit(2);
}
const SIDECAR = resolve("src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
const ENGINE_IMAGE = basename(SIDECAR);
const BASE = resolve(argValue("--base", "G:\\muse-proofs\\smoke"));
const REHEARSE = process.argv.includes("--rehearse");
// readOnly (check 1), restart (check 2); the close (check 3) always runs.
const ONLY = new Set(argValue("--only", "readOnly,restart").split(","));
const ID = Date.now().toString(36);
const DATA = join(BASE, `appdata-${ID}`);
const RO_DIR = join(BASE, `readonly-${ID}`);
const ASK_DIR = join(BASE, `ask-${ID}`);
const OUT = argValue("--out", REHEARSE ? join(BASE, `rehearsal-${ID}.json`) : "docs/evidence/2026-10-05-roadmap-closure/final-smoke-windows.json");
const RO_NAME = `smoke read-only ${ID}`;
const ASK_NAME = `smoke ask ${ID}`;
const FILE = "smoke-readonly.txt";
const MARKER = `READONLY-${randomBytes(3).toString("hex").toUpperCase()}`;
const PROMPT_WRITE = `Use your file-writing tool to create the file ${FILE} in the current folder with exactly this one line: ${MARKER}. If the write is refused, do not try another way: reply with the refusal you received, in one sentence.`;
const PROMPT_SHELL = "Use your PowerShell tool to run EXACTLY this command, unchanged, once: $m = 'smoke'; Set-Content -Path (Join-Path (Get-Location) 'probe.txt') -Value $m";
const RO_NOTE = "This project is Read only: Muse cannot write files or run commands here.";

// ---- processes -------------------------------------------------------------------

const ps = (command) => execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}; exit 0`], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Every process with its start time: a pid alone can be given to another process later. */
function processTable() {
  return ps("Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CreationDate.ToString('o') }")
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, name, created] = line.split("|");
      return { pid: Number(pid), ppid: Number(ppid), name, created };
    });
}
/** The app and every process under it. */
function tree(root) {
  const table = processTable();
  const out = table.filter((p) => p.pid === root);
  for (let i = 0; i < out.length; i++) out.push(...table.filter((p) => p.ppid === out[i].pid && !out.includes(p)));
  return out;
}
const countByName = (list) => list.reduce((acc, p) => ({ ...acc, [p.name]: (acc[p.name] ?? 0) + 1 }), {});

let appPid = null;
/** The app's engines (its children with the engine's image) and their argv. */
function engines(parent = appPid) {
  return ps(`Get-CimInstance Win32_Process -Filter "Name='${ENGINE_IMAGE}'" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }`)
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, ...cmd] = line.split("|");
      return { pid: Number(pid), ppid: Number(ppid), cmd: cmd.join("|") };
    }).filter((p) => p.ppid === parent);
}
/** An engine's flags after its exe path, as the OS runs it. */
const flagsOf = (engine) => engine.cmd.slice(engine.cmd.indexOf(ENGINE_IMAGE) + ENGINE_IMAGE.length).replace(/^"?\s*/, "");
const engineFacts = (list) => list.map((e) => ({ pid: e.pid, argv: flagsOf(e) }));

/**
 * The engine's own store for one conversation (read only; test mode does not
 * isolate it, ADR 0003): its MSP view's status, whether the record the view
 * names is in the journal, and the journal's last record kinds. A host stopped
 * cleanly ends the conversation with session_end; a killed one does not
 * (m0-13-msp-host-stop-1.4.2.json).
 */
function engineView(sid, from = null) {
  if (!sid) return null;
  const root = join(homedir(), ".local", "share", "muse", "sessions");
  const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  let head = null;
  try { head = JSON.parse(readFileSync(join(root, ".msp-view-v1", sid, "HEAD.json"), "utf8")); } catch { /* no view */ }
  const journal = list(root).flatMap((y) => list(join(root, y)).flatMap((m) => list(join(root, y, m)).map((d) => join(root, y, m, d, sid, "session.jsonl")))).find((file) => existsSync(file));
  const records = journal ? readFileSync(journal, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const kind = (r) => r.payload?.kind ?? r.retained_frame ?? null;
  return {
    viewStatus: head?.status ?? null,
    viewRecordStillInJournal: head ? records.some((r) => r.id === head.source_through?.id) : null,
    records: records.length,
    lastRecords: records.slice(-4).map(kind),
    ...(from === null ? {} : { since: records.slice(from).map(kind).filter(Boolean) }),
  };
}

// ---- isolated app lifecycle (ADR 0003, as scripts/cdp-m0-13-click-effect.mjs) -----

const forceKill = (pid) => { try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ } };
function abort(message) {
  forceKill(appPid);
  appPid = null;
  throw new Error(message);
}

/** Renderer-side tap on poll_events: every bridge event the screen receives, by conversation. */
const POLL_TAP = `(() => {
  const tap = window.__smokeTap = window.__smokeTap || { installed: false, t0: Date.now(), events: [] };
  if (tap.installed) return 'kept';
  tap.installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const response = await original(input, init);
    if (!/^https?:\\/\\/ipc\\.localhost\\/poll_events/.test(url) || response.headers.get('Tauri-Response') !== 'ok') return response;
    try {
      const body = await response.clone().json();
      for (const e of body.events || []) tap.events.push({ atMs: Date.now() - tap.t0, sid: e.session_id, kind: e.kind, payload: String(e.payload || '').slice(0, 600) });
    } catch { /* a poll the tap cannot read stays the app's */ }
    return response;
  };
  return 'installed';
})()`;
const BLOCK = REHEARSE ? "(window.__baselineIpc.block = ['send_input'], true)" : "true";

/**
 * Started from PowerShell: no WEBVIEW2_* variable, a fresh data folder, the
 * local engine pinned, CDP through the WebView2 options, MUSE_NO_AUTO_UPDATE.
 * Refused unless the app proves test mode and its browser runs on the test profile.
 */
async function launch(report) {
  if (!readFileSync(EXE).includes("MUSE_DESKTOP_TEST_DATA_DIR")) throw new Error("the exe has no test mode (release build?): refusing to start it");
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(() => true, (error) => error?.name === "TimeoutError")) {
    throw new Error(`CDP port ${PORT} is already taken: refusing to drive another app`);
  }
  if (existsSync(DATA)) throw new Error("the data folder exists: every run takes a fresh one");
  mkdirSync(DATA, { recursive: true });
  appPid = Number(ps([
    "Get-ChildItem env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }",
    `$env:MUSE_DESKTOP_TEST_DATA_DIR = '${DATA}'`,
    `$env:MUSE_DESKTOP_TEST_SIDECAR = '${J([SIDECAR.replaceAll("\\", "/")])}'`,
    `$env:MUSE_DESKTOP_TEST_CDP_PORT = '${PORT}'`,
    "$env:MUSE_NO_AUTO_UPDATE = '1'",
    `(Start-Process -FilePath '${EXE}' -WorkingDirectory '${BASE}' -PassThru).Id`,
  ].join("; ")));
  const entered = await waitFor(() => { try { return readFileSync(join(DATA, "test-mode.pid"), "utf8").trim() === String(appPid); } catch { return false; } }, 10_000, 100);
  if (!entered) abort("no test-mode.pid with the app's pid within 10 s: not in test mode, stopped");
  const app = await waitFor(async () => { try { return await openPage(); } catch { return null; } }, 120_000, 1_000);
  if (!app) abort("the app page never reached CDP");
  report.isolation = { testModeMarker: true, webviewProfileUnderTestFolder: under(webviewProfile(), DATA), cdpPort: PORT };
  if (!report.isolation.webviewProfileUnderTestFolder) {
    app.close();
    abort("the WebView2 browser is not on the test profile: stopped before driving the app");
  }
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(BLOCK);
  return app;
}

// ---- page side ---------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const text = (n) => (n ? (n.innerText || '').replace(/\\s+/g, ' ').trim() : null);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label, root) => q('button', root).find((b) => text(b) === label || b.getAttribute('aria-label') === label) || null;
  const click = (label, root) => { const b = button(label, root); if (b && !b.disabled) { b.click(); return true; } return false; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (probe, ms = 5000) => { for (let t = 0; t < ms; t += 100) { const v = probe(); if (v) return v; await wait(100); } return probe(); };
  const json = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return localStorage.getItem(key); } };
  const banner = () => text(document.querySelector('.error-banner'));
  const row = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const running = (sid) => row(sid)?.querySelector('.dot')?.getAttribute('data-running') ?? null;
  const cards = () => q('section[aria-label="Conversation authorization"] .approval').map((g) => ({
    title: text(g.querySelector('.approval-title-row strong')),
    command: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 300) || null,
    buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()),
  }));
  const inputs = () => q('section[aria-label="Pending input"] .approval').length;
  const health = () => text(document.querySelector('.stream-health'));
  const connection = () => text(document.querySelector('.task-metadata .connection-state'));
  const projectRow = (name) => q('li.project-item').find((li) => text(li.querySelector('summary .project-name')) === name) || null;
  const openSettings = () => { const b = document.querySelector('button.account[aria-label="Settings"]'); if (b) b.click(); return !!b; };
  // body: the row without its role label and footer (time, copy): a placeholder reads "thinking…".
  const rows = () => q('.msg').map((n) => ({
    lane: [...n.classList].find((c) => c !== 'msg' && c !== 'is-live') || null,
    failedMarker: text(n.querySelector('.tool-failed')),
    text: text(n).slice(0, 400),
    body: [...n.children].filter((c) => !c.matches('.role, .msg-footer')).map((c) => c.innerText || '').join(' ').replace(/\\s+/g, ' ').trim().slice(0, 400),
  }));
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, ${J(args)})
  .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }))`);
const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${J(cmd)}).map((c) => ({ ok: c.ok, args: c.args, result: (c.result || '').slice(0, 1500) }))`);
const resetTrace = (app) => app.ev("(window.__baselineIpc.calls = [], true)");
/** The first completed call to `cmd` after `before` calls. */
const nextIpc = (app, cmd, before, timeoutMs = 60_000) => waitFor(async () => {
  const calls = await ipc(app, cmd);
  return calls.length > before && calls[before].ok !== undefined ? calls[before] : null;
}, timeoutMs, 300);
const storedLog = (app, sid) => app.ev(page(`return (json('muse-desktop.log.v1.' + ${J(sid)}, '[]') || []).map((e) => ({ role: e.role, text: String(e.text || '').replace(/\\s+/g, ' ').slice(0, 300), failed: e.failed === true, open: e.open === true }));`));

/** Real mouse input through CDP on the element `find` returns (page-side), scrolled into view. */
async function mouse(app, find) {
  const box = await app.ev(page(`
    const el = (() => { ${find} })();
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    await wait(150);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `));
  if (!box) return { clicked: false };
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return { clicked: true };
}

async function openConversation(app, sid) {
  const opened = await app.ev(page(`
    const r = row(${J(sid)});
    if (!r) return 'no row';
    const group = r.closest('details');
    if (group && !group.open) group.querySelector('summary').click();
    await wait(200);
    r.querySelector('button.session-select').click();
    return (await until(() => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${J(sid)}, 10000)) ? 'open' : 'not active';
  `));
  if (opened !== "open") throw new Error(`conversation ${sid}: ${opened}`);
  await sleep(600);
}

/** What the screen says about the active conversation. */
const conversationView = (app) => app.ev(page(`
  const main = document.querySelector('main.conversation');
  const note = main && main.querySelector('.posture-note');
  return {
    connection: connection(),
    postureNote: note ? { text: text(note).replace(/\\s*Restart host$/, ''), role: note.getAttribute('role') } : null,
    composer: text(document.querySelector('.composer-wrap')),
    reconnectButton: Boolean(q('.top-actions button.workspace-button').find((b) => /^Reconnect/.test(text(b)))),
    health: health(),
    banner: banner(),
  };
`));

// ---- steps -----------------------------------------------------------------------

/** Settings > Isolation, picked like a user does (picking a level grants it). */
async function setIsolation(app, label) {
  await app.ev(page("return openSettings();"));
  await sleep(1_200);
  return app.ev(page(`
    const l = q('[role="radiogroup"][aria-label="Isolation"] label').find((x) => text(x.querySelector('strong')) === ${J(label)});
    if (!l) return { clicked: false };
    l.querySelector('input').click();
    await wait(600);
    const group = q('.settings-group').find((g) => text(g.querySelector('h3')) === 'Isolation');
    return { clicked: true, stored: json('muse-desktop.settings.v1', 'null'), current: text(group && group.querySelector('.authorization-status')) };
  `));
}

/** Projects: name, folder (the OS dialog answered by the harness), + Add project, then its Isolation preference. */
async function createProject(app, name, dir, isolation) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${J([dir])}), true)`);
  return app.ev(page(`
    const manage = q('button.sidebar-manage').find((b) => /Manage projects/.test(text(b)));
    if (!manage) return { error: 'no Manage projects' };
    manage.click();
    const panel = await until(() => q('.projects-panel')[0]);
    if (!panel) return { error: 'no projects panel' };
    setValue(panel.querySelector('input[aria-label="Project name"]'), ${J(name)});
    await wait(200);
    click('Choose project folders', panel);
    await until(() => /1 folder selected/.test(text(panel.querySelector('.project-workspace-picker')) || ''));
    click('+ Add project', panel);
    const li = await until(() => projectRow(${J(name)}));
    if (!li) return { error: 'project row not shown' };
    const details = li.querySelector('details');
    if (!details.open) details.querySelector('summary').click();
    await wait(400);
    if (${J(isolation)}) {
      const select = await until(() => li.querySelector('select[aria-label="Project isolation"]'));
      if (!select) return { error: 'no Project isolation select' };
      setValue(select, ${J(isolation)});
      await wait(500);
    }
    const stored = (json('muse-desktop.projects.v1', '[]') || []).find((p) => p.name === ${J(name)});
    return {
      stored: stored ? { settings: stored.settings ?? {} } : null,
      preferences: [...li.querySelectorAll('.project-settings label.project-setting')].map((l) => {
        const s = l.querySelector('select');
        return s ? { label: text(l.querySelector('span')), selected: s.selectedOptions[0] ? s.selectedOptions[0].text : null } : null;
      }).filter(Boolean),
    };
  `));
}

/** The project row's "New conversation here": a conversation with no message, and the engine it starts. */
async function startHere(app, name) {
  await resetTrace(app);
  const before = new Set(engines().map((e) => e.pid));
  const clicked = await app.ev(page(`
    const manage = q('button.sidebar-manage').find((b) => /Manage projects/.test(text(b)));
    if (!q('.projects-panel')[0] && manage) manage.click();
    const li = await until(() => projectRow(${J(name)}));
    if (!li) return false;
    const details = li.querySelector('details');
    if (!details.open) details.querySelector('summary').click();
    await wait(300);
    return click('New conversation here', li);
  `));
  const call = clicked ? await nextIpc(app, "start_session", 0, 90_000) : null;
  const meta = call?.ok ? parse(call.result) : null;
  await sleep(1_500);
  return {
    clicked,
    ok: call?.ok ?? null,
    error: call && !call.ok ? String(call.result).slice(0, 300) : null,
    sid: meta?.session_id ?? null,
    requested: call ? { authorizationMode: call.args?.authorizationMode ?? null, sandboxMode: call.args?.sandboxMode ?? null, disableWrite: call.args?.sandboxDisableWrite ?? null, disableShell: call.args?.sandboxDisableShell ?? null } : null,
    host: meta ? { approvalMode: meta.approval_mode ?? null, grantedCapabilities: meta.granted_capabilities ?? null } : null,
    engineStarted: engineFacts(engines().filter((e) => !before.has(e.pid))),
  };
}

/** Never a model turn with desktop control on: the grant is off and no driver runs under the app. */
async function computerOff(app) {
  const grant = await invoke(app, "computer_status", {});
  const drivers = tree(appPid).filter((p) => /^cua-driver/i.test(p.name)).length;
  return { grantState: grant.ok ? grant.value.grantState ?? null : grant.error, driversUnderTheApp: drivers, off: grant.ok && grant.value.grantState !== "active" && drivers === 0 };
}

/** Type the prompt in the composer and click Send; in a rehearsal send_input is refused in the page. */
async function send(app, sid, prompt, report) {
  await openConversation(app, sid);
  await waitFor(() => app.ev(page("return connection() === 'Connected';")), 90_000, 500);
  const guard = await computerOff(app);
  if (!guard.off) return { clicked: false, reason: "desktop control could be on: no turn", guard };
  const before = (await ipc(app, "send_input")).length;
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { clicked: false, reason: 'no composer' };
    setValue(field, ${J(prompt)});
    let b = null;
    for (let i = 0; i < 60; i++) { await wait(250); b = document.querySelector('button.send[aria-label="Send message"]'); if (b && !b.disabled) break; }
    if (!b || b.disabled) return { clicked: false, reason: 'send disabled' };
    b.click();
    return { clicked: true };
  `));
  if (sent.clicked && !REHEARSE) report.liveTurns += 1;
  const call = sent.clicked ? await nextIpc(app, "send_input", before, 60_000) : null;
  return { ...sent, guard, sendInput: call ? { ok: call.ok, refusedByHarness: REHEARSE } : null };
}

/**
 * Until the turn has ended on screen: not running, no card, no busy health
 * line, on two polls in a row. A card is handed to `onCard`.
 */
async function untilEnd(app, sid, onCard, timeoutMs = 300_000) {
  const t0 = Date.now();
  let quiet = 0;
  const done = await waitFor(async () => {
    const s = await app.ev(page(`return { running: running(${J(sid)}), cards: cards(), inputs: inputs(), health: health(), banner: banner() };`));
    if (s.cards.length > 0) {
      quiet = 0;
      await onCard(s.cards);
      return null;
    }
    const idle = s.running === "false" && s.inputs === 0 && !/working|resuming|waiting|stopping|retrying|thinking/i.test(s.health ?? "");
    quiet = idle && Date.now() - t0 > 5_000 ? quiet + 1 : 0;
    return quiet >= 2 ? s : null;
  }, timeoutMs, 1_000);
  return { ended: Boolean(done), ms: Date.now() - t0, final: done };
}

/** The rows from the prompt's bubble on, as painted, and the turn as the host records it. */
async function turnRecord(app, sid, prompt) {
  const painted = await app.ev(page("return rows();"));
  const start = painted.map((r, i) => (r.lane === "user" && r.text.includes(prompt.slice(0, 40)) ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
  const log = await storedLog(app, sid);
  const logStart = log.findLastIndex((e) => e.role === "user" && e.text.includes(prompt.slice(0, 40)));
  const history = await invoke(app, "read_session_history", { sessionId: sid });
  const items = (history.value?.items ?? []).map((raw) => ({ ...raw, ...(raw?.item ?? {}) }));
  const lastTurn = items.filter((i) => i.turnId).at(-1)?.turnId ?? null;
  return {
    rowsFromThePrompt: start >= 0 ? painted.slice(start) : painted.slice(-10),
    storedFromThePrompt: logStart >= 0 ? log.slice(logStart) : log.slice(-10),
    hostItemsOfTheTurn: items.filter((i) => i.turnId === lastTurn).map((i) => ({
      kind: i.kind ?? i.itemKind ?? null,
      status: i.status ?? null,
      tool: i.tool ?? i.toolName ?? i.name ?? null,
      output: String(i.visibleOutput ?? i.error?.message ?? "").replace(/\s+/g, " ").slice(0, 300) || null,
      failureReason: i.failureReason ?? null,
    })),
  };
}

/** Work panel > Terminal > Open terminal: Run in Muse as offered, then the app's shell closed from its own button. */
async function runInMuse(app) {
  await resetTrace(app);
  const shown = await app.ev(page(`
    const toggle = q('button').find((b) => b.getAttribute('aria-label') === 'Show work panel');
    if (toggle) toggle.click();
    await wait(400);
    click('Terminal', q('nav.work-tabs')[0]);
    await wait(500);
    const panel = () => q('section.terminal-panel')[0];
    if (panel() && button('Open terminal', panel())) click('Open terminal', panel());
    const input = await until(() => panel() && panel().querySelector('input[aria-label="Terminal command"]'), 20000);
    if (!input) return { error: 'no terminal', panel: text(panel()) };
    setValue(input, 'echo final-smoke');
    await wait(300);
    const b = panel().querySelector('button.terminal-muse');
    return { label: text(b), disabled: b ? b.disabled : null, title: b ? b.getAttribute('title') : null };
  `));
  const opened = (await ipc(app, "terminal_open")).at(-1);
  const closed = await app.ev(page(`
    const panel = q('section.terminal-panel')[0];
    const ok = panel ? click('Close', panel) : false;
    await wait(800);
    click('Close panel', q('nav.work-tabs')[0]);
    return ok;
  `));
  const close = await waitFor(async () => (await ipc(app, "terminal_close")).at(-1) ?? null, 5_000, 250);
  return { ...shown, appShell: { opened: opened?.ok ?? null, closedFromItsButton: closed && close?.ok === true } };
}

// ---- check 1: Read only --------------------------------------------------------------

async function readOnlyCheck(app, report) {
  const out = {};
  out.project = await createProject(app, RO_NAME, RO_DIR, "read-only");
  out.start = await startHere(app, RO_NAME);
  if (!out.start.sid) return out;
  await openConversation(app, out.start.sid);
  out.beforeTheTurn = await conversationView(app);
  out.turn = await send(app, out.start.sid, PROMPT_WRITE, report);
  if (out.turn.clicked && !REHEARSE) {
    // A card in a Read only project gets Allow once: the host, not the card, must refuse the write.
    const cardsSeen = [];
    out.turn.end = await untilEnd(app, out.start.sid, async (shown) => {
      const pending = await hostPending(app, out.start.sid);
      if (cardsSeen.length >= 5 || !Array.isArray(pending) || pending.length === 0) return;
      cardsSeen.push({ card: shown[0], hostChoices: pending[0].choices });
      await app.ev(page("const b = q('section[aria-label=\"Conversation authorization\"] .approval-actions button').find((n) => n.innerText.trim() === 'Allow once'); if (b) b.click(); return Boolean(b);"));
      await sleep(1_500);
    });
    out.turn.cardsAllowed = cardsSeen;
    Object.assign(out.turn, await turnRecord(app, out.start.sid, PROMPT_WRITE));
  }
  out.fileWritten = existsSync(join(RO_DIR, FILE));
  out.afterTheTurn = await conversationView(app);
  out.runInMuse = await runInMuse(app);
  out.engineNow = engineFacts(engines());
  return out;
}

/** "Muse thinking…": an assistant (or thinking) row still painted as the placeholder, or still open in the store. */
const MUSE_LANES = ["assistant", "thinking"];
const leftOnThinking = (turn) => (turn?.rowsFromThePrompt ?? []).slice(1).some((r) => MUSE_LANES.includes(r.lane) && r.body.includes("thinking…"))
  || (turn?.storedFromThePrompt ?? []).some((e) => MUSE_LANES.includes(e.role) && e.open);

function readOnlyVerdict(c) {
  const argv = (c.start?.engineStarted ?? []).map((e) => e.argv).join(" | ");
  const answer = (c.turn?.rowsFromThePrompt ?? []).slice(1);
  const replies = answer.filter((r) => r.lane === "assistant" && r.body.length > 0 && !r.body.includes("thinking…"));
  const refusal = answer.some((r) => r.failedMarker === "Failed")
    || /denied|refus|disabled|not allowed|read.only|lecture seule|cannot|can't|unable|impossible|interdit|policy/i.test(answer.map((r) => r.body).join("\n"));
  const criteria = {
    projectReadOnly: c.project?.stored?.settings?.sandbox === "read-only",
    engineArgvReadOnly: ["--sandbox-network restricted", "--disable-write", "--disable-shell"].every((flag) => argv.includes(flag)),
    liveTurnSent: c.turn?.clicked === true && c.turn?.sendInput?.ok === true,
    turnEndedOnScreen: c.turn?.end?.ended === true,
    replyOrRefusalShown: replies.length > 0 || refusal,
    notLeftOnThinking: answer.length > 0 && !leftOnThinking(c.turn),
    fileAbsent: c.fileWritten === false,
    runInMuseDisabledWithItsReason: c.runInMuse?.disabled === true && c.runInMuse?.title === RO_NOTE,
    postureNotePresent: c.afterTheTurn?.postureNote?.text === RO_NOTE,
  };
  return { verdict: Object.values(criteria).every(Boolean) ? "pass" : "fail", criteria, shown: { reply: replies.at(-1)?.text ?? null, refusal } };
}

// ---- check 2: follows Settings, reload, Restart host, a live approval ---------------------

/** Reload the window with the IPC trace and the poll tap installed from its first script. */
async function reloadWindow(app) {
  await app.send("Page.enable");
  const { identifier } = await app.send("Page.addScriptToEvaluateOnNewDocument", { source: `${INSTALL_IPC_TRACE};\n${POLL_TAP};` });
  const t0 = Date.now();
  await app.send("Page.reload", { ignoreCache: false });
  await sleep(2_000);
  await app.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  const back = await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000, 500);
  await app.ev(BLOCK);
  return { reloaded: Boolean(back), msToNav: Date.now() - t0, tapInstalled: await app.ev("Boolean(window.__smokeTap && window.__smokeTap.installed)") };
}

/** Settings: the project's folder as default folder (dialog answered), then "Restart workspace host" (confirmation answered OK). */
async function restartFromSettings(app, sid, oldPid) {
  await resetTrace(app);
  await app.ev(page("return openSettings();"));
  await sleep(1_200);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${J(ASK_DIR)}), true)`);
  const folder = await app.ev(page(`
    const b = q('section.settings-panel .workspace-picker button.workspace-button')[0];
    if (!b) return { clicked: false };
    b.click();
    await until(() => text(q('section.settings-panel .workspace-picker .workspace-path')[0]) === ${J(basename(ASK_DIR))});
    return { clicked: true, shown: text(q('section.settings-panel .workspace-picker .workspace-path')[0]) };
  `));
  folder.isTheProjectFolder = folder.shown === basename(ASK_DIR);
  if (!folder.isTheProjectFolder) return { folder };
  await app.ev("(window.__baselineIpc.messageQueue.push('Ok'), true)");
  const before = new Set(engines().map((e) => e.pid));
  const tapFrom = await app.ev("window.__smokeTap ? window.__smokeTap.events.length : 0");
  const journalFrom = engineView(sid).records;
  const t0 = Date.now();
  const clicked = await app.ev(page("const b = q('.settings-host-restart button').find((x) => /Restart workspace host/.test(x.innerText)); if (!b || b.disabled) return false; b.click(); return true;"));
  const gone = clicked && oldPid ? await waitFor(() => !alive(oldPid), 15_000, 50) : false;
  const oldEngineExitMs = gone ? Date.now() - t0 : null;
  const call = clicked ? await nextIpc(app, "restart_host", 0, 90_000) : null;
  const status = await waitFor(() => app.ev(page("return text(q('.settings-host-restart [role=\"status\"]')[0]);")), 10_000, 300);
  // The open conversation, told its host left, may be resumed by the app itself (resume on open).
  const autoResume = await waitFor(async () => (await ipc(app, "resume_session")).find((c) => c.ok !== undefined) ?? null, 5_000, 300);
  await sleep(1_000);
  return {
    eventsOnScreen: await tapOf(app, sid, tapFrom),
    // session_end among the records written since the click: the old host ended the conversation itself.
    journalSinceTheClick: engineView(sid, journalFrom),
    autoResume: autoResume ? { ok: autoResume.ok, sandboxMode: autoResume.args?.sandboxMode ?? null, reload: autoResume.args?.reload ?? null } : null,
    folder,
    clicked,
    confirmAnsweredByHarness: (await ipc(app, "plugin:dialog|message")).length,
    restartHost: call ? { ok: call.ok, requested: { sandboxMode: call.args?.sandboxMode ?? null, disableWrite: call.args?.sandboxDisableWrite ?? null, disableShell: call.args?.sandboxDisableShell ?? null }, result: parse(call.result) ?? String(call.result).slice(0, 300) } : null,
    oldEngine: { pid: oldPid, exited: Boolean(gone), msFromClickToExit: oldEngineExitMs, stopGraceMs: 3_000 },
    newEngine: engineFacts(engines().filter((e) => !before.has(e.pid))),
    statusShown: status,
  };
}

/** The events of one conversation the renderer received since tap index `from`. */
const tapOf = (app, sid, from) => app.ev(`window.__smokeTap ? window.__smokeTap.events.slice(${from}).filter((e) => e.sid === ${J(sid)}).map((e) => ({ atMs: e.atMs, kind: e.kind, payload: e.payload.slice(0, 200) })) : null`);

/** A read through the conversation's route (session/read): true when a host serves it, else the refusal. */
const readThroughRoute = async (app, sid) => {
  const read = await invoke(app, "read_session_history", { sessionId: sid });
  return read.ok ? true : String(read.error).slice(0, 200);
};

/** The conversation reopened after the restart, and its Reconnect clicked when offered. */
async function reconnect(app, sid) {
  await resetTrace(app);
  await openConversation(app, sid);
  const before = await conversationView(app);
  before.callsOnOpen = await app.ev("window.__baselineIpc.calls.map((c) => ({ cmd: c.cmd, ok: c.ok ?? null, ...(c.cmd === 'resume_session' ? { args: c.args, result: (c.result || '').slice(0, 300) } : {}) }))");
  before.journal = engineView(sid);
  before.hostAnswersARead = await readThroughRoute(app, sid);
  before.transcriptNotices = (await storedLog(app, sid)).filter((e) => e.role === "system").slice(-3).map((e) => e.text);
  let clicked = false;
  if (before.reconnectButton) {
    clicked = await app.ev(page("const b = q('.top-actions button.workspace-button').find((x) => /^Reconnect/.test(text(x))); if (!b || b.disabled) return false; b.click(); return true;"));
  }
  const call = clicked ? await nextIpc(app, "resume_session", 0, 90_000) : null;
  const connected = await waitFor(() => app.ev(page("return connection() === 'Connected';")), 90_000, 500);
  return {
    before,
    reconnectClicked: clicked,
    resumeSession: call ? { ok: call.ok, sandboxMode: call.args?.sandboxMode ?? null, disableWrite: call.args?.sandboxDisableWrite ?? null, error: call.ok ? null : String(call.result).slice(0, 300) } : null,
    connected: Boolean(connected),
    hostAnswersARead: await readThroughRoute(app, sid),
    after: await conversationView(app),
  };
}

/** What the host offers for the pending approval (list_pending_requests, the app's own read). */
async function hostPending(app, sid) {
  const res = await invoke(app, "list_pending_requests", { sessionId: sid });
  if (!res.ok) return { error: res.error.slice(0, 300) };
  return (res.value?.approvals ?? []).map((r) => ({
    approvalId: r.approvalId ?? r.request_id ?? null,
    requirement: r.currentRequirementId ?? r.requirementId ?? null,
    choices: (r.choices ?? r.availableChoices ?? []).map((c) => ({ choiceId: c.choiceId, label: c.label ?? null, decision: c.decision?.kind ?? c.decision ?? null })),
  }));
}

async function restartCheck(app, report, isolation) {
  const out = { isolation };
  out.project = await createProject(app, ASK_NAME, ASK_DIR, null);
  out.postureStored = await app.ev("localStorage.getItem('muse-desktop.authorization-mode.v1')");
  out.start = await startHere(app, ASK_NAME);
  const sid = out.start.sid;
  if (!sid) return out;
  await openConversation(app, sid);
  out.beforeReload = await conversationView(app);
  const askEngine = out.start.engineStarted[0]?.pid ?? null;

  out.reload = await reloadWindow(app);
  await openConversation(app, sid);
  out.reload.after = await conversationView(app);
  out.reload.enginesAfter = engineFacts(engines());
  out.reload.sameEngine = out.reload.enginesAfter.some((e) => e.pid === askEngine);

  out.restart = await restartFromSettings(app, sid, askEngine);
  out.reconnect = await reconnect(app, sid);
  out.enginesBeforeTheTurn = engineFacts(engines());
  const tapFrom = await app.ev("window.__smokeTap ? window.__smokeTap.events.length : 0");

  await resetTrace(app);
  out.turn = await send(app, sid, PROMPT_SHELL, report);
  if (out.turn.clicked && !REHEARSE) {
    out.turn.stages = [];
    out.turn.retries = [];
    out.turn.cardWithoutHostApproval = 0;
    out.turn.end = await untilEnd(app, sid, async (shown) => {
      if (out.turn.stages.length >= 5 || out.turn.retries.length >= 5) return;
      const pending = await hostPending(app, sid);
      const approval = Array.isArray(pending) ? pending[0] : null;
      // A card painted before the host lists it, or not yet removed after its
      // decision: nothing is clicked, the next poll looks again.
      if (!approval) { out.turn.cardWithoutHostApproval += 1; return; }
      const allow = approval.choices.find((c) => c.choiceId === "allow_once") ?? approval.choices.find((c) => c.decision === "approved") ?? null;
      const n = (await ipc(app, "approve")).length;
      const click = allow ? await mouse(app, `return q('section[aria-label="Conversation authorization"] .approval-actions button').find((b) => b.innerText.trim() === ${J(allow.label)}) || null;`) : { clicked: false };
      const call = click.clicked ? await nextIpc(app, "approve", n, 15_000) : null;
      if (!call) { out.turn.retries.push({ reason: allow ? "the click sent no decision" : "no allow choice", card: shown[0], hostChoices: approval.choices }); return; }
      out.turn.stages.push({
        card: shown[0],
        hostChoices: approval.choices,
        cardShowsTheHostChoices: J(shown[0].buttons) === J(approval.choices.map((c) => c.label)),
        clicked: allow.label,
        approve: { ok: call.ok, result: String(call.result ?? "").slice(0, 200) },
      });
      await waitFor(async () => {
        const next = await hostPending(app, sid);
        return !Array.isArray(next) || next.length === 0 || J(next[0].requirement) !== J(approval?.requirement) ? true : null;
      }, 30_000, 500);
      await sleep(800);
    });
    Object.assign(out.turn, await turnRecord(app, sid, PROMPT_SHELL));
    const events = await app.ev(`window.__smokeTap ? window.__smokeTap.events.slice(${tapFrom}).filter((e) => e.sid === ${J(sid)}) : []`);
    out.turn.eventsOnScreenAfterTheRestart = {
      count: events.length,
      byKind: events.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {}),
      sequence: events.map((e) => e.kind).filter((k, i, all) => k !== all[i - 1]),
      approvalRequest: events.find((e) => e.kind === "tool_request")?.payload.slice(0, 400) ?? null,
    };
  }
  out.probeFile = existsSync(join(ASK_DIR, "probe.txt")) ? readFileSync(join(ASK_DIR, "probe.txt"), "utf8").trim() : null;
  out.journalAfterTheTurn = engineView(sid);
  out.afterTheTurn = await conversationView(app);
  return out;
}

function restartVerdict(c) {
  const argvOf = (list) => (list ?? []).map((e) => e.argv).join(" | ");
  const network = (argv) => argv.includes("--sandbox-network enabled") && !/--disable-(write|shell|sandbox)/.test(argv);
  const stages = c.turn?.stages ?? [];
  const answer = (c.turn?.rowsFromThePrompt ?? []).slice(1);
  const ev = c.turn?.eventsOnScreenAfterTheRestart;
  const criteria = {
    askPosture: c.start?.requested?.authorizationMode === "ask" && c.start?.host?.approvalMode === "promptUnmatched",
    projectFollowsSettings: c.isolation?.stored?.mode === "network" && c.isolation?.stored?.networkAllowed === true
      && Object.keys(c.project?.stored?.settings ?? {}).length === 0
      && c.start?.requested?.sandboxMode === "network",
    engineArgvNetworkEnabled: network(argvOf(c.start?.engineStarted)),
    windowReloaded: c.reload?.reloaded === true,
    restartedFromTheUi: c.restart?.clicked === true && c.restart?.restartHost?.ok === true && c.restart?.restartHost?.result?.restarted === true,
    oldHostStoppedCleanly: c.restart?.oldEngine?.exited === true && c.restart?.oldEngine?.msFromClickToExit < c.restart?.oldEngine?.stopGraceMs
      && (c.restart?.journalSinceTheClick?.since ?? []).includes("session_end"),
    hostExitedReachedTheScreen: (c.restart?.eventsOnScreen ?? []).some((e) => e.kind === "host_exited"),
    newEngineArgvNetworkEnabled: network(argvOf(c.restart?.newEngine)),
    reconnected: c.reconnect?.connected === true && c.reconnect?.hostAnswersARead === true,
    liveTurnSent: c.turn?.clicked === true && c.turn?.sendInput?.ok === true,
    approvalCardShown: stages.length > 0,
    cardShowsTheHostChoices: stages.length > 0 && stages.every((s) => s.cardShowsTheHostChoices),
    allowAccepted: stages.length > 0 && stages.every((s) => s.approve?.ok === true) && stages.at(-1)?.approve?.result === "true",
    turnEnded: c.turn?.end?.ended === true && !leftOnThinking(c.turn),
    // The approval request and what followed it reached the renderer, and the reply is painted.
    eventsReachedTheScreen: Boolean(ev) && (ev.byKind.tool_request ?? 0) > 0
      && ev.sequence.slice(ev.sequence.indexOf("tool_request") + 1).length > 0
      && answer.some((r) => r.lane === "assistant" && r.body.length > 0 && !r.body.includes("thinking…")),
    noErrorBanner: !c.afterTheTurn?.banner,
    viewHealthy: c.journalAfterTheTurn?.viewStatus === "healthy",
  };
  return { verdict: Object.values(criteria).every(Boolean) ? "pass" : "fail", criteria };
}

// ---- check 3: the window's close ------------------------------------------------------

async function closeCheck(app, sids) {
  const pid = appPid;
  appPid = null;
  const before = tree(pid);
  const enginesAtClose = engineFacts(engines(pid));
  const clicked = await app.ev("(() => { const b = document.querySelector('button.window-close[aria-label=\"Close window\"]'); if (!b) return false; setTimeout(() => b.click(), 50); return true; })()").catch(() => false);
  app.close();
  const t0 = Date.now();
  const exited = clicked ? await waitFor(() => !alive(pid), 30_000, 200) : false;
  const steps = [{ step: "Close window (the app's own control)", clicked, exited: Boolean(exited), ms: exited ? Date.now() - t0 : null }];
  if (alive(pid)) {
    try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
    steps.push({ step: "taskkill /PID (WM_CLOSE)", exited: Boolean(await waitFor(() => !alive(pid), 10_000)) });
  }
  if (alive(pid)) {
    forceKill(pid);
    steps.push({ step: "taskkill /F /T /PID", exited: Boolean(await waitFor(() => !alive(pid), 10_000)) });
  }
  await sleep(3_000);
  const table = processTable();
  const left = before.filter((p) => table.some((t) => t.pid === p.pid && t.created === p.created));
  const webviews = ps(`Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${basename(DATA)}*' } | ForEach-Object { $_.ProcessId }`).split(/\r?\n/).filter(Boolean);
  return {
    processesAtClose: { count: before.length, byName: countByName(before) },
    enginesAtClose,
    steps,
    leftovers: {
      ofThisInstance: left.map((p) => ({ name: p.name, pid: p.pid })),
      enginesOfTheApp: engines(pid).length,
      appImageRunning: table.filter((p) => p.name.toLowerCase() === basename(EXE).toLowerCase()).length,
      webview2OnTheTestProfile: webviews.length,
    },
    journals: Object.fromEntries(Object.entries(sids).map(([key, sid]) => [key, engineView(sid)])),
  };
}

function closeVerdict(c) {
  const criteria = {
    closedFromItsOwnButton: c.steps[0]?.clicked === true && c.steps[0]?.exited === true && c.steps.length === 1,
    enginesRanUntilTheClose: c.enginesAtClose.length >= Math.max(1, Object.keys(c.journals).length),
    noProcessOfThisInstanceLeft: c.leftovers.ofThisInstance.length === 0 && c.leftovers.enginesOfTheApp === 0
      && c.leftovers.appImageRunning === 0 && c.leftovers.webview2OnTheTestProfile === 0,
    hostsEndedTheirConversations: Object.values(c.journals).every((v) => v?.lastRecords?.at(-1) === "session_end" && v.viewStatus === "healthy"),
  };
  return { verdict: Object.values(criteria).every(Boolean) ? "pass" : "fail", criteria };
}

// ---- run -------------------------------------------------------------------------

async function main() {
  const head = git("rev-parse", "HEAD");
  const report = {
    schema: "muse-desktop.final-smoke-windows.v1",
    purpose: "Last check before closing the Windows roadmap: M0-13 gap 2 on the merged build, a clean host stop with live events across the merged features, a graceful close.",
    date: new Date().toISOString().slice(0, 10),
    commit: head,
    build: {
      commit: git("rev-parse", BUILD_COMMIT),
      productUnchangedSinceBuild: git("diff", "--name-only", BUILD_COMMIT, "HEAD", "--", "src", "src-tauri", "package.json", "index.html") === "",
      productTreeClean: git("status", "--porcelain", "--", "src", "src-tauri", "package.json", "index.html") === "",
      exe: basename(EXE),
      exeSha256: sha256(EXE),
      kind: "debug build with the embedded frontend (npm run build, then cargo build), run from a copy",
    },
    engine: {
      version: execFileSync(SIDECAR, ["--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } }).trim(),
      sha256: sha256(SIDECAR),
      role: "MUSE_DESKTOP_TEST_SIDECAR: every local engine of this instance",
    },
    platform: `Windows 11 (${release()}), isolated test mode (ADR 0003), WebView2 over CDP`,
    harness: "scripts/cdp-final-smoke.mjs",
    rehearsal: REHEARSE,
    liveTurns: 0,
  };
  const watchdog = setTimeout(() => {
    process.stderr.write("watchdog: 25 minutes, the instance is killed\n");
    if (appPid) forceKill(appPid);
    process.exit(1);
  }, 25 * 60_000);
  let app = null;
  const checks = {};
  const sids = {};
  try {
    app = await launch(report);
    const boot = await invoke(app, "collect_diagnostics", {});
    report.isolation.testMode = boot.ok ? boot.value.testMode : boot.error;
    report.isolation.computerUse = await computerOff(app);
    // The global level first: the Read only project restricts it, the other follows it.
    const isolation = await setIsolation(app, "Workspace and network");
    for (const [key, run] of [["readOnly", () => readOnlyCheck(app, report)], ["restart", () => restartCheck(app, report, isolation)]]) {
      if (!ONLY.has(key)) continue;
      try {
        checks[key] = await run();
      } catch (error) {
        checks[key] = { ...(checks[key] ?? {}), harnessError: String(error?.message ?? error).slice(0, 400) };
      }
      if (checks[key]?.start?.sid) sids[key] = checks[key].start.sid;
      process.stdout.write(`${key}: done\n`);
    }
    report.consoleErrors = app.errors.slice(0, 20);
  } finally {
    if (appPid !== null && app) checks.close = await closeCheck(app, sids);
    else if (appPid !== null) forceKill(appPid);
    clearTimeout(watchdog);
  }
  report.checks = {
    ...(ONLY.has("readOnly") ? { "1 Read only project, one live write (M0-13 gap 2)": { ...readOnlyVerdict(checks.readOnly ?? {}), measured: checks.readOnly ?? null } } : {}),
    ...(ONLY.has("restart") ? { "2 follows Settings, reload, Restart host, a live approval": { ...restartVerdict(checks.restart ?? {}), measured: checks.restart ?? null } } : {}),
    "3 graceful close": { ...(checks.close ? closeVerdict(checks.close) : { verdict: "fail", criteria: { closed: false } }), measured: checks.close ?? null },
  };
  report.verdicts = Object.fromEntries(Object.entries(report.checks).map(([name, c]) => [name, c.verdict]));
  // The restart as measured before the fix, by this harness's own rehearsal on the build it was found on.
  const beforeFix = argValue("--before-fix", null);
  if (beforeFix) {
    const old = JSON.parse(readFileSync(beforeFix, "utf8"));
    const m = old.checks?.["2 follows Settings, reload, Restart host, a live approval"]?.measured;
    report.beforeFix = {
      run: "this harness with --rehearse (send_input refused in the page, no model turn) on the merged build before the fix",
      commit: old.build?.commit ?? null,
      exeSha256: old.build?.exeSha256 ?? null,
      date: old.date ?? null,
      restartHost: m?.restart?.restartHost?.result ?? null,
      eventsOfTheConversationOnScreenDuringTheRestart: m?.restart?.eventsOnScreen ?? null,
      conversationAfterTheRestart: m ? {
        connection: m.reconnect?.before?.connection ?? null,
        reconnectOffered: m.reconnect?.before?.reconnectButton ?? null,
        readThroughItsRoute: m.reconnect?.before?.hostAnswersARead ?? null,
        journalLastRecords: m.reconnect?.before?.journal?.lastRecords ?? null,
      } : null,
    };
  }
  report.disclosedForgeries = [
    "Clicks are DOM clicks on the real control in the real webview (HTMLElement.click()), except Allow once on the approval card, a real mouse press and release through CDP Input; typing sets the value through the native setter and fires input, a select fires change.",
    "The OS folder dialogs (Choose project folders, Settings' default folder) are answered by the harness (window.__baselineIpc.dialogQueue: plugin:dialog|open never reaches the OS); so is the OK/Cancel box of Restart workspace host (messageQueue, answered OK).",
    "The window reload is CDP Page.reload, with the IPC trace and a poll_events tap installed before the app's scripts: the tap only reads what the renderer receives.",
    "computer_status, collect_diagnostics, list_pending_requests and read_session_history are invoked over IPC to measure state; list_pending_requests also re-pins the app's approval registry from the host's read (what a boot does). No action is performed through IPC.",
  ];
  report.method = "One launch of the debug build in test mode from a copy: a fresh data folder and WebView2 profile, started from PowerShell with no WEBVIEW2_* variable, the staged native engine pinned by MUSE_DESKTOP_TEST_SIDECAR, MUSE_NO_AUTO_UPDATE=1, CDP through the WebView2 options. Isolation is checked before driving (test-mode.pid, --user-data-dir under the test folder). Effects are measured outside the click: Win32_Process argv, parents and start times, files in the project folders, the engine's own journal and MSP view of each conversation (read only), IPC results traced on window.fetch, the events the renderer receives (poll_events tap), the painted rows and the stored transcript. The instance is closed with its own Close window button.";
  const redact = redactor([[DATA, "<appdata>"], [RO_DIR, "<readonly project>"], [ASK_DIR, "<ask project>"], [BASE, "<smoke>"], [REPO, "<repo>"], [dirname(SIDECAR), "<engine-dir>"], [dirname(EXE), "<bin>"]]);
  const record = redact(report);
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ verdicts: record.verdicts, criteria: Object.fromEntries(Object.entries(record.checks).map(([k, c]) => [k, c.criteria])), liveTurns: record.liveTurns, out: OUT }, null, 2)}\n`);
  process.exit(0);
}

await main();
