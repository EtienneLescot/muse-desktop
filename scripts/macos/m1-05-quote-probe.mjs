#!/usr/bin/env node
/**
 * M1-05 side probe (macOS): what WKWebView does to typed quotes and dashes in
 * a text field of the app page. Inserts the same text through Input.insertText
 * (the AppKit insertText: path typed characters take), character by character
 * and whole, into probe inputs appended to the page with and without
 * spellcheck="false", then into the app's own composers: the welcome screen's
 * first-message field and, once a conversation exists, the conversation
 * composer. Reads the values back. No turn: the conversation's first message
 * is refused by the harness IPC guard (send_input blocked) then discarded.
 *
 *   node scripts/macos/m1-05-quote-probe.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9442]
 *     [--build-commit 08b291d] [--base <dir>] [--out <file.json>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";
import { platform } from "./m1-05-terminal-lib.mjs";

const BUILD = argValue("--build-commit", "08b291d");
const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9442"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `quote-${Date.now().toString(36)}`)));
const TEXT = `echo 'a b' "c d" -- x`;
const WELCOME = 'textarea[aria-label="Your first message"]';
const COMPOSER = 'textarea[aria-label="Message Muse"]';

/** Types TEXT into the element `selector` both ways; returns the values read back. */
export async function probeField(app, selector) {
  const result = {};
  const sel = JSON.stringify(selector);
  const clear = `(() => { const i = document.querySelector(${sel}); const P = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(P, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`;
  await app.ev(clear);
  for (const ch of TEXT) await app.send("Input.insertText", { text: ch });
  await sleep(200);
  result.perChar = await app.ev(`document.querySelector(${sel}).value`);
  await app.ev(clear);
  await app.send("Input.insertText", { text: TEXT });
  await sleep(200);
  result.whole = await app.ev(`document.querySelector(${sel}).value`);
  await app.ev(clear);
  result.spellcheckAttribute = await app.ev(`document.querySelector(${sel}).getAttribute('spellcheck')`);
  result.changed = result.perChar !== TEXT || result.whole !== TEXT;
  return result;
}

const keeps = (f) => Boolean(f) && f.perChar === TEXT && f.whole === TEXT;

