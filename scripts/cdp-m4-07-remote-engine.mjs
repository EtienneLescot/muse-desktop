#!/usr/bin/env node

/**
 * M4-07 native acceptance: a conversation whose engine runs on another host,
 * started there by the system ssh (ADR 0002), driven in the real app over CDP.
 *
 * Test host: an sshd in a WSL2 Ubuntu VM on the same PC (separate OS, sshd and
 * user database), not a separate machine, key-only through the Windows
 * ssh-agent. Remote engine: a fixed Muse binary (--muse), never the
 * self-updating launcher. One launch of the dev build, in this order:
 *   1. Settings > Remote engine: the target is typed into the form and saved;
 *      a NEW conversation starts on it from the welcome picker. Engine version
 *      and OS come from the native diagnostics (the handshake's initialize).
 *   2. One live turn writes a file with the agent's file tool; the file is
 *      read back over ssh on the remote host.
 *   3. Changes, Terminal and Files say they are unavailable; the native git,
 *      terminal and files commands refuse; both worktree switches are off.
 *   4. The app's ssh child is killed (taskkill /F): the conversation reads
 *      disconnected; Reconnect resumes the same session id, its history is
 *      read back from the host, and a second turn recalls the file.
 *   5. Four failed starts, one per cause: unknown host key (alias localhost,
 *      never accepted: known_hosts is hashed before and after), refused
 *      authentication (user nobody), refused connection (port 2223), missing
 *      remote Muse (?muse=/nonexistent/muse).
 *   6. The test conversation is deleted, the target restored, the app closed
 *      from its window: no ssh child and no remote `muse serve` may remain.
 * Two billed turns. The remote folder is created, then deleted, over ssh.
 *
 * Usage (from PowerShell: the app must resolve the system OpenSSH, not Git's):
 *   node scripts/cdp-m4-07-remote-engine.mjs [--user etienne] [--host 127.0.0.1] [--port 2222]
 *     [--muse /home/<user>/.local/bin/muse-bin-1.3.0-R3401.1]
 *     [--exe G:\muse-build\cool-rubin-target\debug\muse-desktop.exe] [--base G:\muse-proofs\m4-07]
 *     [--out docs/evidence/2026-10-05-roadmap-closure/m4-07-remote-engine.json]
 * The harness launches and stops the app itself (MUSE_NO_AUTO_UPDATE=1, CDP on
 * MUSE_CDP_PORT or 9222) and refuses to run beside another muse-desktop process.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, PORT, argValue, gitHead, openPage, redactor, sleep, waitFor } from "./cdp-harness.mjs";

const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const USER = argValue("--user", "etienne");
const HOST = argValue("--host", "127.0.0.1");
const SSH_PORT = Number(argValue("--port", "2222"));
const REMOTE_HOME = `/home/${USER}`;
const MUSE = argValue("--muse", `${REMOTE_HOME}/.local/bin/muse-bin-1.3.0-R3401.1`);
const EXE = argValue("--exe", "G:\\muse-build\\cool-rubin-target\\debug\\muse-desktop.exe");
const BASE = argValue("--base", "G:\\muse-proofs\\m4-07");
const OUT = argValue("--out", "docs/evidence/2026-10-05-roadmap-closure/m4-07-remote-engine.json");
const ID = Date.now().toString(36);
const REMOTE_DIR = `${REMOTE_HOME}/muse-proofs/m4-07-${ID}`;
const FILE = "remote-proof.txt";
const MARKER = `M4-07-${ID}`;
const KEY = `ssh://${USER}@${HOST}:${SSH_PORT}${REMOTE_DIR}?muse=${MUSE}`;
const KNOWN_HOSTS = join(homedir(), ".ssh", "known_hosts");
const TARGET = { user: USER, host: HOST, port: SSH_PORT, musePath: MUSE, workspacePath: REMOTE_DIR };
const PROMPT_WRITE = `Use your file-writing tool, not a shell command, to create the file ${FILE} in the current folder with exactly this one line: ${MARKER}. Then reply with just the word WRITTEN.`;
const PROMPT_RECALL = "What is the name of the file you created earlier in this conversation? Reply with the file name only.";
const FAILURES = [
  { cause: "unknown host key", form: { host: "localhost" }, expect: `host key of localhost:${SSH_PORT} is not trusted yet.*ssh -p ${SSH_PORT} ${USER}@localhost` },
  { cause: "authentication refused", form: { user: "nobody" }, expect: `nobody@${HOST} refused the ssh authentication` },
  { cause: "connection refused", form: { port: SSH_PORT + 1 }, expect: `${HOST}:${SSH_PORT + 1} refused the connection` },
  { cause: "remote Muse missing", form: { musePath: "/nonexistent/muse" }, expect: `Muse was not found at /nonexistent/muse on ${HOST}` },
];

// ---- local and remote processes ----------------------------------------------

function ps(command) {
  // "exit 0": finding nothing is an answer, not a failure.
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", `${command}; exit 0`], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
}
const appProcesses = () => ps("Get-Process muse-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }")
  .split(/\s+/).filter(Boolean).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every ssh.exe carrying this run's folder, whoever its parent is now. */
