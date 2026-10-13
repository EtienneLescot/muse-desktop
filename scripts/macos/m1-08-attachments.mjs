#!/usr/bin/env node
/**
 * M1-08 on macOS: the Windows records (scripts/cdp-m1-08-attachments.mjs,
 * scripts/cdp-m1-08-single-image.mjs; docs/evidence/2026-09-26-m1-closure/
 * m1-08-*.json) replayed in one isolated test instance
 * (scripts/macos/test-instance.mjs) on the pinned engine.
 *
 * How files reach the page: the Windows proof used CDP DOM.setFileInputFiles,
 * which the WKWebView bridge does not serve (-32601), and the composer's
 * Attach control is an <input type=file> (the WebView's own panel, not the
 * dialog plugin), so dialogQueue cannot answer it. Files are therefore built
 * in the page as File objects and handed to that same input through a
 * DataTransfer (input.files = dt.files, then a bubbling change event): the
 * app's own onChange -> addFiles -> readAttachment path. The over-limit
 * attempts go through the drop handler with the same DataTransfer. Native
 * drag and drop from Finder is out of reach of the bridge.
 *
 *   - bounds, on the welcome screen: 8 files with an empty draft, then the
 *     9th refused; 7 files with a written message, then the 8th refused
 *     (the UI counts the text as a part since 27/09, maxAttachmentsFor);
 *   - removal before sending: a text file attached then removed is not sent;
 *   - a real image rides a live turn: a 64x64 solid red PNG, the exact bytes
 *     in send_input's image part, the model names the colour;
 *   - the wire bound: in the conversation composer, 8 images then a typed
 *     message (9 parts) are refused by the Rust validation
 *     ("inputParts cannot contain more than 8 parts"), the text stays on
 *     screen as an unsent row with Retry/Discard, and Discard removes that
 *     row (the composer draft is recorded as it stands).
 *
 *   node scripts/macos/m1-08-attachments.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop \
 *     [--port 9433] [--base $TMPDIR/muse-proofs-g3] [--out-dir docs/evidence/2026-10-13-macos-closure]
 *
 * One live turn (the image turn; the 9-part send never reaches the engine).
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { INSTALL_IPC_TRACE, argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, transcript } from "./smoke-real-turn.mjs";
import { writeEvidence } from "./m1-01-08-evidence.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9433"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g3")));
const OUT_DIR = argValue("--out-dir", null);
const ID = Date.now().toString(36);
const ROOT = join(BASE, `m1-attach-${ID}`);
const WS = join(ROOT, "workspace");

/** A solid-colour RGB PNG, built here so its colour is known exactly. */
function png(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const RED = png(64, [255, 0, 0]);
const GREY = (i) => png(8, [100 + i, 100 + i, 100 + i]);
const file = (name, type, buf) => ({ name, type, b64: buf.toString("base64") });

mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, "README.md"), "# attachments scratch\n");

