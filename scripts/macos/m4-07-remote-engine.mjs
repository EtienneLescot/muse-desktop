#!/usr/bin/env node
/**
 * M4-07 on macOS: a conversation whose engine is started on another host by
 * the system ssh (ADR 0002), driven in the real app (WKWebView, test bridge).
 * The macOS replay of scripts/cdp-m4-07-remote-engine.mjs: same six checks,
 * same verdicts.
 *
 * Test host, without touching ~/.ssh nor a system setting (no Remote Login):
 * an sshd run by the user on 127.0.0.1:<--ssh-port>, with its own host key,
 * authorized_keys and config in the proof folder (`/usr/sbin/sshd -D -f`). It
 * is the same Mac and the same user: not a separate machine.
 *
 * The client is the system OpenSSH (/usr/bin/ssh). The app finds ssh on its
 * PATH first (remote_ssh.rs), so the instance gets a PATH whose first `ssh` is
 * a two-line wrapper in the proof folder: it logs the argv the app built, then
 * `exec /usr/bin/ssh -F <proof ssh_config> "$@"` (same PID, the system binary).
 * `-F` replaces ~/.ssh/config with one that names the proof's known_hosts and
 * key and turns the user's agent off (IdentityAgent none), so neither the
 * user's keys nor their known_hosts are used or written. Everything the app
 * puts on the command line still wins over that file.
 *
 *   1. Settings > Remote engine: the target typed into the form; a new
 *      conversation started on it from the welcome picker.
 *   2. One live turn writes a file with the agent's file tool, read back over
 *      a separate ssh session; the prompt carries a second code never written.
 *   3. Changes, Terminal and Files unavailable; native git/terminal/files refuse;
 *      worktree switches off.
 *   4. The app's ssh child killed by PID: Disconnected, Reconnect resumes the
 *      same session over a new link, history read back, a second turn recalls
 *      the code with no tool call.
 *   5. Four failed starts: unknown host key (alias localhost), refused
 *      authentication (user nobody), refused connection (closed port), missing
 *      remote Muse. The proof's known_hosts byte-identical, and the user's
 *      ~/.ssh/known_hosts unchanged (size and mtime only: its content is not read).
 *   6. The app closed from its window: no ssh child, no remote `muse serve`.
 * Two live turns. The remote engine is the pinned binary (~/muse-proofs/...).
 *
 *   node scripts/macos/m4-07-remote-engine.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9477] [--ssh-port 9476] [--closed-port 9478] [--base <dir>] [--out <json>]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { INSTALL_IPC_TRACE } from "../cdp-harness.mjs";
import { DEFAULT_ENGINE, engineVersion, launch, processTree } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9477"));
const SSH_PORT = Number(argValue("--ssh-port", "9476"));
const CLOSED_PORT = Number(argValue("--closed-port", "9478"));
mkdirSync(join(tmpdir(), "muse-proofs-g7"), { recursive: true });
const BASE = realpathSync(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g7"))));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-07-remote-engine-macos.json");
const ID = Date.now().toString(36);
const RUN = join(BASE, `m4-07-${ID}`);
const SSHD = join(RUN, "sshd");
const USER = userInfo().username;
const HOST = "127.0.0.1";
const MUSE = "~/muse-proofs/engine/1.4.2-R4684.1/muse-bin";
const REMOTE_DIR = join(RUN, "remote");
const FILE = "remote-proof.txt";
const MARKER = `M4-07-${ID}`;
const SECRET = `KEEP-${randomBytes(4).toString("hex").toUpperCase()}`;
const KEY = `ssh://${USER}@${HOST}:${SSH_PORT}${REMOTE_DIR}?muse=${MUSE}`;
const USER_KNOWN_HOSTS = join(homedir(), ".ssh", "known_hosts");
const TARGET = { user: USER, host: HOST, port: SSH_PORT, musePath: MUSE, workspacePath: REMOTE_DIR };
const PROMPT_WRITE = `Use your file-writing tool, not a shell command, to create the file ${FILE} in the current folder with exactly this one line: ${MARKER}. Also keep this second code in mind for later in this conversation, but do not write it to any file and do not run any command with it: ${SECRET}. Then reply with just the word WRITTEN.`;
const PROMPT_RECALL = "Without using any tool, reply with only the second code I gave you in my first message, the one I asked you not to write anywhere.";
const FAILURES = [
  { cause: "unknown host key", form: { host: "localhost" }, expect: `host key of localhost:${SSH_PORT} is not trusted yet.*ssh -p ${SSH_PORT} ${USER}@localhost` },
  { cause: "authentication refused", form: { user: "nobody" }, expect: `nobody@${HOST} refused the ssh authentication` },
  { cause: "connection refused", form: { port: CLOSED_PORT }, expect: `${HOST}:${CLOSED_PORT} refused the connection` },
  { cause: "remote Muse missing", form: { musePath: "/nonexistent/muse" }, expect: `Muse was not found at /nonexistent/muse on ${HOST}` },
];

// ---- the test host: an sshd of the user's own, all in the proof folder -----------------
mkdirSync(join(SSHD, "bin"), { recursive: true });
const keygen = (file, comment) => execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
keygen(join(SSHD, "host_key"), "m4-07-host");
keygen(join(SSHD, "client_key"), "m4-07-client");
writeFileSync(join(SSHD, "authorized_keys"), readFileSync(join(SSHD, "client_key.pub")));
writeFileSync(join(SSHD, "sshd_config"), [
  `Port ${SSH_PORT}`, `ListenAddress ${HOST}`, `HostKey ${join(SSHD, "host_key")}`, `PidFile ${join(SSHD, "sshd.pid")}`,
  `AuthorizedKeysFile ${join(SSHD, "authorized_keys")}`, "StrictModes no", "UsePAM no", "PasswordAuthentication no",
  "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "PermitUserEnvironment no", "AllowTcpForwarding no",
  "X11Forwarding no", "AllowAgentForwarding no", `AllowUsers ${USER}`, "LogLevel VERBOSE", "",
].join("\n"));
const KNOWN_HOSTS = join(SSHD, "known_hosts");
writeFileSync(KNOWN_HOSTS, `[${HOST}]:${SSH_PORT} ${readFileSync(join(SSHD, "host_key.pub"), "utf8").split(" ").slice(0, 2).join(" ")}\n`);
const SSH_CONFIG = join(SSHD, "ssh_config");
writeFileSync(SSH_CONFIG, ["Host *", `  UserKnownHostsFile ${KNOWN_HOSTS}`, "  GlobalKnownHostsFile /dev/null", `  IdentityFile ${join(SSHD, "client_key")}`,
  "  IdentitiesOnly yes", "  IdentityAgent none", "  StrictHostKeyChecking yes", "  UpdateHostKeys no", "  CheckHostIP no", ""].join("\n"));
const WRAPPER_LOG = join(SSHD, "wrapper.log");
writeFileSync(join(SSHD, "bin", "ssh"), `#!/bin/sh\nprintf '%s %s\\n' "$$" "$*" >> '${WRAPPER_LOG}'\nexec /usr/bin/ssh -F '${SSH_CONFIG}' "$@"\n`, { mode: 0o755 });
// The app adopts the PATH of an interactive login shell at startup (login_env.rs), which puts
// /usr/bin first: the instance's zsh reads the proof's dotfiles (ZDOTDIR), whose .zshrc puts the
// wrapper first. The user's own dotfiles are not read by that probe; nothing else is imported.
const ZDOTDIR = join(SSHD, "zdot");
mkdirSync(ZDOTDIR, { recursive: true });
writeFileSync(join(ZDOTDIR, ".zshrc"), `export PATH='${join(SSHD, "bin")}':"$PATH"\n`);
const sshdLog = [];
const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(SSHD, "sshd_config")], { stdio: ["ignore", "pipe", "pipe"] });
sshd.stdout.on("data", (d) => sshdLog.push(...String(d).split("\n").filter(Boolean)));
sshd.stderr.on("data", (d) => sshdLog.push(...String(d).split("\n").filter(Boolean)));

// ---- processes and the remote side -------------------------------------------------------
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rows = () => execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 }).split("\n")
  .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
/** Every ssh client carrying this run's folder, whoever its parent is now. */
const sshLinks = () => rows().filter((p) => /^(\/usr\/bin\/ssh|\/bin\/sh .*\/bin\/ssh)\s/.test(p.command) && p.command.includes(`m4-07-${ID}`) && !p.command.includes("pgrep"))
  .map((p) => ({ pid: p.pid, ppid: p.ppid, exe: p.command.split(" ")[0], cmd: p.command }));