function sshLinks() {
  return ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*m4-07-${ID}*' } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath, $_.CommandLine }`)
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, exe, ...cmd] = line.split("|");
      return { pid: Number(pid), ppid: Number(ppid), exe, cmd: cmd.join("|") };
    });
}

/** One command on the test host, as the user would type it (BatchMode: never a prompt). */
function remote(command, { user = USER, host = HOST, port = SSH_PORT } = {}) {
  try {
    const stdout = execFileSync(SSH, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(port), `${user}@${host}`, "--", command],
      { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, status: error.status ?? null, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim().slice(0, 400) };
  }
}

/** `muse serve` processes on the test host; ours run in this run's folder. */
function remoteServes() {
  const r = remote(`for p in $(pgrep -f '[m]use-bin.*[s]erve'); do printf '%s|%s|%s\\n' "$p" "$(readlink /proc/$p/cwd)" "$(tr '\\0' ' ' < /proc/$p/cmdline)"; done; true`);
  if (!r.ok) return { error: r.stderr || `exit ${r.status}` };
  const all = r.stdout.split("\n").filter(Boolean).map((line) => {
    const [pid, cwd, ...cmd] = line.split("|");
    return { pid: Number(pid), cwd, cmd: cmd.join("|").trim() };
  });
  const ours = all.filter((p) => p.cwd === REMOTE_DIR);
  return { ours, othersOnHost: all.length - ours.length };
}

const knownHostsDigest = () => { try { return createHash("sha256").update(readFileSync(KNOWN_HOSTS)).digest("hex").slice(0, 16); } catch { return null; } };
function knownHostEntry(name) {
  try { return execFileSync(SSH.replace("ssh.exe", "ssh-keygen.exe"), ["-F", name, "-f", KNOWN_HOSTS], { encoding: "utf8" }).includes("found"); } catch { return false; }
}

// ---- app lifecycle --------------------------------------------------------------

let appPid = null;
async function launch() {
  const foreign = appProcesses();
  if (foreign.length > 0) throw new Error(`blocked: ${foreign.length} muse-desktop process not started by this harness`);
  mkdirSync(BASE, { recursive: true });
  const child = spawn(EXE, [], {
    cwd: BASE,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  });
  child.unref();
  appPid = child.pid;
  const app = await waitFor(async () => { try { return await openPage(); } catch { return null; } }, 60_000, 1_000);
  if (!app) throw new Error("the app page never reached CDP");
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 30_000);
  await app.ev(INSTALL_IPC_TRACE);
  return app;
}

