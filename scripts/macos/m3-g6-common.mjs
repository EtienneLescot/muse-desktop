/**
 * Shared plumbing of the macOS M3 proofs (group G6: M3-01, M3-02, M3-03,
 * M3-04, M3-05, M3-08). Not a scenario. On top of test-instance.mjs (the
 * isolated instance) and cdp-harness.mjs (CDP, IPC trace):
 *
 * - the fingerprint of the user's own engine settings and extensions
 *   (~/.config/muse, ~/.local/share/muse/{plugins,skills}), taken before and
 *   after every proof: a test instance must not write there;
 * - the platform line (sw_vers, arch) and the record writer, which replaces
 *   the proof folder and the home folder by labels and refuses any secret;
 * - page helpers evaluated in the webview (setValue, nav, Extensions,
 *   Settings > default folder, posture, a new project conversation whose
 *   first message the harness refuses, so no turn is spent on it).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, arch } from "node:os";
import { dirname, join } from "node:path";
import { INSTALL_IPC_TRACE, sleep, waitFor } from "../cdp-harness.mjs";
import { treeStamp } from "./test-instance.mjs";

export { sleep, waitFor };
export const J = JSON.stringify;
export const EXE_DEFAULT = join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop");
export const COMMIT = "08b291d";
export const sha12 = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 12);

/** The user's engine settings and extensions: every file with size and mtime. */
export const USER_ENGINE_DIRS = [
  join(homedir(), ".config", "muse"),
  join(homedir(), ".local", "share", "muse", "plugins"),
  join(homedir(), ".local", "share", "muse", "skills"),
];
export function userEngineStamp() {
  const files = treeStamp(USER_ENGINE_DIRS);
  return { files: Object.keys(files).length, digest: sha12(J(Object.entries(files).sort())), raw: files };
}
/** before/after comparison, path-free: counts and the changed file names under each root. */
export function compareStamps(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before.raw), ...Object.keys(after.raw)])) {
    if (before.raw[path] !== after.raw[path]) changed.push(path.replace(homedir(), "~"));
  }
  return { before: { files: before.files, digest: before.digest }, after: { files: after.files, digest: after.digest }, unchanged: changed.length === 0, changed };
}

export function platform() {
  const v = (flag) => { try { return execFileSync("sw_vers", [flag], { encoding: "utf8" }).trim(); } catch { return "?"; } };
  return `macOS ${v("-productVersion")} (${v("-buildVersion")}), ${arch()}, Apple Silicon; debug build ${COMMIT} with embedded frontend, WKWebView through the test bridge (src-tauri/src/test_bridge.rs)`;
}