let appPid = null;
/** One command on the test host, as the user would type it (BatchMode: never a prompt). */
function remote(command, { user = USER, port = SSH_PORT } = {}) {
  try {
    const stdout = execFileSync("/usr/bin/ssh", ["-F", SSH_CONFIG, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(port), `${user}@${HOST}`, "--", command],
      { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, status: error.status ?? null, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim().slice(0, 400) };
  }
}
/** `muse serve` processes on the test host; ours run in this run's folder. Env read with ps -E. */
function remoteServes() {
  const r = remote(`for p in $(pgrep -f '[m]use-bin serve'); do printf '%s|%s|%s|%s\\n' "$p" "$(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" "$(ps -wwE -o command= -p $p | tr ' ' '\\n' | grep -E '^MUSE_(NO_AUTO_UPDATE|LOGIN)=' | sort | tr '\\n' ' ')" "$(ps -ww -o command= -p $p)"; done; true`);
  if (!r.ok) return { error: r.stderr || `exit ${r.status}` };
  const all = r.stdout.split("\n").filter(Boolean).map((line) => {
    const [pid, cwd, env, ...cmd] = line.split("|");
    return { pid: Number(pid), cwd, env: env.trim(), cmd: cmd.join("|").trim() };
  });
  const ours = all.filter((p) => p.cwd === REMOTE_DIR);
  return { ours, othersOnHost: all.length - ours.length };
}
const userKnownHosts = () => { try { const s = statSync(USER_KNOWN_HOSTS); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } };
const proofKnownHosts = () => ({ sha256: sha256(KNOWN_HOSTS), bytes: statSync(KNOWN_HOSTS).size });

// ---- page side (as the Windows harness) -----------------------------------------------
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
const logOf = (app, sid) => app.ev(page(`return store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];`));

function saveTarget(app, target) {
  return app.ev(page(`
    if (!document.getElementById('settings-remote-host')) { document.querySelector('button.account[aria-label="Settings"]').click(); await pause(700); }
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
    return { found: true, optionText, trigger: text(document.querySelector('.project-trigger')), note: text(document.querySelector('.welcome-project-note')), worktreeSwitchDisabled: worktree ? worktree.disabled : null };
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
  const call = sent.clicked ? await waitFor(async () => (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session' && c.ok !== undefined)"))[0] ?? null, 120_000) : null;
  return { picked, sent, ms: Date.now() - t0, args: call?.args ?? null, ok: call?.ok ?? null, result: call?.result ?? null };
}
async function waitTurn(app, sid, previousAssistant) {
  const approvals = [];
  const t0 = Date.now();
  const done = await waitFor(async () => {
    const s = await app.ev(page(`
      const log = store('muse-desktop.log.v1.' + ${JSON.stringify(sid)}, '[]') || [];
      const cards = q('.approvals .approval').map((g) => ({ title: text(g.querySelector('.approval-title-row strong')), detail: (g.querySelector('.approval-details pre')?.innerText || '').slice(0, 300) }));
      const assistant = log.filter((e) => e.role === 'assistant' && String(e.text || '').trim());
      return {
        assistantCount: assistant.length,
        last: assistant.length ? String(assistant[assistant.length - 1].text || '').slice(0, 300) : null,
        toolCount: log.filter((e) => e.role === 'tool').length,
        tools: log.filter((e) => e.role === 'tool').map((e) => String(e.text || '').slice(0, 300)),
        failed: log.filter((e) => e.engineError).map((e) => e.engineError),
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
  const top = q('.top-actions button.workspace-button').map((b) => text(b));
  return { pill: text(document.querySelector('.task-metadata .connection-state')), notice: text(document.querySelector('.connection-notice')), reconnectButton: top.find((t) => /Reconnect/.test(t)) || null, banner: text(document.querySelector('.error-banner span')) };
`));
const screenTranscript = (app) => app.ev(page(`return q('.msg').map((n) => ({ role: [...n.classList].find((c) => c !== 'msg') || null, text: text(n).slice(0, 400) }));`));
const historyItems = (value) => (value?.items ?? value?.snapshot?.state?.items ?? []).map((raw) => {
  const item = { ...raw, ...(raw?.item ?? {}) };
  return { turn: item.turnId ?? item.turn_id ?? null, kind: item.kind ?? item.itemKind ?? item.type ?? null };
});

// ---- scenario --------------------------------------------------------------------
const platform = execFileSync("sw_vers", [], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(":")[1].trim());
const report = {
  schema: "muse-desktop.m4-07-remote-engine-macos.v1",
  ticket: "M4-07",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `${platform[0]} ${platform[1]} (${platform[2]}), arm64, Apple Silicon; debug build with embedded frontend, isolated test mode (ADR 0003, macOS amendment), WKWebView through the test bridge`,
  host: `an sshd started by the user from /usr/sbin/sshd on ${HOST}:${SSH_PORT}, with its own host key, authorized_keys and config in the proof folder (no Remote Login, no system setting); the same Mac and the same user, not a separate machine`,
  harness: "scripts/macos/m4-07-remote-engine.mjs on scripts/macos/test-instance.mjs (macOS replay of scripts/cdp-m4-07-remote-engine.mjs)",
  method: "Real WKWebView of an isolated instance (fresh data folder and WKWebView store, local engine pinned by MUSE_DESKTOP_TEST_SIDECAR, none started here). App actions go through the UI as in the Windows harness (Settings form, welcome picker, composer, work panel, Reconnect, the conversation's actions dialog); the native git, terminal and files commands are invoked directly only to show they refuse. The instance's PATH starts with a proof folder whose `ssh` logs its argv and execs /usr/bin/ssh -F <proof ssh_config> with the same PID: the system OpenSSH, with the proof's known_hosts and key in place of ~/.ssh and the user's agent off. Remote facts come from a separate ssh session as the same user (stat and cat of the file, grep of the workspace, pgrep of `muse-bin serve` with its working folder from lsof and its MUSE_ variables from ps -E). The app's ssh child is found by its command line and parent (ps) and killed with SIGKILL; the app itself is closed from its window (Tauri window close, the OS close path).",
  limits: [
    "The host is the same Mac and the same user (an sshd run by the user on a loopback port): no real network, no separate user database. Étienne may require a separate host, as on Windows.",
    "The app is given a PATH whose first ssh is a wrapper adding -F <proof ssh_config> before the app's own argv (so ~/.ssh is neither read nor written). The binary that runs is /usr/bin/ssh under the same PID; a Finder-launched app would find /usr/bin/ssh itself and use ~/.ssh/config, the user's known_hosts and agent.",
    "The app replaces its PATH with the one an interactive login shell prints (login_env.rs), so the instance runs with SHELL=/bin/zsh and ZDOTDIR set to the proof folder, whose .zshrc puts the wrapper's folder first: the probe reads the proof's dotfiles instead of the user's. ZDOTDIR stays in the app's environment (only a local terminal would see it; none is opened here).",
    "The remote engine is the pinned 1.4.2 binary run through the same user's login shell; it shares the user's Muse data root (sessions, settings, sign-in), as the local test sidecar does (ADR 0003).",
  ],
  liveTurns: 0,
};
let inst = null;
let app = null;
let sid = null;
try {
  if (!(await waitFor(() => sshdLog.some((l) => /Server listening/.test(l)), 10_000, 100))) throw new Error(`sshd did not start: ${sshdLog.join(" | ")}`);
  const remoteBefore = remote(`uname -sr; sw_vers -productVersion; env MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0 ${MUSE} --version`);
  if (!remoteBefore.ok) throw new Error(`test host unreachable: ${remoteBefore.stderr}`);
  const [kernel, macos, museVersion] = remoteBefore.stdout.split("\n");
  report.engines = {
    remote: { kernel, macos, museVersion, binary: "the pinned engine binary (~/muse-proofs/engine/1.4.2-R4684.1/muse-bin), not the self-updating launcher" },
    localTestSidecar: { version: engineVersion(DEFAULT_ENGINE), role: "MUSE_DESKTOP_TEST_SIDECAR: every local engine of this instance; none is started here" },
  };
  report.engine = museVersion;
  report.preflight = {
    folder: remote(`mkdir -p ${REMOTE_DIR} && cd ${REMOTE_DIR} && git init -q && ls -A`).stdout,
    servesBefore: remoteServes(),
    proofKnownHosts: proofKnownHosts(),
    userKnownHosts: userKnownHosts(),
    sshVersion: execFileSync("/usr/bin/ssh", ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null,
  };

  inst = await launch({ exe: EXE, port: PORT, data: join(RUN, "data"), env: { PATH: `${join(SSHD, "bin")}:${process.env.PATH}`, SHELL: "/bin/zsh", ZDOTDIR } });
  app = inst.app;
  appPid = inst.pid;
  report.isolation = inst.isolation;
  await waitFor(() => app.ev("Boolean(document.querySelector('.primary-nav'))"), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  const boot = await invoke(app, "collect_diagnostics", {});
  report.isolation.testMode = boot.ok ? boot.value.testMode : boot.error;
  report.isolation.hostEnginesAtBoot = boot.ok ? boot.value.hostEngines : null;
  report.isolation.remoteTargetAtBoot = await app.ev(page("return store('muse-desktop.remote-engine.v1', 'null');"));

  // 1. The target typed into Settings, a new conversation on it.
  const saved = await saveTarget(app, TARGET);
  const start = await startOnRemote(app, PROMPT_WRITE);
  report.liveTurns += start.ok ? 1 : 0;
  const meta = start.ok ? JSON.parse(start.result) : null;
  sid = meta?.session_id ?? null;
  report.start = { settings: saved, ...start, result: start.ok ? undefined : start.result, sessionId: sid ? `${sid.slice(0, 8)}…` : null, session: meta ? { ...meta, session_id: undefined } : null };
  if (!sid) throw new Error(`the remote start failed: ${start.result}`);
  report.start.storedConversationWorkspace = await app.ev(page(`return ((store('muse-desktop.sessions.v1', '[]') || []).find((s) => s.session_id === ${JSON.stringify(sid)}) || {}).workspace ?? null;`));
  const links = await waitFor(async () => { const l = sshLinks(); return l.length > 0 ? l : null; }, 10_000);
  report.start.sshLink = (links ?? []).map((l) => ({ pid: l.pid, parentIsApp: l.ppid === appPid, exe: l.exe, argv: l.cmd }));
  report.start.wrapperLog = readFileSync(WRAPPER_LOG, "utf8").trim().split("\n").map((l) => { const [pid, ...argv] = l.split(" "); return { pid: Number(pid), argv: argv.join(" ") }; });
  report.start.appChildren = processTree(appPid).filter((p) => p.pid !== appPid).map((p) => p.command.split(" ")[0].replace(/^.*\//, ""));
  const diagnostics = await invoke(app, "collect_diagnostics", {});
  report.start.hostEngines = diagnostics.ok ? diagnostics.value.hostEngines : diagnostics.error;
  report.start.servesDuringTurn = remoteServes();

  // 2. The live turn and its effect on the remote host.
  const turn = await waitTurn(app, sid, 0);
  report.turn = turn;
  const file = remote(`cd ${REMOTE_DIR} && stat -f '%Su %z' ${FILE} && cat ${FILE}`);
  report.turn.remoteFile = { exists: file.ok, owner: file.ok ? file.stdout.split("\n")[0] : null, content: file.ok ? file.stdout.split("\n").slice(1).join("\n") : file.stderr };
  report.turn.secretInWorkspace = remote(`grep -rlF ${SECRET} ${REMOTE_DIR} --exclude-dir=.git; true`).stdout || null;
  report.turn.header = await headerState(app);

  // 3. Local-only surfaces.
  const panels = await app.ev(page(`
    const toggle = q('.top-actions button[aria-label="Show work panel"]')[0] || q('button[aria-label="Show work panel"]')[0];
    if (toggle) { toggle.click(); await pause(500); }
    const out = {};
    for (const label of ['Changes', 'Terminal', 'Files', 'Browser']) {
      const tab = q('.work-tabs button').find((b) => b.innerText.trim() === label);
      if (!tab) { out[label] = 'no tab'; continue; }
      tab.click();
      await pause(600);
      const body = document.querySelector('.work-panel-body') || document.querySelector('.work-panel');
      out[label] = {
        notice: text(body?.querySelector('[role="status"]')),
        terminal: Boolean(body?.querySelector('.terminal-panel, .xterm')),
        review: Boolean(body?.querySelector('.review-panel')),
        files: Boolean(body?.querySelector('.files-panel')),
      };
    }
    const close = q('button[aria-label="Hide work panel"]')[0];
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
  const ipcLocal = await app.ev("window.__baselineIpc.calls.filter((c) => /^(git_|terminal_|files_|file_)/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok }))");
  report.localOnly = { panels, native, worktreeAction: worktree, welcomeWorktreeSwitchDisabled: start.picked.worktreeSwitchDisabled, localDiskCallsAnswered: ipcLocal.filter((c) => c.ok).map((c) => c.cmd) };

  // 4. The link dies (one silent resume per conversation per run, hence up to two kills).
  report.reconnect = { kills: [] };
  const killedPids = new Set();
  for (let round = 0; round < 2; round += 1) {
    await app.ev("(window.__baselineIpc.calls = [], true)");
    const killed = sshLinks().find((l) => l.ppid === appPid) ?? null;
    let kill = null;
    if (killed) {
      killedPids.add(killed.pid);
      try { process.kill(killed.pid, "SIGKILL"); kill = "SIGKILL sent"; } catch (error) { kill = String(error.message).slice(0, 200); }
    }
    const timeline = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      const h = await headerState(app);
      const last = timeline[timeline.length - 1];
      if (!last || last.pill !== h.pill || last.reconnectButton !== h.reconnectButton || last.notice !== h.notice) timeline.push({ atMs: Date.now() - t0, ...h });
      await sleep(200);
    }
    const silent = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'resume_session').map((c) => ({ atMs: c.atMs, ok: c.ok }))");
    report.reconnect.kills.push({ killedPid: killed?.pid ?? null, parentWasApp: Boolean(killed), kill, timeline, silentResumes: silent, linksAfter: sshLinks().map((l) => ({ pid: l.pid, parentIsApp: l.ppid === appPid })), remoteAfterKill: remoteServes() });
    const now = timeline[timeline.length - 1];
    if (now?.pill === "Disconnected" && now.reconnectButton) break;
  }
  const composerState = await app.ev(page("const f = document.querySelector('textarea[aria-label=\"Message Muse\"]'); const s = document.querySelector('button.send'); return { composer: Boolean(f), sendDisabled: s ? s.disabled : null };"));
  await app.ev("(window.__baselineIpc.calls = [], true)");
  const clicked = await app.ev(page("const b = q('.top-actions button.workspace-button').find((n) => /Reconnect/.test(n.innerText)); if (b) b.click(); return Boolean(b);"));
  const t1 = Date.now();
  const up = await waitFor(async () => { const h = await headerState(app); return h.pill === "Connected" ? h : null; }, 90_000);
  await sleep(1_000);
  const resume = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'resume_session').map((c) => ({ ok: c.ok, sessionId: c.args && c.args.sessionId, workspacePath: c.args && c.args.workspacePath, result: (c.result || '').slice(0, 300) }))");
  const historyCalls = await app.ev(`window.__baselineIpc.calls.filter((c) => /session_history/.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, hasMarker: (c.result || '').includes(${JSON.stringify(MARKER)}) }))`);
  const history = await invoke(app, "read_session_history", { sessionId: sid });
  const historyText = JSON.stringify(history.value ?? history.error ?? "");
  const newLinks = sshLinks().filter((l) => l.ppid === appPid);
  const onScreen = await screenTranscript(app);
  Object.assign(report.reconnect, {
    composerWhileDisconnected: composerState,
    reconnectClicked: clicked,
    msToConnected: up ? Date.now() - t1 : null,
    reconnectedHeader: up ?? await headerState(app),
    resumeSession: resume.map((r) => ({ ...r, sameSession: r.sessionId === sid, sessionId: undefined })),
    historyReads: historyCalls,
    hostHistory: { ok: history.ok, items: historyItems(history.value), hasPrompt: historyText.includes(MARKER), hasSecretInPrompt: historyText.includes(SECRET) },
    screenAfterReconnect: { lanes: onScreen.map((b) => b.role), firstPromptShown: onScreen.some((b) => b.role === "user" && b.text.includes(MARKER)), writtenReplyShown: onScreen.some((b) => b.role === "assistant" && /WRITTEN/.test(b.text)) },
    newSshLink: newLinks.map((l) => ({ pid: l.pid, killedBefore: killedPids.has(l.pid), exe: l.exe })),
    servesAfterReconnect: remoteServes(),
  });
  const before = await logOf(app, sid);
  const assistantSoFar = before.filter((e) => e.role === "assistant" && String(e.text || "").trim()).length;
  const toolsSoFar = before.filter((e) => e.role === "tool").length;
  report.reconnect.followUp = await sendFollowUp(app, PROMPT_RECALL);
  if (report.reconnect.followUp.clicked) {
    report.liveTurns += 1;
    const recall = await waitTurn(app, sid, assistantSoFar);
    const items = historyItems((await invoke(app, "read_session_history", { sessionId: sid })).value);
    const lastTurn = items.at(-1)?.turn ?? null;
    report.reconnect.recall = { ...recall, toolCallsThisTurn: (recall.toolCount ?? toolsSoFar) - toolsSoFar, hostItemsThisTurn: lastTurn === null ? null : items.filter((i) => i.turn === lastTurn).map((i) => i.kind), tools: undefined };
  }

  // 5. One failed start per cause.
  report.failures = [];
  for (const failure of FAILURES) {
    const target = { ...TARGET, ...failure.form };
    const settings = await saveTarget(app, target);
    const knownBefore = proofKnownHosts();
    const userBefore = userKnownHosts();
    const attempt = await startOnRemote(app, `M4-07 failure probe (${failure.cause}): reply OK.`);
    await sleep(500);
    const banner = await app.ev(page("return { banner: text(document.querySelector('.error-banner span')), restartOffered: q('.error-banner button').map((b) => text(b)) };"));
    const knownAfter = proofKnownHosts();
    report.failures.push({
      cause: failure.cause, target: { ...failure.form }, settingsStatus: settings.status, storedTarget: settings.stored,
      startArgsWorkspacePath: attempt.args?.workspacePath ?? null, startOk: attempt.ok, ms: attempt.ms, error: attempt.result, ...banner,
      matchesExpected: new RegExp(failure.expect).test(banner.banner ?? ""),
      proofKnownHostsByteIdentical: JSON.stringify(knownBefore) === JSON.stringify(knownAfter),
      userKnownHostsUnchanged: JSON.stringify(userBefore) === JSON.stringify(userKnownHosts()),
      appSshLinksAfter: sshLinks().filter((l) => l.ppid === appPid).length,
    });
    if (attempt.ok) report.liveTurns += 1;
  }
  report.knownHostsAfter = { proof: proofKnownHosts(), user: userKnownHosts() };
  report.consoleErrors = app.errors.slice(0, 20);
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 400);
} finally {
  // 6. The app closes from its window; nothing of the link may remain.
  report.beforeClose = { appSshLinks: appPid === null ? null : sshLinks().filter((l) => l.ppid === appPid).length, serves: remoteServes() };
  report.appClose = inst ? await inst.stop() : null;
  report.afterClose = await waitFor(async () => {
    const serves = remoteServes();
    return sshLinks().length === 0 && serves.ours?.length === 0 ? { sshLinks: 0, serves } : null;
  }, 30_000, 2_000) ?? { sshLinks: sshLinks().length, serves: remoteServes() };
  // Other proof instances may run their own engines on this Mac: only a count of them, never their paths.
  const pgrep = remote("pgrep -f '[m]use-bin serve' | wc -l");
  report.afterClose.pgrep = { command: "pgrep -f '[m]use-bin serve' | wc -l", allMuseServesOnTheMac: Number(pgrep.stdout || 0), oursByWorkingFolder: report.afterClose.serves?.ours?.length ?? null };
  if ((report.afterClose.serves?.ours ?? []).length > 0) report.limits.push("A remote `muse serve` outlived the app by more than 30 s: per ADR 0002 it is sshd's to end, once sshd notices the dead link.");
  report.sshd = { log: sshdLog.filter((l) => /Accepted|Failed|Invalid|refused|Connection closed|Disconnected/i.test(l)).slice(0, 40) };
  sshd.kill("SIGTERM");
  await waitFor(() => sshd.exitCode !== null || sshd.signalCode !== null, 5_000, 100);
  report.sshd.stopped = sshd.exitCode !== null || sshd.signalCode !== null;
  rmSync(REMOTE_DIR, { recursive: true, force: true });
  report.remoteFolderDeleted = !existsSync(REMOTE_DIR);
  rmSync(SSHD, { recursive: true, force: true });
  report.proofKeysDeleted = !existsSync(SSHD);
}