/** Close this harness's instance from its window (WM_CLOSE), force only as a fallback. */
async function stopApp(app) {
  app?.close();
  if (appPid === null) return null;
  const pid = appPid;
  appPid = null;
  try { execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); } catch { /* already gone */ }
  const graceful = Boolean(await waitFor(() => !alive(pid), 20_000));
  if (!graceful) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
    await waitFor(() => !alive(pid), 10_000);
  }
  return { graceful, exited: !alive(pid) };
}

// ---- page side -------------------------------------------------------------------

const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k].key : null; };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => (n ? n.innerText.replace(/\\s+/g, ' ').trim() : null);
`;
const page = (body) => `(async () => { ${H} ${body} })()`;
const invoke = (app, cmd, args) => app.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
  .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }))`);

/** Settings > Remote engine: type the fields, Save, read the status line and the stored copy. */
function saveTarget(app, target) {
  return app.ev(page(`
    document.querySelector('button.account[aria-label="Settings"]').click();
    await pause(700);
    for (const [field, value] of Object.entries(${JSON.stringify(target)})) {
      const input = document.getElementById('settings-remote-' + field);
      if (!input) return { error: 'no field ' + field };
      setValue(input, String(value));
    }
    await pause(200);
    const form = document.getElementById('settings-remote-host').closest('form');
    form.querySelector('button[type="submit"]').click();
    await pause(500);
    return {
      status: text(form.closest('.settings-group').querySelector('[role="status"]')),
      stored: store('muse-desktop.remote-engine.v1', 'null'),
    };
  `));
}

/** Welcome screen: pick the remote option, type the first message, Start; the start_session answer. */
async function startOnRemote(app, message) {
  await app.ev("(window.__baselineIpc.calls = [], true)");
  const picked = await app.ev(page(`
    q('.primary-nav button[aria-label="New conversation"]')[0].click();
    await pause(1200);
    const details = document.querySelector('details.project-picker-control');
    if (!details) return { found: false, reason: 'no picker' };
    details.open = true;
    await pause(300);
    const options = q('[role="option"].project-option');
    const option = options.find((o) => fiberKey(o) === 'remote');
    if (!option) return { found: false, keys: options.map(fiberKey) };
    const optionText = text(option);
    option.click();
    await pause(400);
    const worktree = document.querySelector('label.welcome-worktree input');
    return {
      found: true,
      optionText,
      trigger: text(document.querySelector('.project-trigger')),
      note: text(document.querySelector('.welcome-project-note')),
      worktreeSwitchDisabled: worktree ? worktree.disabled : null,
    };
  `));
  if (!picked.found) return { picked };
  const sent = await app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Your first message"]');
    setValue(field, ${JSON.stringify(message)});
    await pause(300);
    const start = document.querySelector('button.welcome-send');
    const enabled = Boolean(start && !start.disabled);
    if (enabled) start.click();
    return { clicked: enabled };
  `));
  const t0 = Date.now();
  const call = sent.clicked
    ? await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.ok !== undefined)"))[0] ?? null, 120_000)
    : null;
  return {
    picked,
    sent,
    ms: Date.now() - t0,
    workspacePath: call?.args?.workspacePath ?? null,
    mcpServersPassed: call ? call.args?.mcpServers !== undefined && call.args?.mcpServers !== null : null,
    ok: call?.ok ?? null,
    result: call?.result ?? null,
  };
}

/** Until the turn ends: one approval card at a time gets "Allow once" (recorded). */
async function waitTurn(app, sid, previousAssistant) {
  const approvals = [];
  const t0 = Date.now();
  const done = await waitFor(async () => {
    const s = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];
      const cards = q('.approvals .approval').map((g) => ({
        title: text(g.querySelector('.approval-title-row strong')),
        detail: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 300),
        buttons: [...g.querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()),
      }));
      const assistant = log.filter((e) => e.role === 'assistant');
      return {
        assistantCount: assistant.length,
        last: assistant.length ? String(assistant[assistant.length - 1].text || '').slice(0, 300) : null,
        tools: log.filter((e) => e.role === 'tool').map((e) => String(e.text || '').slice(0, 300)),
        failed: log.filter((e) => e.engineError).map((e) => e.engineError),
        roles: log.map((e) => e.role),
        health: text(document.querySelector('.stream-health')),
        running: document.querySelector('.task-metadata .dot')?.getAttribute('data-running') ?? null,
        cards,
      };
    `));
    if (s.cards.length > 0) {
      approvals.push(s.cards[0]);
      await app.ev(page("const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === 'Allow once'); if (b) b.click(); return Boolean(b);"));
      return null;
    }
    if (s.failed.length > 0 && s.running !== "true") return s;
    return s.assistantCount > previousAssistant && s.running !== "true" ? s : null;
  }, 240_000, 1_000);
  return { ...(done ?? { timedOut: true }), approvals, ms: Date.now() - t0 };
}

