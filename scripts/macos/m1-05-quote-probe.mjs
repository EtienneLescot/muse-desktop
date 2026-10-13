#!/usr/bin/env node
/**
 * M1-05 side probe (macOS): what WKWebView does to typed quotes and dashes in
 * a text field of the app page. Inserts the same text through Input.insertText
 * (the AppKit insertText: path typed characters take), character by character
 * and whole, into the terminal panel's input when one is given (--terminal),
 * and into probe inputs appended to the page with and without
 * spellcheck="false", then reads the values back. No turn.
 *
 *   node scripts/macos/m1-05-quote-probe.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9442]
 */
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { argValue, sleep } from "../cdp-harness.mjs";
import { writeFileSync } from "node:fs";
import { launch } from "./test-instance.mjs";
import { platform } from "./m1-05-terminal-lib.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9442"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `quote-${Date.now().toString(36)}`)));
const TEXT = `echo 'a b' "c d" -- x`;

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
  result.changed = result.perChar !== TEXT || result.whole !== TEXT;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  const out = { engine: inst.engineVersion, text: TEXT, fields: {} };
  try {
    await inst.app.ev(`(() => {
      for (const [id, attrs] of [['plain', {}], ['spellcheck-false', { spellcheck: 'false' }], ['autocorrect-off', { autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' }]]) {
        const i = document.createElement('input'); i.id = 'probe-' + id; for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
        i.style.position = 'fixed'; i.style.top = '0'; i.style.left = '0'; i.style.zIndex = '99999'; document.body.appendChild(i);
      }
      return true;
    })()`);
    for (const id of ["plain", "spellcheck-false", "autocorrect-off"]) out.fields[id] = await probeField(inst.app, `#probe-${id}`);
  } finally {
    out.stop = await inst.stop();
  }
  const record = {
    schema: "muse-desktop.m1-05-quote-probe-macos.v1",
    ticket: "M1-05",
    date: new Date().toISOString().slice(0, 10),
    commit: "08b291d",
    platform: platform(),
    engine: out.engine,
    liveTurns: 0,
    harness: `scripts/macos/m1-05-quote-probe.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
    isolation: "own data folder and WKWebView store (test-instance.mjs); default stores unchanged at the end; nothing typed reaches a shell",
    method: "Three inputs appended to the app page (plain, spellcheck=false, spellcheck=false + autocorrect/autocapitalize off). The same text is inserted one character at a time (as typing delivers it) and as one insertion, through Input.insertText (AppKit insertText:), and read back. System text-substitution settings left at the macOS defaults (NSAutomaticQuoteSubstitutionEnabled and NSAutomaticDashSubstitutionEnabled not set).",
    checks: out.fields,
    verdicts: {
      plainFieldSubstitutesTypedQuotes: out.fields.plain.perChar !== TEXT,
      spellcheckFalseKeepsTypedText: out.fields["spellcheck-false"].perChar === TEXT && out.fields["spellcheck-false"].whole === TEXT,
      isolationKept: out.stop.defaultStoresUnchangedAtEnd === true && out.stop.testStoreDeleted === true && out.stop.leftAfterQuit.length === 0,
    },
    limits: ["Probe inputs, not the terminal field itself; the terminal field (no spellcheck attribute) is measured in m1-05-terminal-macos.json, check typed-quotes."],
  };
  const OUT = argValue("--out", null);
  if (OUT) writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
}
