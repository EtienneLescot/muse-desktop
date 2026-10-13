/**
 * Terminal-panel plumbing shared by the native macOS proofs of M1-05 and M1-06
 * (scripts/macos/m1-05-terminal.mjs, scripts/macos/m1-06-terminal-context.mjs).
 * Not a scenario.
 *
 * - `INSTALL_TERMINAL_TAPS`: page-side taps above the shared IPC trace (which
 *   keeps 400 calls while the panel polls terminal_read every 180 ms): the raw
 *   terminal_read stream and read count per terminal id, every terminal_open
 *   answer and terminal_close outcome. Both IPC URL forms (WKWebView
 *   ipc://localhost, WebView2 http://ipc.localhost).
 * - the panel driven as a user would: the real input, Input.insertText, a real
 *   Enter (an AppKit key event through the bridge), Ctrl shortcuts as AppKit
 *   key events with the Control flag.
 * - process facts by PID and start time (`ps -o lstart`): a PID only counts as
 *   the same process with the same start stamp.
 */
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { INSTALL_IPC_TRACE, sleep, waitFor } from "../cdp-harness.mjs";

export const INSTALL_TERMINAL_TAPS = `(() => {
  if (window.__tmTaps) return 'already';
  const taps = window.__tmTaps = { raw: {}, reads: {}, opens: [], closes: [] };
  const inner = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const ipc = url.match(/^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/(terminal_read|terminal_open|terminal_close)/);
    if (!ipc) return inner(input, init);
    const t0 = Date.now();
    const response = await inner(input, init);
    const ok = response.headers.get('Tauri-Response') === 'ok';
    try {
      const value = JSON.parse(await response.clone().text());
      if (ipc[1] === 'terminal_read' && ok && value && typeof value.terminalId === 'string') {
        taps.raw[value.terminalId] = (taps.raw[value.terminalId] || '') + (value.output || '');
        taps.reads[value.terminalId] = (taps.reads[value.terminalId] || 0) + 1;
        if (value.done) taps.done = Object.assign(taps.done || {}, { [value.terminalId]: true });
      }
      if (ipc[1] === 'terminal_open') taps.opens.push(ok ? { ...value, ms: Date.now() - t0 } : { error: String(value).slice(0, 300) });
      if (ipc[1] === 'terminal_close') taps.closes.push({ ok, error: ok ? null : String(value).slice(0, 300) });
    } catch { /* not JSON */ }
    return response;
  };
  return 'installed';
})()`;

/** Strip the escape sequences and carriage returns a terminal would interpret. */
export function plain(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHM]/g, "")
    .replace(/\r/g, "");
}

export const replacements = (s) => String(s).split("�").length - 1;
export function loneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) i++;
    else if (c >= 0xd800 && c <= 0xdfff) n++;
  }
  return n;
}