/** Composer of the open conversation: type, Send. */
function sendFollowUp(app, message) {
  return app.ev(page(`
    const field = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!field) return { clicked: false, reason: 'no composer' };
    setValue(field, ${JSON.stringify(message)});
    await pause(300);
    const send = document.querySelector('button.send[aria-label="Send message"]');
    const enabled = Boolean(send && !send.disabled);
    if (enabled) send.click();
    return { clicked: enabled };
  `));
}

const headerState = (app) => app.ev(page(`
  const pill = document.querySelector('.task-metadata .connection-state');
  const top = q('.top-actions button.workspace-button').map((b) => text(b));
  return {
    pill: text(pill),
    notice: text(document.querySelector('.connection-notice')),
    reconnectButton: top.find((t) => /Reconnect/.test(t)) || null,
    eyebrow: text(document.querySelector('.task-heading .eyebrow')),
    breadcrumb: text(document.querySelector('.breadcrumb')),
    lastSystem: ((store('muse-desktop.log.v1.' + (document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || ''), '[]') || [])
      .filter((e) => e.role === 'system').map((e) => e.text).pop()) || null,
  };
`));

// ---- scenario --------------------------------------------------------------------

async function main() {
  const report = {
    schema: "muse-desktop.m4-07-remote-engine.v1",
    ticket: "M4-07",
    date: new Date().toISOString().slice(0, 10),
    commit: gitHead(),
    platform: "Windows 11 (26200), debug build with embedded frontend, WebView2 over CDP",
    host: "a WSL2 Ubuntu VM on the same PC (separate OS, sshd and user database), not a separate machine; sshd on 127.0.0.1:2222, key-only, the key in the Windows ssh-agent",
    harness: "scripts/cdp-m4-07-remote-engine.mjs",
    method: "Real webview, the system OpenSSH client, the user's ssh agent. App actions go through the UI (Settings form, welcome picker, composer, work panel, Reconnect, the conversation's actions dialog); the native git, terminal and files commands are invoked directly only to show they refuse. Remote facts come from a separate ssh session as the same user (stat and cat of the file, pgrep of `muse serve` with its working folder). The app's ssh child is found by its command line (Win32_Process) and killed with taskkill /F.",
    limits: [
      "The host is a VM on the same PC: a real network (latency, a link dropped by a router rather than by a killed process) is not measured.",
      "The remote engine is 1.3.0, the binary installed on that host; the local sidecar is 1.4.2.",
    ],
    liveTurns: 0,
  };
  const remoteBefore = remote("uname -sr; . /etc/os-release; echo \"$PRETTY_NAME\"; env MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0 " + MUSE + " --version");
  if (!remoteBefore.ok) throw new Error(`test host unreachable: ${remoteBefore.stderr}`);
  const [kernel, distro, museVersion] = remoteBefore.stdout.split("\n");
  report.remote = { kernel, distro, museVersion, engineBinary: "a fixed Muse binary, not the self-updating launcher" };
  report.preflight = {
    folder: remote(`mkdir -p ${REMOTE_DIR} && cd ${REMOTE_DIR} && git init -q && echo created`).stdout,
    servesBefore: remoteServes(),
    knownHosts: { digest: knownHostsDigest(), loopbackKnown: knownHostEntry(`[${HOST}]:${SSH_PORT}`), localhostKnown: knownHostEntry(`[localhost]:${SSH_PORT}`) },
  };

  let app = null;
  let sid = null;
  let originalTarget = null;
  try {
    app = await launch();
    report.profile = await app.ev(page(`return {
      authorizationMode: store('muse-desktop.authorization-mode.v1', 'null'),
      remoteTargetBefore: store('muse-desktop.remote-engine.v1', 'null'),
    };`));
    originalTarget = report.profile.remoteTargetBefore;

    // 1. The target typed into Settings, a new conversation on it.
    const saved = await saveTarget(app, TARGET);
    const start = await startOnRemote(app, PROMPT_WRITE);
    report.liveTurns += start.ok ? 1 : 0;
    const meta = start.ok ? JSON.parse(start.result) : null;
    sid = meta?.session_id ?? null;
    report.start = { settings: saved, ...start, sessionId: sid ? `${sid.slice(0, 8)}…` : null, sessionDurability: meta?.session_durability ?? null, sessionWorkspace: meta?.workspace ?? null };
    if (!sid) throw new Error(`the remote start failed: ${start.result}`);
    const links = await waitFor(async () => { const l = sshLinks(); return l.length > 0 ? l : null; }, 10_000);
    report.start.sshLink = (links ?? []).map((l) => ({ parentIsApp: l.ppid === appPid, exe: l.exe, argv: l.cmd }));
    const diagnostics = await invoke(app, "collect_diagnostics", {});
    report.start.hostEngines = diagnostics.ok ? diagnostics.value.hostEngines : diagnostics.error;
    report.start.servesDuringTurn = remoteServes();

    // 2. The live turn and its effect on the remote host.
    const turn = await waitTurn(app, sid, 0);
    report.turn = turn;
    const file = remote(`cd ${REMOTE_DIR} && stat -c '%U %s' ${FILE} && cat ${FILE}`);
    report.turn.remoteFile = { exists: file.ok, owner: file.ok ? file.stdout.split("\n")[0] : null, content: file.ok ? file.stdout.split("\n").slice(1).join("\n") : file.stderr };
    report.turn.header = await headerState(app);

    // 3. Local-only surfaces.
    const panels = await app.ev(page(`
      const toggle = q('.top-actions button[aria-label="Show work panel"]')[0];
      if (toggle) { toggle.click(); await pause(500); }
      const out = {};
      for (const label of ['Changes', 'Terminal', 'Files', 'Browser']) {
        const tab = q('.work-tabs button').find((b) => b.innerText.trim() === label);
        if (!tab) { out[label] = 'no tab'; continue; }
        tab.click();
        await pause(600);
        const body = document.querySelector('.work-panel-body');
        out[label] = {
          notice: text(body?.querySelector('[role="status"]')),
          terminal: Boolean(body?.querySelector('.terminal-panel, .xterm')),
          review: Boolean(body?.querySelector('.review-panel')),
          files: Boolean(body?.querySelector('.files-panel')),
        };
      }
      const close = q('.work-tabs button[aria-label="Close panel"]')[0];
      if (close) close.click();
      return out;
    `));
    const native = {};
    for (const [cmd, args] of [["git_status", { sessionId: sid }], ["terminal_open", { sessionId: sid }], ["files_list", { sessionId: sid }]]) {
      const answer = await invoke(app, cmd, args);
      native[cmd] = answer.ok ? "ANSWERED (unexpected)" : answer.error;
    }
    const worktree = await app.ev(page(`
      const row = document.querySelector('li.session-item[data-session-id="${sid}"]');
      const actions = row?.querySelector("button[aria-label^='Actions for']");
      if (!actions) return { found: false };
      actions.click();
      await pause(400);
      const dialog = document.querySelector('dialog[open]');
      const button = dialog ? [...dialog.querySelectorAll('button')].find((b) => /worktree/i.test(b.innerText)) : null;
      const result = { found: Boolean(button), text: text(button), disabled: button ? button.disabled : null, title: button?.getAttribute('title') ?? null };
      dialog?.querySelector('button[aria-label="Close"]')?.click();
      await pause(200);
      return result;
    `));
    const ipcLocal = await app.ev("window.__baselineIpc.calls.filter((c) => /^(git_|terminal_|files_|file_)/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, result: (c.result || '').slice(0, 160) }))");
    report.localOnly = { panels, native, worktreeAction: worktree, welcomeWorktreeSwitchDisabled: start.picked.worktreeSwitchDisabled, localDiskCallsAnswered: ipcLocal.filter((c) => c.ok).map((c) => c.cmd) };

    // 4. The link dies: kill the app's ssh child. The open conversation gets
    // one silent resume per run (resume-on-open), so a second kill is needed
    // when the first one was resumed by the app itself.
    report.reconnect = { kills: [] };
    const killedPids = new Set();
    for (let round = 0; round < 2; round += 1) {
      await app.ev("(window.__baselineIpc.calls = [], true)");
      const killed = sshLinks().find((l) => l.ppid === appPid) ?? null;
      let taskkill = null;
      if (killed) {
        killedPids.add(killed.pid);
        try { taskkill = execFileSync("taskkill", ["/F", "/PID", String(killed.pid)], { encoding: "utf8" }).trim(); } catch (error) { taskkill = String(error.message).slice(0, 200); }
      }
      const timeline = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 12_000) {
        const h = await headerState(app);
        const last = timeline[timeline.length - 1];
        if (!last || last.pill !== h.pill || last.reconnectButton !== h.reconnectButton) timeline.push({ atMs: Date.now() - t0, ...h });
        await sleep(200);
      }
      const silent = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'resume_session').map((c) => ({ atMs: c.atMs, ok: c.ok }))");
      const kill = { killedPid: Boolean(killed), taskkill, timeline, silentResumes: silent, remoteAfterKill: remoteServes() };
      report.reconnect.kills.push(kill);
      const now = timeline[timeline.length - 1];
      if (now?.pill === "Disconnected" && now.reconnectButton) break;
    }
    const composer = await app.ev(page("const f = document.querySelector('textarea[aria-label=\"Message Muse\"]'); const s = document.querySelector('button.send'); return { composer: Boolean(f), sendDisabled: s ? s.disabled : null };"));
    await app.ev("(window.__baselineIpc.calls = [], true)");
    const clicked = await app.ev(page("const b = q('.top-actions button.workspace-button').find((n) => /Reconnect/.test(n.innerText)); if (b) b.click(); return Boolean(b);"));
    const t1 = Date.now();
    const up = await waitFor(async () => { const h = await headerState(app); return h.pill === "Connected" ? h : null; }, 90_000);
    const resume = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'resume_session').map((c) => ({ ok: c.ok, sessionId: c.args && c.args.sessionId, workspacePath: c.args && c.args.workspacePath, result: (c.result || '').slice(0, 300) }))");
    const historyCalls = await app.ev("window.__baselineIpc.calls.filter((c) => /session_history/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok }))");
    const history = await invoke(app, "read_session_history", { sessionId: sid });
    const historyText = JSON.stringify(history.value ?? history.error ?? "");
    const newLinks = sshLinks().filter((l) => l.ppid === appPid);
    Object.assign(report.reconnect, {
      composerWhileDisconnected: composer,
      reconnectClicked: clicked,
      msToConnected: up ? Date.now() - t1 : null,
      reconnectedHeader: up ?? await headerState(app),
      resumeSession: resume.map((r) => ({ ...r, sameSession: r.sessionId === sid, sessionId: undefined })),
      historyReads: historyCalls,
      hostHistory: { ok: history.ok, items: Array.isArray(history.value?.items) ? history.value.items.length : null, hasPrompt: historyText.includes(MARKER), hasFileName: historyText.includes(FILE) },
      newSshLink: newLinks.length === 1 && !killedPids.has(newLinks[0].pid),
      servesAfterReconnect: remoteServes(),
    });

    // The resumed session remembers the first turn (context lives on the host).
    const assistantSoFar = await app.ev(page(`return (store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || []).filter((e) => e.role === 'assistant').length;`));
    report.reconnect.followUp = await sendFollowUp(app, PROMPT_RECALL);
    if (report.reconnect.followUp.clicked) {
      report.liveTurns += 1;
      report.reconnect.recall = await waitTurn(app, sid, assistantSoFar);
    }

    // 5. One failed start per cause.
    report.failures = [];
    for (const failure of FAILURES) {
      const target = { ...TARGET, ...failure.form };
      const settings = await saveTarget(app, target);
      const digest = knownHostsDigest();
      const attempt = await startOnRemote(app, `M4-07 failure probe (${failure.cause}): reply OK.`);
      await sleep(500);
      const banner = await app.ev(page("return { banner: text(document.querySelector('.error-banner span')), restartOffered: q('.error-banner button').map((b) => text(b)) };"));
      report.failures.push({
        cause: failure.cause,
        target: { ...failure.form },
        settingsStatus: settings.status,
        startOk: attempt.ok,
        ms: attempt.ms,
        error: attempt.result,
        ...banner,
        matchesExpected: new RegExp(failure.expect).test(banner.banner ?? ""),
        knownHostsUnchanged: knownHostsDigest() === digest,
        // The failed link is ended (`client.shutdown`): only the test conversation's own link remains.
        appSshLinksAfter: sshLinks().filter((l) => l.ppid === appPid).length,
      });
      if (attempt.ok) report.liveTurns += 1;
    }
    report.knownHostsAfter = { digest: knownHostsDigest(), localhostKnown: knownHostEntry(`[localhost]:${SSH_PORT}`) };
  } catch (error) {
    report.failure = String(error?.message ?? error).slice(0, 400);
  } finally {
    // 6. Clean up: the test conversation, the target, the app.
    if (app) {
      try {
        if (sid) {
          report.cleanup = await app.ev(page(`
            const row = document.querySelector('li.session-item[data-session-id="${sid}"]');
            const actions = row?.querySelector("button[aria-label^='Actions for']");
            if (!actions) return { deleted: false, reason: 'no row' };
            actions.click();
            await pause(400);
            const dialog = document.querySelector('dialog[open]');
            [...dialog.querySelectorAll('button')].find((b) => /^Delete/.test(b.innerText.trim()))?.click();
            await pause(400);
            const confirm = [...document.querySelectorAll('dialog[open] button')].find((b) => /^Delete( conversation| permanently)?$/i.test(b.innerText.trim()));
            confirm?.click();
            await pause(800);
            return { deleted: !document.querySelector('li.session-item[data-session-id="${sid}"]'), confirmText: confirm ? text(confirm) : null };
          `));
          report.cleanup.servesAfterDelete = remoteServes();
        }
        report.cleanup = { ...(report.cleanup ?? {}), targetRestored: await (originalTarget === null
          ? app.ev(page(`
              document.querySelector('button.account[aria-label="Settings"]').click();
              await pause(700);
              const remove = [...document.getElementById('settings-remote-host').closest('form').querySelectorAll('button')].find((b) => b.innerText.trim() === 'Remove');
              remove?.click();
              await pause(300);
              return store('muse-desktop.remote-engine.v1', 'null') === null;
            `))
          : saveTarget(app, originalTarget).then((r) => JSON.stringify(r.stored) === JSON.stringify(originalTarget))) };
        report.consoleErrors = app.errors.slice(0, 20);
      } catch (error) {
        report.cleanupFailure = String(error?.message ?? error).slice(0, 300);
      }
    }
    report.appClose = await stopApp(app);
    report.afterClose = await waitFor(async () => {
      const serves = remoteServes();
      return sshLinks().length === 0 && serves.ours?.length === 0 ? { sshLinks: 0, serves } : null;
    }, 30_000, 2_000) ?? { sshLinks: sshLinks().length, serves: remoteServes() };
    if ((report.afterClose.serves?.ours ?? []).length > 0) {
      report.limits.push("A remote `muse serve` outlived the app by more than 30 s: per ADR 0002 it is sshd's to end, once sshd notices the dead link.");
    }
    report.remoteFolderDeleted = remote(`rm -rf ${REMOTE_DIR} && test ! -e ${REMOTE_DIR} && echo deleted`).stdout === "deleted";
  }

  report.verdict = verdict(report);
  const redact = redactor([[BASE, "<proof>"]]);
  const text = JSON.stringify(redact(report), null, 2)
    .replaceAll(REMOTE_DIR, "<remote folder>")
    .replaceAll(REMOTE_HOME, "<remote home>")
    .replace(new RegExp(`\\b${USER}\\b`, "g"), "<user>");
  writeFileSync(OUT, `${text}\n`);
  process.stdout.write(`${JSON.stringify(JSON.parse(text).verdict, null, 2)}\n`);
}