/** Labels for the proof folder and the home folder, in every spelling macOS gives them. */
export function redactorFor(base) {
  const pairs = [];
  // Longest first: /private/var/... before /var/..., so no "/private" is left in front of a label.
  for (const path of [base.replace(/^\/var\//, "/private/var/"), base]) pairs.push([path, "<proof>"]);
  pairs.push([homedir(), "~"]);
  return (value, secrets = []) => {
    let text = J(value);
    for (const secret of secrets) if (secret && text.includes(secret)) throw new Error("refusing to record: a secret reached the record");
    for (const [path, label] of pairs) text = text.split(path).join(label);
    // A temp root of another spelling (e.g. $TMPDIR without the trailing slash).
    text = text.replace(/\/(?:private\/)?var\/folders\/[^"/]+\/[^"/]+\/T\//g, "<tmp>/");
    return JSON.parse(text);
  };
}

export function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${J(record, null, 2)}\n`);
}

/** Processes whose command line mentions `needle` (the proof folder), for the end-of-run check. */
export function processesMentioning(needle) {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 })
    .split("\n").filter((line) => line.includes(needle) && !line.includes("ps -axo")).map((line) => line.trim().slice(0, 200));
}

/** Page helpers, evaluated inside the webview. */
export const H = `
  const vis = (n) => n && n.offsetParent !== null;
  const q = (s, root) => [...(root || document).querySelectorAll(s)].filter(vis);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (n) => n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  const setValue = (el, v) => {
    const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return null; } };
  const nav = (label) => { const b = document.querySelector('.primary-nav button[aria-label="' + label + '"]'); if (b) b.click(); return !!b; };
  const button = (label, root) => q('button', root).find((b) => (b.innerText || '').trim() === label && !b.disabled) || null;
  const banners = () => [...document.querySelectorAll('.error-banner')].map((n) => text(n));
  const connectors = () => store('muse-desktop.connectors.v1', '[]') || [];
  const connectorRow = (name) => [...document.querySelectorAll('[aria-label="Connectors"] li.integration-row')]
    .find((li) => (li.querySelector('strong')?.childNodes[0]?.textContent || '').trim() === name) || null;
  const activeSid = () => document.querySelector('li.session-item.active')?.getAttribute('data-session-id') || null;
  const sessionRow = (sid) => document.querySelector('li.session-item[data-session-id="' + sid + '"]');
  const runningOf = (sid) => sessionRow(sid)?.querySelector('.dot')?.getAttribute('data-running') || null;
  const logOf = (sid) => store('muse-desktop.log.v1.' + sid, '[]') || [];
`;
export const page = (body) => `(async () => { ${H} ${body} })()`;

export async function installTrace(app) {
  return app.ev(INSTALL_IPC_TRACE);
}
export const ipcCalls = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => ${cmd ? `c.cmd === ${J(cmd)}` : "true"})`);

export async function openExtensions(app) {
  const ok = await app.ev(page(`
    nav('Extensions');
    for (let i = 0; i < 40 && !document.querySelector('[aria-label="Connectors"]'); i++) await pause(100);
    return Boolean(document.querySelector('[aria-label="Connectors"]'));
  `));
  if (!ok) throw new Error("Extensions page not reached");
}

/** Settings > Choose/Change folder, the folder dialog answered by the IPC trace. */
export async function pickDefaultFolder(app, folder) {
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${J(folder)}), true)`);
  return app.ev(page(`
    document.querySelector('.primary-nav button[aria-label="Settings"], .sidebar-footer button[aria-label="Settings"]')?.click();
    await pause(700);
    const b = q('.workspace-picker button.workspace-button')[0];
    if (!b) return { clicked: false };
    b.click();
    for (let i = 0; i < 40 && store('muse-desktop.workspace.v1', 'null') !== ${J(folder)}; i++) await pause(100);
    return { clicked: true, stored: store('muse-desktop.workspace.v1', 'null') === ${J(folder)},
      setWorkspace: window.__baselineIpc.calls.filter((c) => c.cmd === 'set_workspace').at(-1)?.ok ?? null };
  `));
}

/** The composer's posture menu ("Ask for approval", "Ask only for more access", "YOLO"). */
export async function setPosture(app, mode) {
  const label = { ask: "Ask for approval", workspace: "Ask only for more access", yolo: "YOLO" }[mode];
  return app.ev(page(`
    if (!document.querySelector('button[role="menuitemradio"]')) { nav('New conversation'); await pause(1200); }
    const item = [...document.querySelectorAll('button[role="menuitemradio"]')]
      .find((b) => (b.querySelector('strong')?.textContent || '').trim() === ${J(label)});
    if (!item) return { clicked: false };
    item.click();
    await pause(600);
    return { clicked: true, stored: localStorage.getItem('muse-desktop.authorization-mode.v1') };
  `));
}

/**
 * A new conversation in `folder` (added as a project from the welcome screen,
 * the folder dialog answered), started with its first message refused by the
 * harness: start_session runs (the host loads the folder, its skills and the
 * MCP servers of Use in Muse), but no turn is sent. Returns the start_session
 * call (args and session id).
 */
export async function startConversationNoTurn(app, folder, { projectName = null } = {}) {
  const before = (await ipcCalls(app, "start_session")).length;
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  try {
    const started = await app.ev(page(`
      nav('New conversation');
      let picker = null;
      for (let i = 0; i < 50 && !picker; i++) { picker = document.querySelector('details.project-picker-control'); if (!picker) await pause(100); }
      if (!picker) return { started: false, reason: 'no project picker' };
      picker.open = true;
      await pause(300);
      const known = ${J(projectName)} ? [...document.querySelectorAll('.project-option')].find((b) => text(b.querySelector('strong')) === ${J(projectName)}) : null;
      if (known) known.click();
      else {
        window.__baselineIpc.dialogQueue.push(${J(folder)});
        document.querySelector('.project-option-new')?.click();
      }
      let note = '';
      for (let i = 0; i < 80; i++) { note = text(document.querySelector('.welcome-project-note')) || ''; if (note.startsWith('Runs in')) break; await pause(100); }
      if (!note.startsWith('Runs in')) return { started: false, reason: 'project not selected: ' + note };
      setValue(document.querySelector('textarea[aria-label="Your first message"]'), 'Setup message, refused by the test harness (no turn).');
      await pause(300);
      const start = document.querySelector('button.welcome-send');
      if (!start || start.disabled) return { started: false, reason: 'start disabled' };
      start.click();
      return { started: true, note };
    `));
    if (!started.started) throw new Error(`could not start the conversation: ${started.reason}`);
    const call = await waitFor(async () => {
      const list = await ipcCalls(app, "start_session");
      return list.length > before && list.at(-1).result !== undefined ? list.at(-1) : null;
    }, 90_000, 300);
    if (!call?.ok) throw new Error(`start_session failed: ${J(call?.result ?? null).slice(0, 300)}`);
    const meta = JSON.parse(call.result);
    await sleep(800);
    const sends = (await ipcCalls(app, "send_input")).map((c) => ({ blockedByHarness: c.blockedByHarness === true }));
    return { sid: meta.session_id, args: call.args, approvalMode: meta.approval_mode ?? null, firstMessageSends: sends, note: started.note };
  } finally {
    await app.ev("(window.__baselineIpc.block = [], true)");
  }
}

/** Types into the conversation composer and presses Enter (real key events). */
export async function sendInConversation(app, sid, text) {
  const ready = await app.ev(page(`
    if (activeSid() !== ${J(sid)}) { sessionRow(${J(sid)})?.querySelector('button.session-select')?.click(); await pause(800); }
    if (activeSid() !== ${J(sid)}) return { ready: false, reason: 'conversation not active' };
    const box = document.querySelector('textarea[aria-label="Message Muse"]');
    if (!box) return { ready: false, reason: 'no composer' };
    setValue(box, '');
    box.focus();
    return { ready: true };
  `));
  if (!ready.ready) throw new Error(`cannot send: ${ready.reason}`);
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('textarea[aria-label="Message Muse"]'); return b && b.value === ${J(text)}; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
}

/**
 * Until the turn of `sid` ends. Approval cards are answered with the narrowest
 * allow (once / this turn) unless `deny` is set. Returns the stored transcript.
 */
export async function waitTurn(app, sid, { timeoutMs = 300_000, deny = false } = {}) {
  const t0 = Date.now();
  const approvals = [];
  let sawRunning = false;
  const done = await waitFor(async () => {
    const v = await app.ev(page(`
      const log = logOf(${J(sid)});
      return { running: runningOf(${J(sid)}), cards: q('.approvals .approval').length, open: log.some((e) => e.open),
        assistant: log.some((e) => e.role === 'assistant' && String(e.text || '').trim()) };
    `));
    if (v.running === "true") sawRunning = true;
    if (v.cards > 0) {
      const card = await app.ev(page("return text(q('.approvals .approval')[0])?.slice(0, 400) ?? null;"));
      const labels = await app.ev(page("return q('.approvals .approval')[0] ? [...q('.approvals .approval')[0].querySelectorAll('.approval-actions button')].map((b) => b.innerText.trim()) : [];"));
      const pick = deny ? labels.find((l) => /deny|decline|reject|don.t/i.test(l)) : (labels.find((l) => /once|this turn/i.test(l)) ?? labels.find((l) => /^allow|^approve|^yes/i.test(l)));
      if (pick) {
        await app.ev(page(`const b = q('.approvals .approval-actions button').find((n) => n.innerText.trim() === ${J(pick)}); if (b) b.click(); return !!b;`));
        approvals.push({ card, choices: labels, clicked: pick });
        await sleep(1_500);
      }
      return null;
    }
    return (sawRunning || Date.now() - t0 > 20_000) && v.running === "false" && !v.open && v.assistant ? v : null;
  }, timeoutMs, 1_000);
  const entries = await app.ev(page(`return logOf(${J(sid)}).map((e) => ({ role: e.role, text: String(e.text || '').slice(0, 2000) }));`));
  return { finished: Boolean(done), ms: Date.now() - t0, approvals, entries };
}