/** A driver bound to one app page. */
export function terminalDriver(app) {
  const t = {
    current: null,
    async install() {
      await app.ev(INSTALL_IPC_TRACE);
      await app.ev(INSTALL_TERMINAL_TAPS);
    },
    dom: async () => (await app.ev("document.querySelector('pre.terminal-output')?.textContent ?? null")) ?? "",
    taps: () => app.ev("({ opens: window.__tmTaps.opens, closes: window.__tmTaps.closes, reads: window.__tmTaps.reads, done: window.__tmTaps.done || {} })"),
    async rawLength() {
      return t.current ? app.ev(`(window.__tmTaps.raw[${JSON.stringify(t.current)}] || '').length`) : 0;
    },
    async rawSince(from) {
      return t.current ? app.ev(`(window.__tmTaps.raw[${JSON.stringify(t.current)}] || '').slice(${from})`) : "";
    },
    async workTab(label) {
      return app.ev(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        if (!document.querySelector('nav.work-tabs')) { document.querySelector('button[aria-label="Show work panel"]')?.click(); await pause(500); }
        const tab = [...document.querySelectorAll('nav.work-tabs button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
        if (!tab) return false;
        tab.click();
        await pause(400);
        return true;
      })()`);
    },
    /** Opens the Terminal tab and waits for a new terminal_open answer (or the live one). */
    async openPanel() {
      const before = (await t.taps()).opens.length;
      await t.workTab("Terminal");
      const opened = await waitFor(async () => {
        const list = (await t.taps()).opens;
        return list.length > before ? list.at(-1) : null;
      }, 20_000, 200);
      if (opened && !opened.error) t.current = opened.terminalId;
      return opened;
    },
    /**
     * Shows the Terminal tab of the active conversation `sid` and binds the
     * driver to that conversation's terminal (the panel may already have
     * opened it when the conversation was selected).
     */
    async attach(sid) {
      await t.workTab("Terminal");
      const opened = await waitFor(async () => {
        const mine = (await t.taps()).opens.filter((o) => o.sessionId === sid);
        return mine.at(-1) ?? null;
      }, 20_000, 200);
      if (opened && !opened.error) t.current = opened.terminalId;
      return opened;
    },
    async focusInput() {
      return app.ev("(() => { const i = document.querySelector('form.terminal-input input'); if (!i) return false; i.focus(); return document.activeElement === i; })()");
    },
    inputValue: () => app.ev("document.querySelector('form.terminal-input input')?.value ?? null"),
    async key(key, code, modifiers = 0) {
      await t.focusInput();
      await app.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
      await sleep(150);
    },
    ctrl: (letter) => t.key(letter, `Key${letter.toUpperCase()}`, 2),
    /** Types a line in the panel's input and presses a real Enter. */
    async typeLine(line) {
      await t.focusInput();
      await app.send("Input.insertText", { text: line });
      const took = await waitFor(async () => (await t.inputValue()) === line, 5_000, 50);
      await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
      const cleared = await waitFor(async () => (await t.inputValue()) === "", 5_000, 50);
      t.lastTyped = { line, inputBeforeEnter: took ? line : await t.inputValue(), sent: Boolean(took && cleared) };
      return Boolean(took && cleared);
    },
    /** Type a line and wait until the plain PTY text added since then satisfies `until`. */
    async run(line, until, timeoutMs = 10_000) {
      const from = await t.rawLength();
      const sent = await t.typeLine(line);
      const typed = t.lastTyped;
      const raw = await waitFor(async () => {
        const added = await t.rawSince(from);
        return until(plain(added), added) ? added : null;
      }, timeoutMs, 200);
      await sleep(200);
      const all = await t.rawSince(from);
      return { sent, typed, ok: Boolean(raw), added: plain(all), raw: all };
    },
    /** Wait until the plain PTY text added since `from` satisfies `until`. */
    async until(from, until, timeoutMs = 10_000) {
      const raw = await waitFor(async () => {
        const added = await t.rawSince(from);
        return until(plain(added), added) ? added : null;
      }, timeoutMs, 200);
      return { ok: Boolean(raw), added: plain(await t.rawSince(from)) };
    },
    sizeLabel: () => app.ev("document.querySelector('.terminal-size')?.textContent ?? null"),
  };
  return t;
}

/** One process by PID: its start stamp and command, or null. */
export function proc(pid) {
  try {
    const line = execFileSync("ps", ["-o", "pid=,ppid=,pgid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4], command: m[5] } : null;
  } catch {
    return null;
  }
}
/** Whether that exact process (same PID, same start stamp) is still alive. */
export const sameAlive = (p) => Boolean(p && proc(p.pid)?.started === p.started);

/** Every process under `root` (ps), with start stamps. */
export function descendants(root) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && r[0] > 0);
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [pid, ppid] of rows) if (ppid === parent && !out.includes(pid)) { out.push(pid); queue.push(pid); }
  }
  return out.map(proc).filter(Boolean);
}

/** The shells the app spawned directly, newest last. */
export const shellsOf = (appPid) => descendants(appPid).filter((p) => p.ppid === appPid && /(^|\/)-?zsh(\s|$)|(^|\/)bash(\s|$)|(^|\/)sh(\s|$)/.test(p.command));

export function platform() {
  const v = (k) => execFileSync("sw_vers", [k], { encoding: "utf8" }).trim();
  return `macOS ${v("-productVersion")} (${v("-buildVersion")}), ${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()}, Apple Silicon; debug build 08b291d with embedded frontend, WKWebView through the test bridge (src-tauri/src/test_bridge.rs)`;
}

/** Path redaction for the records: proof folder, temp folder (both spellings), home. */
export function redactPaths(pairs) {
  const forms = [];
  for (const [path, label] of pairs) {
    const real = (() => { try { return realpathSync(path); } catch { return path; } })();
    for (const p of new Set([path, real, real.replace(/^\/private/, "")])) forms.push([p.replace(/\/+$/, ""), label]);
  }
  const tmp = tmpdir().replace(/\/+$/, "");
  const tmpReal = (() => { try { return realpathSync(tmp); } catch { return tmp; } })();
  forms.push([tmpReal, "<tmp>"], [tmp, "<tmp>"], [homedir(), "<home>"]);
  forms.sort((a, b) => b[0].length - a[0].length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (value) => {
    let text = JSON.stringify(value);
    for (const [form, label] of forms) text = text.replace(new RegExp(esc(form), "g"), label);
    return JSON.parse(text);
  };
}

/** Port answering? A refused connection means nothing listens any more. */
export async function request(port, path) {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
    return { path, status: response.status, body: await response.text(), ms: Date.now() - started };
  } catch (error) {
    return { path, error: String(error?.cause?.code ?? error?.name ?? error), ms: Date.now() - started };
  }
}