function verdict(r) {
  const engines = Array.isArray(r.start?.hostEngines) ? r.start.hostEngines : [];
  return {
    "1 target saved from the form": r.start?.settings?.stored?.host === HOST && /Saved/.test(r.start?.settings?.status ?? ""),
    "1 new conversation started on the ssh:// key": r.start?.ok === true && r.start?.workspacePath === KEY,
    "1 app drove the system OpenSSH": (r.start?.sshLink ?? []).some((l) => l.parentIsApp && /System32\\OpenSSH\\ssh\.exe$/i.test(l.exe)),
    "1 handshake: engine 1.3.0 on linux": engines.some((e) => e.serverVersion === "1.3.0" && e.platform === "linux"),
    "2 live turn completed": Boolean(r.turn && !r.turn.timedOut && (r.turn.failed ?? []).length === 0),
    "2 file written on the remote host": r.turn?.remoteFile?.content === MARKER,
    "3 Changes/Terminal/Files unavailable": ["Changes", "Terminal", "Files"].every((p) => /Not available for remote conversations/.test(r.localOnly?.panels?.[p]?.notice ?? "")),
    "3 native git/terminal/files refuse": Object.values(r.localOnly?.native ?? {}).length === 3 && Object.values(r.localOnly.native).every((e) => /Not available for remote conversations/.test(e)),
    "3 worktree actions disabled": r.localOnly?.worktreeAction?.disabled === true && r.localOnly?.welcomeWorktreeSwitchDisabled === true,
    "4 honest disconnected state": (r.reconnect?.kills ?? []).some((k) => k.timeline.some((t) => t.pill === "Disconnected" && t.reconnectButton)),
    "4 reconnect resumes the same session": (r.reconnect?.resumeSession ?? []).some((c) => c.ok && c.sameSession) && r.reconnect?.newSshLink === true,
    "4 history read back from the host": r.reconnect?.hostHistory?.hasPrompt === true,
    "4 resumed session recalls the file": new RegExp(FILE.replace(".", "\\.")).test(r.reconnect?.recall?.last ?? ""),
    "5 errors honest": (r.failures ?? []).length === 4 && r.failures.every((f) => f.startOk === false && f.matchesExpected && f.appSshLinksAfter <= 1),
    "5 host key never accepted": r.knownHostsAfter?.digest === r.preflight?.knownHosts?.digest && r.knownHostsAfter?.localhostKnown === false,
    "6 no orphan after close": r.afterClose?.sshLinks === 0 && r.afterClose?.serves?.ours?.length === 0,
    liveTurns: r.liveTurns,
    consoleErrors: (r.consoleErrors ?? []).length,
  };
}

await main();
