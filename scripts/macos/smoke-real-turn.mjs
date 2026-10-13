#!/usr/bin/env node
/**
 * The smallest native macOS proof, and the template of the others: one
 * isolated instance (scripts/macos/test-instance.mjs) on the pinned engine, a
 * project created from the welcome screen (the folder dialog answered by the
 * IPC trace), a first message typed and sent with a real Enter, the model's
 * reply in the stored transcript and on screen, then Cmd+Q.
 *
 *   node scripts/macos/smoke-real-turn.mjs --exe ~/muse-proofs/app/<commit>/muse-desktop [--port 9401] [--base <dir>]
 *
 * One live turn. Prints the record as JSON.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSTALL_IPC_TRACE, argValue, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9401"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-smoke")));
const ID = Date.now().toString(36);
const TOKEN = `PONG-MAC-${ID.toUpperCase()}`;

/** Welcome screen -> New conversation -> project from a folder (dialog answered) -> composer focused. */
export async function newProjectConversation(app, folder) {
  await waitFor(() => app.ev(`document.querySelectorAll('.primary-nav button[aria-label="New conversation"]').length > 0`), 60_000);
  await app.ev(INSTALL_IPC_TRACE);
  await app.ev(`(window.__baselineIpc.dialogQueue.push(${JSON.stringify(folder)}), true)`);
  return app.ev(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (p, ms = 8000) => { for (let t = 0; t < ms && !p(); t += 100) await wait(100); return p(); };
    document.querySelector('.primary-nav button[aria-label="New conversation"]').click();
    const picker = await until(() => document.querySelector('details.project-picker-control'));
    if (!picker) return 'no project picker';
    picker.open = true;
    (await until(() => document.querySelector('.project-option-new')))?.click();
    if (!(await until(() => (document.querySelector('.welcome-project-note')?.innerText || '').length > 0))) return 'no project';
    document.querySelector('textarea[aria-label="Your first message"]').focus();
    return 'ready';
  })()`);
}

/** Types `text` and presses Enter, as a user would; returns the new session id. */
export async function sendFirstMessage(app, text) {
  await app.send("Input.insertText", { text });
  // React takes the text on its input event: Enter before that sends nothing.
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button.welcome-send'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  return waitFor(async () => {
    const call = (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'start_session')")).at(-1);
    return call?.ok ? JSON.parse(call.result).session_id : null;
  }, 60_000);
}

/** The stored transcript of one conversation. */
export const transcript = (app, sid) => app.ev(`JSON.parse(localStorage.getItem('muse-desktop.log.v1.' + ${JSON.stringify(sid)}) || '[]')`);

if (import.meta.url === `file://${process.argv[1]}`) {
  const project = join(BASE, `project-${ID}`);
  mkdirSync(project, { recursive: true });
  const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `data-${ID}`) });
  const record = { schema: "muse-desktop.macos-smoke-real-turn.v1", engine: inst.engineVersion, isolation: inst.isolation, liveTurns: 1 };
  try {
    record.start = await newProjectConversation(inst.app, project);
    record.sid = await sendFirstMessage(inst.app, `Reply with exactly ${TOKEN} and nothing else.`);
    record.replyStored = Boolean(await waitFor(async () => (await transcript(inst.app, record.sid)).some((e) => e.role === "assistant" && String(e.text).includes(TOKEN)), 180_000, 1_000));
    record.replyOnScreen = await inst.app.ev(`[...document.querySelectorAll('.msg')].some((n) => n.innerText.includes(${JSON.stringify(TOKEN)}))`);
    record.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 120));
  } catch (error) {
    record.failure = String(error?.message ?? error);
  } finally {
    record.consoleErrors = inst.app.errors.slice(0, 20);
    record.stop = await inst.stop();
  }
  record.passed = !record.failure && record.replyStored && record.replyOnScreen && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd;
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.passed ? 0 : 1);
}
