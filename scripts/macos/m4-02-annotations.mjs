#!/usr/bin/env node
/**
 * M4-02 on macOS: annotate a page of the built-in browser (WKWebView). One
 * isolated instance (scripts/macos/test-instance.mjs) on the pinned engine.
 *
 * The Windows criteria (m4-02-annotations.json, roadmap M4-02), replayed with
 * the bridge's trusted mouse and keyboard:
 *   1. a comment anchored to the framed page (a local page on 127.0.0.1) is
 *      persisted in muse-desktop.browser.annotations.v1 with the page's
 *      normalised URL and rendered in the list; the list shows only the
 *      annotations of the page on screen;
 *   2. "To prompt" inserts the comment and its URL into the composer;
 *   3. × removes exactly that annotation; the others survive a reload;
 *   4. the anchor reaches the engine: the inserted text is sent (second live
 *      turn) and the model reads the URL back from it.
 * Two live turns: one to open the conversation, one to send the anchor.
 *
 *   node scripts/macos/m4-02-annotations.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9473] [--web 9474] [--base <dir>] [--out <json>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9473"));
const WEB = Number(argValue("--web", "9474"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g7", "m4-02")));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m4-02-annotations-macos.json");
const ID = Date.now().toString(36);
const ORIGIN = `http://127.0.0.1:${WEB}`;
const KEY = "muse-desktop.browser.annotations.v1";
const NOTE_A1 = `M4-02 header too tall ${ID}`;
const NOTE_A2 = `M4-02 button contrast ${ID}`;
const NOTE_B = `M4-02 page B note ${ID}`;

const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  const name = (req.url ?? "").match(/^\/(\w+)\.html/)?.[1];
  if (!name) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    .end(`<!doctype html><meta charset="utf-8"><title>M4-02 ${name}</title><body style="font:16px system-ui"><h1>M4-02 page ${name}</h1><button>Buy</button>`);
});
await new Promise((ok, fail) => { server.once("error", fail); server.listen(WEB, "127.0.0.1", ok); });

async function click(app, expr) {
  const at = await app.ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing to click: ${expr}`);
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
}
async function enter(app) {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await sleep(400);
}
const ADDRESS = `document.querySelector('input[aria-label="Address"]')`;
const NOTE_INPUT = `document.querySelector('input[aria-label="Annotation comment"]')`;
async function typeInto(app, expr, text) {
  await click(app, expr);
  await app.ev(`(${expr}.select(), true)`);
  await app.send("Input.insertText", { text });
  return waitFor(() => app.ev(`${expr}.value === ${JSON.stringify(text)}`), 5_000, 100);
}
async function go(app, url) {
  await typeInto(app, ADDRESS, url);
  await enter(app);
  return waitFor(() => app.ev(`document.querySelector('[aria-label="In-app browser"] iframe')?.getAttribute('src') === ${JSON.stringify(url)}`), 5_000, 100);
}
async function anchor(app, note) {
  await typeInto(app, NOTE_INPUT, note);
  await click(app, `[...document.querySelectorAll('[aria-label="Page annotations"] button')].find((b) => b.textContent.trim() === 'Anchor')`);
  return waitFor(() => app.ev(`[...document.querySelectorAll('.browser-annotation-list li')].some((li) => li.textContent.includes(${JSON.stringify(note)}))`), 5_000, 100);
}
const stored = (app) => app.ev(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || '[]').map((a) => ({ url: a.url, comment: a.comment, selection: a.selection, hasId: typeof a.id === 'string', createdAt: typeof a.createdAt === 'number' }))`);
const listed = (app) => app.ev(`[...document.querySelectorAll('.browser-annotation-list li .browser-annotation-comment')].map((n) => n.textContent)`);
const composer = (app) => app.ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? null`);
async function openBrowserPanel(app) {
  if (!(await app.ev(`Boolean(document.querySelector('nav.work-tabs'))`))) await click(app, `document.querySelector('button[aria-label="Show work panel"]')`);
  await waitFor(() => app.ev(`Boolean(document.querySelector('nav.work-tabs'))`), 5_000, 100);
  await click(app, `[...document.querySelectorAll('nav.work-tabs button')].find((b) => b.textContent.trim() === 'Browser')`);
  return waitFor(() => app.ev(`Boolean(document.querySelector('[aria-label="In-app browser"]'))`), 5_000, 100);
}

const project = join(BASE, `project-${ID}`);
mkdirSync(project, { recursive: true });
const platform = execFileSync("sw_vers", [], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(":")[1].trim());
const report = {
  schema: "muse-desktop.m4-02-annotations-macos.v1",
  ticket: "M4-02",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `${platform[0]} ${platform[1]} (${platform[2]}), arm64, Apple Silicon; debug build with embedded frontend, WKWebView through the test bridge`,
  harness: "scripts/macos/m4-02-annotations.mjs on scripts/macos/test-instance.mjs",
  liveTurns: 0,
  method: "One isolated test instance (fresh data folder, its own WKWebView store, pinned engine with auto-update off). A conversation is opened with one live turn; the Browser panel shows local pages served on 127.0.0.1. Every action goes through the panel with the bridge's trusted AppKit events: the address and the comments are typed (Input.insertText) after a real click, Anchor, To prompt and × are clicked, the composer is sent with Enter. The store is read from localStorage, the list from the DOM, the sent text from the stored transcript and the reply from the engine.",
  limits: [
    "The capture surface the 2026-09-15 plan describes (getDisplayMedia, region crop, zoom) is no longer in the panel; Windows closed M4-02 on the anchored comment, its list, the composer insertion and the removal, which are the criteria replayed here.",
    "An anchored comment carries the page URL, not an element or a region: the panel passes an empty selection (App.tsx, addBrowserAnnotation(url, \"\", comment)).",
  ],
  checks: {},
};
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `data-${ID}`) });
report.engine = inst.engineVersion;
report.isolation = inst.isolation;
const app = inst.app;
try {
  await newProjectConversation(app, project);
  const sid = await sendFirstMessage(app, "Reply with exactly OK and nothing else.");
  report.liveTurns = 1;
  await waitFor(async () => (await transcript(app, sid)).some((e) => e.role === "assistant"), 180_000, 1_000);
  await app.ev(`(localStorage.removeItem(${JSON.stringify(KEY)}), true)`);
  await openBrowserPanel(app);

  // 1. Two comments on page a, one on page b; each page lists only its own.
  const A = `${ORIGIN}/a.html`;
  const B = `${ORIGIN}/b.html`;
  await go(app, "127.0.0.1:" + WEB + "/a.html");
  const before = { listed: await listed(app), noteFieldShown: await app.ev(`Boolean(${NOTE_INPUT})`) };
  await anchor(app, NOTE_A1);
  await anchor(app, NOTE_A2);
  const onA = await listed(app);
  await go(app, B);
  await anchor(app, NOTE_B);
  const onB = await listed(app);
  await go(app, A);
  const backOnA = await listed(app);
  report.checks.anchor = { before, onA, onB, backOnA, stored: await stored(app), frameHits: hits.length };

  // 2. To prompt on the first note of page a.
  const composerBefore = await composer(app);
  await click(app, `[...document.querySelectorAll('.browser-annotation-list li')].find((li) => li.textContent.includes(${JSON.stringify(NOTE_A1)}))?.querySelector('button[title^="Insert"]')`);
  const inserted = await waitFor(() => composer(app).then((v) => (v && v.includes(NOTE_A1) ? v : null)), 5_000, 100);
  report.checks.toPrompt = { composerBefore, composerAfter: inserted };

  // 3. Remove the second note of page a; reload; the rest is still there.
  await click(app, `document.querySelector('[aria-label="Page annotations"] button[aria-label=${JSON.stringify(`Remove annotation ${NOTE_A2}`)}]')`);
  await sleep(400);
  const afterRemove = { listed: await listed(app), stored: (await stored(app)).map((a) => a.comment) };
  await app.send("Page.reload");
  await waitFor(() => app.ev("document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 250);
  await sleep(1_000);
  await click(app, `[...document.querySelectorAll('button.session-select')][0]`).catch(() => null);
  await sleep(800);
  await openBrowserPanel(app);
  await sleep(800);
  const afterReload = { listed: await listed(app), stored: (await stored(app)).map((a) => a.comment), address: await app.ev(`${ADDRESS}.value`) };
  report.checks.remove = { afterRemove, afterReload };

  // 4. The anchor reaches the engine. The reload dropped the unsent draft, so
  // the note is inserted again, then a question is typed after it and Enter sends.
  await click(app, `[...document.querySelectorAll('.browser-annotation-list li')].find((li) => li.textContent.includes(${JSON.stringify(NOTE_A1)}))?.querySelector('button[title^="Insert"]')`);
  await waitFor(() => composer(app).then((v) => v && v.includes(NOTE_A1)), 5_000, 100);
  const COMPOSER = `document.querySelector('textarea[aria-label="Message Muse"]')`;
  await click(app, COMPOSER);
  await app.ev(`(() => { const t = ${COMPOSER}; t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
  const question = "\n\nAbove is a note I anchored to a web page. Reply with only the page URL it is anchored to, nothing else.";
  await app.send("Input.insertText", { text: question });
  await waitFor(() => composer(app).then((v) => v && v.endsWith("nothing else.")), 5_000, 100);
  const draft = await composer(app);
  const assistantBefore = (await transcript(app, sid)).filter((e) => e.role === "assistant").length;
  await enter(app);
  report.liveTurns = 2;
  const reply = await waitFor(async () => {
    const log = await transcript(app, sid);
    const answers = log.filter((e) => e.role === "assistant");
    const running = await app.ev(`document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'`);
    const last = String(answers.at(-1)?.text ?? "").trim();
    return answers.length > assistantBefore && !running && last ? { user: log.filter((e) => e.role === "user").at(-1)?.text ?? null, assistant: last } : null;
  }, 180_000, 1_000);
  report.checks.sent = { draft, storedUserMessage: reply?.user ?? null, reply: reply?.assistant ?? null };
} catch (error) {
  report.failure = String(error?.message ?? error).slice(0, 400);
} finally {
  report.consoleErrors = app.errors.slice(0, 20);
  report.stop = await inst.stop();
  server.close();
}

const c = report.checks;
const A = `${ORIGIN}/a.html`;
const B = `${ORIGIN}/b.html`;
report.verdicts = {
  "1 anchored comments persisted with the page URL": (c.anchor?.stored ?? []).length === 3 && c.anchor.stored.filter((a) => a.url === A).map((a) => a.comment).sort().join("|") === [NOTE_A1, NOTE_A2].sort().join("|") && c.anchor.stored.some((a) => a.url === B && a.comment === NOTE_B) && c.anchor.stored.every((a) => a.hasId && a.createdAt),
  "1 the list shows only the page's own annotations": c.anchor?.before?.listed?.length === 0 && c.anchor.onA.length === 2 && c.anchor.onB.length === 1 && c.anchor.onB[0] === NOTE_B && c.anchor.backOnA.length === 2 && !c.anchor.backOnA.includes(NOTE_B),
  "2 To prompt inserts the comment and its URL": c.toPrompt?.composerAfter === `${NOTE_A1} (${A})`,
  "3 × removes exactly that annotation": c.remove?.afterRemove?.listed?.length === 1 && c.remove.afterRemove.listed[0] === NOTE_A1 && c.remove.afterRemove.stored.length === 2 && !c.remove.afterRemove.stored.includes(NOTE_A2),
  "3 the others survive a reload": c.remove?.afterReload?.stored?.length === 2 && c.remove.afterReload.listed.includes(NOTE_A1),
  "4 the anchor is sent and read back by the engine": String(c.sent?.storedUserMessage ?? "").includes(`${NOTE_A1} (${A})`) && String(c.sent?.reply ?? "").includes(A),
  "clean stop": report.stop?.leftAfterQuit?.length === 0 && report.stop.defaultStoresUnchangedAtEnd === true && report.stop.testStoreDeleted === true && !report.failure,
};
report.passed = Object.values(report.verdicts).every(Boolean);
const redact = redactor([[BASE, "<proof>"], [BASE.replace(/^\/var\//, "/private/var/"), "<proof>"], [homedir(), "<home>"]]);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(redact(report), null, 2)}\n`);
console.log(JSON.stringify({ verdicts: report.verdicts, failure: report.failure ?? null }, null, 2));
process.exit(report.passed ? 0 : 1);