const r = report;
const engines = Array.isArray(r.start?.hostEngines) ? r.start.hostEngines : [];
const kills = r.reconnect?.kills ?? [];
r.verdicts = {
  "0 isolated test instance": r.isolation?.defaultStoresUnchangedAtStart === true && r.isolation?.testMode === true && r.appClose?.defaultStoresUnchangedAtEnd === true,
  "1 target saved from the form": JSON.stringify(r.start?.settings?.stored) === JSON.stringify(TARGET) && /Saved/.test(r.start?.settings?.status ?? ""),
  "1 new conversation started on the ssh:// key": r.start?.ok === true && r.start?.args?.workspacePath === KEY && r.start?.storedConversationWorkspace === KEY,
  "1 app drove the system OpenSSH as its child": (r.start?.sshLink ?? []).length === 1 && r.start.sshLink[0].parentIsApp && r.start.sshLink[0].exe === "/usr/bin/ssh" && (r.start.wrapperLog ?? []).some((w) => w.pid === r.start.sshLink[0].pid),
  "1 handshake: engine 1.4.2 on macos": engines.length === 1 && engines[0].serverVersion === "1.4.2" && /mac|darwin/i.test(engines[0].platform ?? ""),
  "2 live turn completed": Boolean(r.turn && !r.turn.timedOut && (r.turn.failed ?? []).length === 0),
  "2 file written on the remote host": r.turn?.remoteFile?.content === MARKER,
  "3 Changes/Terminal/Files unavailable": ["Changes", "Terminal", "Files"].every((p) => /Not available for remote conversations/.test(r.localOnly?.panels?.[p]?.notice ?? "")),
  "3 native git/terminal/files refuse": Object.values(r.localOnly?.native ?? {}).length === 3 && Object.values(r.localOnly.native).every((e) => /Not available for remote conversations/.test(e)),
  "3 worktree actions disabled": r.localOnly?.worktreeAction?.disabled === true && /^Not available for remote conversations/.test(r.localOnly?.worktreeAction?.title ?? "") && r.localOnly?.welcomeWorktreeSwitchDisabled === true,
  "4 honest disconnected state": kills.some((k) => k.timeline.some((t) => t.pill === "Disconnected" && t.reconnectButton)),
  "4 reconnect resumes the same session over a new link": (r.reconnect?.resumeSession ?? []).some((c) => c.ok && c.sameSession) && (r.reconnect?.newSshLink ?? []).length === 1 && r.reconnect.newSshLink[0].killedBefore === false,
  "4 history read back from the host": r.reconnect?.hostHistory?.hasPrompt === true && (r.reconnect?.historyReads ?? []).some((c) => c.ok) && r.reconnect?.screenAfterReconnect?.firstPromptShown === true,
  "4 second code recalled with no tool call": (r.reconnect?.recall?.last ?? "").includes(SECRET) && r.reconnect?.recall?.toolCallsThisTurn === 0 && (r.reconnect?.recall?.approvals ?? []).length === 0
    && Array.isArray(r.reconnect?.recall?.hostItemsThisTurn) && !r.reconnect.recall.hostItemsThisTurn.some((kind) => /tool|shell/i.test(String(kind))) && r.turn?.secretInWorkspace === null,
  "5 errors honest": (r.failures ?? []).length === 4 && r.failures.every((f) => f.startOk === false && f.matchesExpected && f.appSshLinksAfter <= 1),
  "5 host key never accepted": (r.failures ?? []).every((f) => f.proofKnownHostsByteIdentical && f.userKnownHostsUnchanged) && JSON.stringify(r.knownHostsAfter?.proof) === JSON.stringify(r.preflight?.proofKnownHosts) && JSON.stringify(r.knownHostsAfter?.user) === JSON.stringify(r.preflight?.userKnownHosts),
  "6 closed gracefully": r.appClose?.quitBy === "window closed" && (r.appClose?.leftAfterQuit ?? []).length === 0,
  "6 no orphan after close": r.afterClose?.sshLinks === 0 && r.afterClose?.serves?.ours?.length === 0,
  liveTurns: r.liveTurns,
  consoleErrors: (r.consoleErrors ?? []).length,
};
r.passed = Object.entries(r.verdicts).filter(([k]) => /^\d/.test(k)).every(([, v]) => v === true) && !r.failure;
const redact = redactor([[RUN, "<proof>"], [BASE, "<proofs>"], [homedir(), "<home>"]]);
const text = JSON.stringify(redact(r), null, 2).replace(new RegExp(`\\b${USER}\\b`, "g"), "<user>");
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${text}\n`);
console.log(JSON.stringify({ verdicts: JSON.parse(text).verdicts, failure: r.failure ?? null }, null, 2));
process.exit(r.passed ? 0 : 1);
