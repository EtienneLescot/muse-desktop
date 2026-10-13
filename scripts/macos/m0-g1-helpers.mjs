/**
 * Helpers of the macOS group 1 proofs (M0-01, M0-02, M0-03, M0-04, M0-09):
 * the record header, the redaction, the engine hosts of one app and a few
 * conversation probes. Every instance still comes from launch()
 * (scripts/macos/test-instance.mjs); nothing here starts or isolates an app.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { processTree } from "./test-instance.mjs";

export const COMMIT = "08b291d";
export const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", COMMIT, "muse-desktop")));
export const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g1")));
export const OUT_DIR = "docs/evidence/2026-10-13-macos-closure";
export const J = JSON.stringify;

export function platform() {
  const sw = execFileSync("sw_vers", { encoding: "utf8" });
  const field = (name) => sw.match(new RegExp(`${name}:\\s*(.+)`))?.[1]?.trim();
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  return `${field("ProductName")} ${field("ProductVersion")} (${field("BuildVersion")}), ${arch}, Apple Silicon; debug build ${COMMIT} with embedded frontend, WKWebView through the test bridge (src-tauri/src/test_bridge.rs)`;
}

const real = (path) => { try { return realpathSync(path); } catch { return path; } };
export const redact = redactor([
  [BASE, "<proof>"], [real(BASE), "<proof>"],
  [tmpdir(), "<tmp>"], [real(tmpdir()), "<tmp>"],
  [homedir(), "<home>"],
]);

/** Writes the record, redacted, and returns it. */
export function writeRecord(name, record) {
  const path = join(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  const clean = redact(record);
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

/** The engine hosts (muse-bin serve) under the app, with their working directory. */
export function hosts(appPid) {
  return processTree(appPid).filter((p) => /muse-bin\b.*\bserve\b/.test(p.command)).map((p) => {
    let cwd = null;
    try {
      cwd = execFileSync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { encoding: "utf8" })
        .split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
    } catch { /* gone */ }
    return { pid: p.pid, ppid: p.ppid, cwd, command: p.command.replace(/^.*\//, "").slice(0, 120) };
  });
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every muse-desktop / muse-bin process on the machine (to check that none of ours is left). */
export function leftovers() {
  try {
    return execFileSync("pgrep", ["-fl", "muse-desktop|muse-bin"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return []; }
}

/** Opens a conversation from the sidebar and waits until it is the active one. */
export async function openSession(app, sid) {
  const clicked = await app.ev(`(() => { const b = document.querySelector('.session-item[data-session-id=${J(sid)}] .session-select'); if (!b) return false; b.click(); return true; })()`);
  if (!clicked) return false;
  return Boolean(await waitFor(() => app.ev(`Boolean(document.querySelector('.session-item.active[data-session-id=${J(sid)}]') && document.querySelector('textarea[aria-label="Message Muse"]'))`), 15_000, 200));
}

/** Types into the conversation composer as a user does (insertText), then optionally presses Enter. */
export async function typeInComposer(app, text, { enter = true } = {}) {
  await app.ev(`(document.querySelector('textarea[aria-label="Message Muse"]')?.focus(), true)`);
  await app.send("Input.insertText", { text });
  const typed = await waitFor(() => app.ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value === ${J(text)}`), 10_000, 100);
  if (!typed) return false;
  if (enter) await pressEnter(app);
  return true;
}

export async function pressEnter(app) {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
}

/** A trusted mouse click at the centre of the first element matching `selector`. */
export async function clickSelector(app, selector, { clickCount = 1 } = {}) {
  const box = await app.ev(`(() => { const n = document.querySelector(${J(selector)}); if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) return false;
  for (let i = 1; i <= clickCount; i++) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: i });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: i });
  }
  return true;
}

/** What the active conversation shows. */
export const view = (app) => app.ev(`(() => {
  const meta = document.querySelector('.task-metadata');
  const composer = document.querySelector('textarea[aria-label="Message Muse"]');
  const stop = [...document.querySelectorAll('button[title="Stop the current turn"]')][0];
  // textContent: a message offscreen under content-visibility: auto is not in innerText.
  const body = (document.querySelector('main.conversation')?.textContent || '').replace(/\\s+/g, ' ');
  return {
    sid: document.querySelector('.session-item.active')?.dataset.sessionId ?? null,
    title: document.querySelector('main.conversation h1')?.innerText ?? null,
    state: meta ? (/Working/.test(meta.innerText) ? 'Working' : /Ready/.test(meta.innerText) ? 'Ready' : null) : null,
    connection: document.querySelector('.connection-state')?.innerText.trim() ?? null,
    notice: document.querySelector('.connection-notice')?.innerText.slice(0, 300) ?? null,
    reconnect: [...document.querySelectorAll('button[title="Reconnect this saved conversation to its workspace engine"]')].map((b) => b.innerText.trim()),
    composer: composer ? { value: composer.value, disabled: composer.disabled } : null,
    stop: stop ? { text: stop.innerText.trim(), disabled: stop.disabled } : null,
    hostEndedLine: body.includes('Muse stopped because the host process ended'),
  };
})()`);

/** The stored transcript of one conversation. */
export const transcript = (app, sid) => app.ev(`JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${J(sid)}) || '[]')`);

/** Running flag of every sidebar row. */
export const sidebar = (app) => app.ev(`[...document.querySelectorAll('.session-item[data-session-id]')].map((li) => ({ sid: li.dataset.sessionId, running: li.querySelector('.dot')?.dataset.running === 'true', title: li.querySelector('.session-title')?.innerText ?? null }))`);

export const assistantHas = async (app, sid, token) => (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text ?? "").includes(token));

/** IPC calls recorded by INSTALL_IPC_TRACE, filtered by command. */
export const calls = (app, cmd) => app.ev(`(window.__baselineIpc?.calls || []).filter((c) => c.cmd === ${J(cmd)})`);

export const now = () => new Date().toISOString();
export { sleep, waitFor };