if (import.meta.url === `file://${process.argv[1]}`) {
  const project = join(BASE, "project");
  mkdirSync(project, { recursive: true });
  const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  const out = { engine: inst.engineVersion, text: TEXT, fields: {}, composers: {} };
  try {
    const { app } = inst;
    await app.ev(`(() => {
      for (const [id, attrs] of [['plain', {}], ['spellcheck-false', { spellcheck: 'false' }], ['autocorrect-off', { autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' }]]) {
        const i = document.createElement('input'); i.id = 'probe-' + id; for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
        i.style.position = 'fixed'; i.style.top = '0'; i.style.left = '0'; i.style.zIndex = '99999'; document.body.appendChild(i);
      }
      return true;
    })()`);
    for (const id of ["plain", "spellcheck-false", "autocorrect-off"]) out.fields[id] = await probeField(app, `#probe-${id}`);
    await app.ev("(document.querySelectorAll('[id^=probe-]').forEach((n) => n.remove()), true)");
    // The app's own composers: the welcome screen's first message, then the conversation's.
    const ready = await newProjectConversation(app, project);
    out.composers.welcomeReady = ready;
    if (ready === "ready") {
      out.composers.welcome = await probeField(app, WELCOME);
      await app.ev(`(document.querySelector(${JSON.stringify(WELCOME)}).focus(), true)`);
      await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
      const sid = await sendFirstMessage(app, "M1-05 quote probe. The harness refuses this message: it is never sent.");
      out.composers.sessionStarted = Boolean(sid);
      await waitFor(() => app.ev("document.querySelectorAll('.pending-send').length > 0"), 20_000, 300);
      const sends = await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input')");
      out.composers.everySendRefusedByHarness = sends.length > 0 && sends.every((c) => c.blockedByHarness === true);
      for (let i = 0; i < 4; i++) {
        const discarded = await app.ev("(() => { const b = [...document.querySelectorAll('.pending-send button')].find((n) => n.innerText.trim() === 'Discard'); if (b) b.click(); return !!b; })()");
        if (!discarded) break;
        await sleep(800);
      }
      await app.ev("(window.__baselineIpc.block = [], true)");
      if (await waitFor(() => app.ev(`Boolean(document.querySelector(${JSON.stringify(COMPOSER)}))`), 10_000, 200)) {
        out.composers.conversation = await probeField(app, COMPOSER);
      }
      out.composers.sendInputCallsAfter = (await app.ev("window.__baselineIpc.calls.filter((c) => c.cmd === 'send_input')")).length;
    }
  } finally {
    out.consoleErrors = inst.app.errors.slice(0, 10);
    out.stop = await inst.stop();
  }
  const fixedBuild = BUILD !== "08b291d";
  const record = {
    schema: "muse-desktop.m1-05-quote-probe-macos.v1",
    ticket: "M1-05",
    date: new Date().toISOString().slice(0, 10),
    commit: BUILD,
    platform: platform().replace("08b291d", BUILD),
    engine: out.engine,
    liveTurns: 0,
    harness: `scripts/macos/m1-05-quote-probe.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
    isolation: "own data folder and WKWebView store (test-instance.mjs); default stores unchanged at the end; nothing typed reaches a shell or the engine (send_input refused by the harness IPC guard, the pending message discarded)",
    method: "Three inputs appended to the app page (plain, spellcheck=false, spellcheck=false + autocorrect/autocapitalize off), then the app's own composers: the welcome screen's 'Your first message' field (EmptySessionScreen) and, after a conversation is started with a refused first message, the conversation's 'Message Muse' field (Composer). The same text is inserted one character at a time (as typing delivers it) and as one insertion, through Input.insertText (AppKit insertText:), and read back. System text-substitution settings left at the macOS defaults (NSAutomaticQuoteSubstitutionEnabled and NSAutomaticDashSubstitutionEnabled not set)."
      + (fixedBuild ? ` Replay on ${BUILD} (spellCheck={false} on the terminal input and both composers): the composers are now expected to keep straight quotes and '--'; the plain probe input still substitutes (the system default, kept as the control).` : ""),
    checks: { ...out.fields, composers: out.composers },
    verdicts: {
      plainFieldSubstitutesTypedQuotes: out.fields.plain.perChar !== TEXT,
      spellcheckFalseKeepsTypedText: keeps(out.fields["spellcheck-false"]),
      welcomeComposerKeepsTypedText: keeps(out.composers.welcome) && out.composers.welcome.spellcheckAttribute === "false",
      conversationComposerKeepsTypedText: keeps(out.composers.conversation) && out.composers.conversation.spellcheckAttribute === "false",
      nothingSent: out.composers.everySendRefusedByHarness === true,
      isolationKept: out.stop.defaultStoresUnchangedAtEnd === true && out.stop.testStoreDeleted === true && out.stop.leftAfterQuit.length === 0,
    },
    consoleErrors: out.consoleErrors,
    limits: ["The terminal field itself is measured in m1-05-terminal-macos*.json, check typed-quotes.", "Input.insertText through the bridge, not a physical keyboard."],
    ...(fixedBuild ? { previousRun: { file: "docs/evidence/2026-10-13-macos-closure/m1-05-quote-probe-macos.json", commit: "08b291d", observed: "probe inputs only: a plain input turned `echo 'a b' \"c d\" -- x` typed per character into `echo ‘a b’ “c d” — x`; spellcheck=false kept it. The composers had no spellcheck attribute then and were not measured." } } : {}),
  };
  record.verdicts.all = Object.values(record.verdicts).every((v) => v === true);
  const OUT = argValue("--out", null);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`); }
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.verdicts.all ? 0 : 1);
}