const record = { schema: "muse-desktop.m1-08-attachments-macos.v1", ticket: "M1-08", date: new Date().toISOString().slice(0, 10), liveTurns: 0, injection: "page-built File objects through DataTransfer into the composer's <input type=file> (change) and the drop handler; DOM.setFileInputFiles is not served by the WKWebView bridge", steps: {}, verdict: {} };
const step = (name, data) => { record.steps[name] = data; console.error(`- ${name}: ${JSON.stringify(data).slice(0, 260)}`); return data; };

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
const { app } = inst;
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const ev = (expr) => app.ev(expr);
const must = async (label, probe, ms = 30_000, every = 500) => {
  const value = await waitFor(probe, ms, every);
  if (!value) throw new Error(`timeout: ${label}`);
  return value;
};
const INSTALL_ATTACH = `(() => {
  const toFiles = (files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: f.type }));
    }
    return dt;
  };
  window.__g3 = {
    viaInput(selector, files) {
      const input = document.querySelector(selector);
      if (!input) return "no input";
      const dt = toFiles(files);
      const given = dt.files.length;
      const disabled = input.disabled;
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { disabledBefore: disabled, given };
    },
    viaDrop(selector, files) {
      const target = document.querySelector(selector);
      if (!target) return "no drop target";
      const dt = toFiles(files);
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dt });
      target.dispatchEvent(event);
      return { given: dt.files.length };
    },
  };
  return true;
})()`;
const chips = () => ev(`[...document.querySelectorAll(".attachment-chips .attachment-name")].map((n) => n.textContent)`);
const attachError = () => ev(`document.querySelector(".attachment-error")?.textContent ?? null`);
const removeAll = async () => { await ev(`[...document.querySelectorAll(".attachment-chips .attachment-remove")].forEach((b) => b.click())`); await must("no chip", async () => (await chips()).length === 0, 5_000, 100); };
const setDraft = (selector, value) => ev(`(() => { const a = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(a, ${JSON.stringify(value)}); a.dispatchEvent(new Event("input", { bubbles: true })); return a.value; })()`);
const mark = () => ev("Date.now() - window.__baselineIpc.t0");
const calls = (cmd, since = -1) => ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)} && c.atMs > ${since}).map((c) => ({ atMs: c.atMs, ok: c.ok, args: c.args, result: (c.result || "").slice(0, 600) }))`);

try {
  step("project", { start: await newProjectConversation(app, WS) });
  await ev(INSTALL_ATTACH);
  const WELCOME_INPUT = ".welcome-draft input[type=file]";
  const WELCOME_TEXT = 'textarea[aria-label="Your first message"]';

  // --- bounds on the welcome screen
  await setDraft(WELCOME_TEXT, "");
  const eight = Array.from({ length: 8 }, (_, i) => file(`grey-${i}.png`, "image/png", GREY(i)));
  step("inject-8-empty-draft", await ev(`window.__g3.viaInput(${JSON.stringify(WELCOME_INPUT)}, ${JSON.stringify(eight)})`));
  const c8 = await must("8 chips", async () => { const c = await chips(); return c.length === 8 ? c : null; }, 10_000, 200);
  const inputDisabledAt8 = await ev(`document.querySelector(${JSON.stringify(WELCOME_INPUT)}).disabled`);
  await ev(`window.__g3.viaDrop(".welcome-draft", ${JSON.stringify([file("ninth.png", "image/png", GREY(9))])})`);
  await sleep(800);
  const ninth = step("ninth-refused-empty-draft", { chips: (await chips()).length, inputDisabledAt8, error: await attachError() });
  record.verdict.ninthFileRefused = c8.length === 8 && inputDisabledAt8 && ninth.chips === 8 && /up to 8 files/.test(ninth.error ?? "");

  await removeAll();
  await setDraft(WELCOME_TEXT, "Text counts as one part.");
  step("inject-8-with-text", await ev(`window.__g3.viaInput(${JSON.stringify(WELCOME_INPUT)}, ${JSON.stringify(eight)})`));
  const c7 = await must("7 chips", async () => { const c = await chips(); return c.length === 7 ? c : null; }, 10_000, 200);
  const inputDisabledAt7 = await ev(`document.querySelector(${JSON.stringify(WELCOME_INPUT)}).disabled`);
  await ev(`window.__g3.viaDrop(".welcome-draft", ${JSON.stringify([file("eighth.png", "image/png", GREY(10))])})`);
  await sleep(800);
  const eighth = step("eighth-refused-with-text", { chips: (await chips()).length, kept: c7, inputDisabledAt7, error: await attachError() });
  record.verdict.textCountsAsPartInUi = eighth.chips === 7 && inputDisabledAt7 && /up to 7 files with a written message \(8 without\)/.test(eighth.error ?? "");
  await removeAll();

  // --- removal before sending, then the live image turn
  const QUESTION = "What colour is the attached image? Answer with just the colour name in lower case.";
  await setDraft(WELCOME_TEXT, "");
  await ev(`window.__g3.viaInput(${JSON.stringify(WELCOME_INPUT)}, ${JSON.stringify([file("red-square.png", "image/png", RED), file("notes.txt", "text/plain", Buffer.from("must not be sent\n"))])})`);
  await must("2 chips", async () => (await chips()).length === 2, 10_000, 200);
  await ev(`document.querySelector('button[aria-label="Remove attachment notes.txt"]')?.click()`);
  const afterRemove = await must("1 chip", async () => { const c = await chips(); return c.length === 1 ? c : null; }, 5_000, 100);
  step("removed-before-send", { chips: afterRemove });
  await ev(`document.querySelector(${JSON.stringify(WELCOME_TEXT)}).focus()`);
  await app.send("Input.insertText", { text: QUESTION });
  await must("draft taken", () => ev(`document.activeElement?.value === ${JSON.stringify(QUESTION)} && !document.querySelector("button.welcome-send")?.disabled`), 10_000, 100);
  const t0 = await mark();
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const sendCall = await must("send_input", async () => (await calls("send_input", t0)).find((c) => c.ok !== undefined) ?? null, 60_000, 300);
  record.liveTurns += 1;
  const sid = sendCall.args.sessionId;
  record.sid = sid;
  const parts = sendCall.args.inputParts ?? [];
  const image = parts.find((p) => p.type === "image");
  const sentParts = step("sent-parts", {
    ok: sendCall.ok,
    parts: parts.map((p) => ({ type: p.type, mediaType: p.mediaType, width: p.width, height: p.height, bytes: p.base64Data ? Buffer.from(p.base64Data, "base64").length : undefined, text: p.text?.slice(0, 120) })),
    imageBytesIdentical: image ? Buffer.from(image.base64Data, "base64").equals(RED) : false,
    removedFileSent: JSON.stringify(parts).includes("must not be sent"),
  });
  record.verdict.removedAttachmentNotSent = sentParts.parts.length === 2 && !sentParts.removedFileSent;
  const answer = await must("model answer", async () => {
    if (await ev(`document.querySelector(".session-view .task-metadata .dot")?.getAttribute("data-running") === "true"`)) return null;
    const a = (await transcript(app, sid)).filter((e) => e.role === "assistant" && String(e.text).trim()).at(-1);
    return a ? String(a.text).trim() : null;
  }, 240_000, 2_000);
  step("model-answer", { answer: answer.slice(0, 120) });
  record.verdict.imageRidesLiveTurn = sendCall.ok && sentParts.imageBytesIdentical && image.mediaType === "image/png" && /\bred\b/i.test(answer);

  // --- the wire bound, in the conversation composer: 8 images, then text
  await ev(INSTALL_ATTACH);
  const COMPOSER_INPUT = ".composer input[type=file]";
  const COMPOSER_TEXT = 'textarea[aria-label="Message Muse"]';
  await must("composer", () => ev(`!!document.querySelector(${JSON.stringify(COMPOSER_TEXT)})`), 20_000);
  step("composer-inject-8", await ev(`window.__g3.viaInput(${JSON.stringify(COMPOSER_INPUT)}, ${JSON.stringify(eight)})`));
  await must("8 composer chips", async () => (await chips()).length === 8, 10_000, 200);
  const WIRE_TEXT = `Nine parts ${ID}: eight images and this text.`;
  await ev(`document.querySelector(${JSON.stringify(COMPOSER_TEXT)}).focus()`);
  await app.send("Input.insertText", { text: WIRE_TEXT });
  await must("composer text", () => ev(`document.activeElement?.value === ${JSON.stringify(WIRE_TEXT)}`), 10_000, 100);
  const chipsWithText = (await chips()).length;
  const t1 = await mark();
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  const wire = await must("9-part send_input", async () => (await calls("send_input", t1)).find((c) => c.ok !== undefined) ?? null, 30_000, 300);
  const unsent = await must("unsent row", () => ev(`(() => {
    const row = [...document.querySelectorAll(".pending-send")].find((r) => (r.querySelector(".pending-send-text")?.title ?? "").includes(${JSON.stringify(WIRE_TEXT)}));
    return row ? { text: row.querySelector(".pending-send-text").title, error: row.querySelector(".pending-send-error")?.textContent ?? null, buttons: [...row.querySelectorAll("button")].map((b) => b.textContent.trim()) } : null;
  })()`), 15_000);
  const engineSawIt = (await transcript(app, sid)).some((e) => e.role === "assistant" && String(e.text).includes(ID));
  step("wire-bound", { chipsBeforeSend: chipsWithText, partsSent: wire.args.inputParts?.length ?? null, ok: wire.ok, result: wire.result, unsent, engineAnswered: engineSawIt });
  record.verdict.wireRefusesNineParts = chipsWithText === 8 && wire.args.inputParts?.length === 9 && wire.ok === false && /cannot contain more than 8 parts/.test(wire.result) && !engineSawIt;
  record.verdict.textPreservedWithRetryDiscard = unsent.text.includes(WIRE_TEXT) && unsent.buttons.includes("Retry") && unsent.buttons.includes("Discard");
  await ev(`[...document.querySelectorAll(".pending-send")].find((r) => (r.querySelector(".pending-send-text")?.title ?? "").includes(${JSON.stringify(WIRE_TEXT)}))?.querySelectorAll("button")[1]?.click()`);
  await sleep(1200);
  const afterDiscard = step("after-discard", {
    unsentRows: await ev(`document.querySelectorAll(".pending-send").length`),
    composerChips: (await chips()).length,
    composerText: await ev(`document.querySelector(${JSON.stringify(COMPOSER_TEXT)})?.value ?? null`),
  });
  record.verdict.discardClearsUnsentRow = afterDiscard.unsentRows === 0;
  record.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 120));
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}

const required = ["ninthFileRefused", "textCountsAsPartInUi", "removedAttachmentNotSent", "imageRidesLiveTurn", "wireRefusesNineParts", "textPreservedWithRetryDiscard", "discardClearsUnsentRow"];
record.verdict.all = !record.failure && required.every((k) => record.verdict[k] === true);
record.passed = record.verdict.all && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd;
const out = redactor([[realpathSync(BASE), "<g3>"], [BASE, "<g3>"], [homedir(), "~"]])(record);
if (OUT_DIR) {
  const v = record.verdict;
  writeEvidence({ dir: OUT_DIR, exe: EXE, base: BASE, record, harness: `node scripts/macos/m1-08-attachments.mjs --exe <exe> --port ${PORT} --base <tmp> --out-dir <dir> (scripts/macos/test-instance.mjs launch(), scripts/cdp-harness.mjs IPC trace)`, entries: [{
    file: "m1-08-attachments.json", ticket: "M1-08", windowsReference: "docs/evidence/2026-09-26-m1-closure/m1-08-attachments.json, m1-08-single-image.json",
    method: `${record.injection}. The image is a 64x64 solid red PNG built by the harness, so the answer is checkable; the bytes in send_input's image part (IPC trace) are compared with it. Messages typed with Input.insertText and sent with a real Enter.`,
    checks: record.steps,
    verdicts: { ...v, ticketMacos: v.all ? "☑" : "◐" },
    limits: ["Files reach the page as page-built File objects (DataTransfer), not through the macOS open panel of <input type=file> nor a Finder drag: the bridge serves neither DOM.setFileInputFiles nor native drag and drop. The app's own intake (onChange/onDrop -> readAttachment) is what runs. Picking a file in the real open panel and dropping one from Finder remain for a session with Étienne.", "After the refused 9-part send, Discard removes the unsent row but the composer still holds the 8 images and the text (recorded in after-discard): the message exists twice until then. Not data loss; logged for the backlog.", "With an empty draft the over-limit copy reads 'You can attach up to 8 files with a written message (8 without)': the wording is meant for a non-empty draft (cross-platform copy defect, logged for the backlog).", "Since 27/09 the UI counts the text as a part, so the 8-image + text wire refusal of the Windows record is reached by attaching 8 images with an empty draft, then typing: the UI does not re-check the cap when text is added after the files (logged for the backlog)."],
  }] });
}
console.log(JSON.stringify(out, null, 2));
process.exit(record.passed ? 0 : 1);
