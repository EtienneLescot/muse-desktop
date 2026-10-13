#!/usr/bin/env node
/**
 * M0-03 on macOS: lose no text on a rejected send, admit one turn per send.
 *
 * One isolated instance on the pinned engine, one project conversation.
 * The ticket's scenarios, as the Windows proofs of 20/09/2026 ran them
 * (cdp-unknown-skill-reject, cdp-double-send, cdp-reload-mid-send), with real
 * keys and a trusted mouse instead of a forged click:
 *
 *   rejected     "/definitelynotaskill …" + Enter: refused before the engine
 *                (unknown skill); the text stays, an explanation shows, no
 *                outbox row, no send_input, the composer stays usable.
 *   doubleEnter  two Enter 120 ms apart: one send_input, one user entry, one
 *                clientMessageId.
 *   doubleClick  a trusted mouse double-click on the Send button: the same.
 *   reloadDraft  an unsent draft, then Page.reload: the draft comes back.
 *   reloadMidSend Enter, then Page.reload 1.2 s later: no duplicate, the turn
 *                ends, no resend after the reload.
 *   reloadAtOnce Enter, then Page.reload with no wait (the send may not be
 *                acknowledged yet): the text is either sent once or kept for
 *                the user, never lost, never doubled. A variant, recorded.
 *
 * The IME criterion cannot be driven: the bridge has no composition input
 * (Input.imeSetComposition answers -32601) and a system input source change
 * is out of bounds. Recorded as a limit with the code it rests on.
 *
 *   node scripts/macos/m0-03-no-text-lost.mjs [--exe <muse-desktop>] [--port 9413]
 *
 * Four or five live turns (reloadAtOnce runs one only if the send got out). Writes docs/evidence/2026-10-13-macos-closure/m0-03-no-text-lost.json.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_IPC_TRACE, argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage } from "./smoke-real-turn.mjs";
import { BASE, COMMIT, EXE, J, assistantHas, clickSelector, now, openSession, platform, pressEnter, sidebar, sleep, transcript, typeInComposer, view, waitFor, writeRecord } from "./m0-g1-helpers.mjs";

const PORT = Number(argValue("--port", "9413"));
const ID = Date.now().toString(36).toUpperCase();
const ROOT = join(BASE, "m0-03", ID);
const PROJECT = join(ROOT, "project");
mkdirSync(PROJECT, { recursive: true });

const record = {
  schema: "muse-desktop.m0-03-no-text-lost.v1",
  ticket: "M0-03",
  date: now().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 5,
  harness: `scripts/macos/m0-03-no-text-lost.mjs on scripts/macos/test-instance.mjs (launch), bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine, one project conversation (first turn from the welcome screen). Text typed with Input.insertText, Enter as AppKit key events, the double-click as two trusted AppKit mouse events (clickCount 1 then 2) on the Send button, reloads with Page.reload. Counts read from the IPC trace (send_input, with its commandId), the stored transcript (user entries and their clientMessageId), the outbox key and the queued-turns key.",
  scenarios: {},
  checks: {},
  verdicts: {},
  limits: [
    "IME not driven: the bridge has no composition input (Input.imeSetComposition is not served) and switching the system input source is out of bounds for this harness. The composer's guard is `if (e.nativeEvent.isComposing) return;` (src/components/Composer.tsx onKey; EmptySessionScreen.tsx the same). WebKit is known to deliver the Enter that commits a candidate after compositionend, with isComposing false and keyCode 229; if this WKWebView does so, that Enter would send. To check by hand with a Japanese or Chinese input source (Étienne).",
    "The engine's session store (~/.local/share/muse/sessions) is the user's, shared by the test instance (ADR 0003).",
    "Debug build in test mode, not the release build.",
  ],
};

const inst = await launch({ exe: EXE, port: PORT, data: join(ROOT, "data") });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
let sid = null;

const outbox = () => app.ev(`(() => { const out = {}; for (const k of Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.outbox.v1'))) { try { out[k.slice(-8)] = JSON.parse(localStorage.getItem(k) || '[]').map((r) => ({ state: r.state, ambiguous: r.ambiguous === true, text: String(r.text ?? '').slice(0, 80) })); } catch { out[k.slice(-8)] = 'unreadable'; } } return out; })()`);
const outboxRows = async () => Object.values(await outbox()).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
// queued-turns.v1 is an object keyed by conversation: the number of queued turns of all of them.
const queued = () => app.ev(`(() => { try { const q = JSON.parse(localStorage.getItem('muse-desktop.queued-turns.v1') || '{}'); return Object.values(q).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0); } catch { return 'unreadable'; } })()`);
const sendsWith = (marker) => app.ev(`(window.__baselineIpc?.calls || []).filter((c) => c.cmd === 'send_input' && String(c.args?.text ?? '').includes(${J(marker)})).map((c) => ({ commandId: c.args.commandId, ok: c.ok }))`);
const usersWith = async (marker) => (await transcript(app, sid)).filter((e) => e.role === "user" && String(e.text ?? "").includes(marker)).map((e) => e.clientMessageId ?? e.id);
const clearComposer = () => app.ev(`(() => { const t = document.querySelector('textarea[aria-label="Message Muse"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const turnDone = (token, ms = 180_000) => waitFor(async () => (await assistantHas(app, sid, token)) && !(await sidebar(app)).find((r) => r.sid === sid)?.running, ms, 500);
const reloadAndWait = async () => {
  await app.send("Page.reload", {});
  await sleep(500);
  await waitFor(() => app.ev("location.protocol === 'tauri:' && document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 250);
  await waitFor(() => app.ev(`Boolean(document.querySelector('.session-item[data-session-id=${J(sid)}]'))`).catch(() => false), 30_000, 250);
  await app.ev(INSTALL_IPC_TRACE);
};

try {
  record.start = await newProjectConversation(app, PROJECT);
  sid = await sendFirstMessage(app, `Reply with exactly READY-${ID} and nothing else.`);
  record.firstTurn = Boolean(await turnDone(`READY-${ID}`));
  await waitFor(async () => (await view(app)).connection === "Connected", 30_000, 250);
  await app.ev(INSTALL_IPC_TRACE);
  record.imeProbe = await app.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 }).then(() => "served", (e) => String(e.message).slice(0, 120));

  // rejected ------------------------------------------------------------------
  {
    const s = record.scenarios.rejected = {};
    const text = `/definitelynotaskill this command names a skill that does not exist ${ID}`;
    s.typed = await typeInComposer(app, text);
    await sleep(3_000);
    const read = async () => {
      const v = await view(app);
      const shown = await app.ev(`(document.querySelector('main.conversation')?.textContent || '').includes('unknown skill /definitelynotaskill')`);
      return { sameConversation: v.sid === sid, composerKeepsText: v.composer?.value === text, composerUsable: v.composer?.disabled === false, explanationShown: shown, outboxRows: await outboxRows(), sendInputCalls: (await sendsWith(ID)).length, userEntries: (await usersWith(`skill that does not exist ${ID}`)).length };
    };
    s.after3s = await read();
    await sleep(7_000);
    s.after10s = await read();
    s.retryButtons = await app.ev(`[...document.querySelectorAll('main.conversation button')].map((b) => b.innerText.trim()).filter((t) => /^(retry|discard|resend)$/i.test(t))`);
    record.checks.rejectedKeepsText = [s.after3s, s.after10s].every((r) => r.sameConversation && r.composerKeepsText && r.composerUsable && r.explanationShown && r.outboxRows === 0 && r.sendInputCalls === 0 && r.userEntries === 0);
    await clearComposer();
  }

  // doubleEnter ---------------------------------------------------------------
  {
    const s = record.scenarios.doubleEnter = {};
    const marker = `DOUBLE-ENTER-${ID}`;
    s.typed = await typeInComposer(app, `Reply with exactly ${marker} and nothing else.`, { enter: false });
    await pressEnter(app);
    await sleep(120);
    await pressEnter(app);
    s.done = Boolean(await turnDone(marker));
    await sleep(2_000);
    s.sendInput = await sendsWith(marker);
    s.userEntries = await usersWith(marker);
    s.composerAfter = (await view(app)).composer?.value ?? null;
    s.outboxRows = await outboxRows();
    s.queued = await queued();
    record.checks.doubleEnterOneTurn = s.done && s.sendInput.length === 1 && s.userEntries.length === 1 && new Set(s.userEntries).size === 1 && s.outboxRows === 0 && s.queued === 0 && s.composerAfter === "";
  }

  // doubleClick ---------------------------------------------------------------
  {
    const s = record.scenarios.doubleClick = {};
    const marker = `DOUBLE-CLICK-${ID}`;
    s.typed = await typeInComposer(app, `Reply with exactly ${marker} and nothing else.`, { enter: false });
    s.clicked = await clickSelector(app, 'button.send[aria-label="Send message"]', { clickCount: 2 });
    s.done = Boolean(await turnDone(marker));
    await sleep(2_000);
    s.sendInput = await sendsWith(marker);
    s.userEntries = await usersWith(marker);
    s.composerAfter = (await view(app)).composer?.value ?? null;
    s.outboxRows = await outboxRows();
    s.queued = await queued();
    record.checks.doubleClickOneTurn = s.clicked && s.done && s.sendInput.length === 1 && s.userEntries.length === 1 && s.outboxRows === 0 && s.queued === 0 && s.composerAfter === "";
  }

  // reloadDraft ---------------------------------------------------------------
  {
    const s = record.scenarios.reloadDraft = {};
    const draft = `DRAFT-RELOAD-${ID} — unsent, é 😀`;
    s.typed = await typeInComposer(app, draft, { enter: false });
    s.entriesBefore = (await transcript(app, sid)).length;
    await sleep(500);
    await reloadAndWait();
    await openSession(app, sid);
    s.composerAfterReload = (await view(app)).composer?.value ?? null;
    s.entriesAfter = (await transcript(app, sid)).length;
    s.sentAfterReload = (await usersWith(`DRAFT-RELOAD-${ID}`)).length;
    record.checks.draftSurvivesReload = s.composerAfterReload === draft && s.entriesAfter === s.entriesBefore && s.sentAfterReload === 0;
    await clearComposer();
  }

  // reloadMidSend -------------------------------------------------------------
  {
    const s = record.scenarios.reloadMidSend = {};
    const marker = `RELOAD-MID-${ID}`;
    s.typed = await typeInComposer(app, `Count from 1 to 200, one number per line, then write ${marker} on its own line.`, { enter: false });
    await pressEnter(app);
    await sleep(1_200);
    s.sendInputBeforeReload = await sendsWith(marker);
    await reloadAndWait();
    await openSession(app, sid);
    s.done = Boolean(await turnDone(marker, 240_000));
    await sleep(2_000);
    s.sendInputAfterReload = await sendsWith(marker);
    s.userEntries = await usersWith(marker);
    s.composerAfter = (await view(app)).composer?.value ?? null;
    s.outbox = await outbox();
    record.checks.reloadMidSendNoDuplicate = s.done && s.sendInputBeforeReload.length === 1 && s.sendInputAfterReload.length === 0 && s.userEntries.length === 1 && s.composerAfter === "" && (await outboxRows()) === 0;
  }

  // reloadAtOnce (variant) ----------------------------------------------------
  {
    const s = record.scenarios.reloadAtOnce = {};
    const marker = `RELOAD-NOW-${ID}`;
    const text = `Reply with exactly ${marker} and nothing else.`;
    s.typed = await typeInComposer(app, text, { enter: false });
    await pressEnter(app);
    s.sendInputBeforeReload = await sendsWith(marker);
    s.ackBeforeReload = s.sendInputBeforeReload.some((c) => c.ok !== undefined);
    await reloadAndWait();
    await openSession(app, sid);
    await sleep(3_000);
    s.after = { composer: (await view(app)).composer?.value ?? null, outbox: await outbox(), queued: await queued() };
    s.replied = Boolean(await turnDone(marker, 120_000));
    s.userEntries = await usersWith(marker);
    s.sendInputAfterReload = await sendsWith(marker);
    s.final = { composer: (await view(app)).composer?.value ?? null, outbox: await outbox() };
    const keptForUser = s.final.composer === text || JSON.stringify(s.final.outbox).includes(marker);
    s.outcome = s.replied && s.userEntries.length === 1 ? "sent once" : keptForUser ? "kept for the user" : "lost";
    record.checks.reloadAtOnceNeverLostNeverDoubled = s.outcome !== "lost" && s.userEntries.length <= 1;
  }
} catch (error) {
  record.failure = String(error?.message ?? error);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}
const sc = record.scenarios;
// The first turn, plus each scenario whose turn really ran.
record.liveTurns = 1 + [sc.doubleEnter?.done, sc.doubleClick?.done, sc.reloadMidSend?.done, sc.reloadAtOnce?.replied].filter(Boolean).length;
const c = record.checks;
c.nothingLeft = record.stop.leftAfterQuit.length === 0 && record.stop.groupLeftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd === true;
record.verdicts = {
  rejectedSendKeepsText: Boolean(c.rejectedKeepsText),
  doubleSubmitOneTurn: Boolean(c.doubleEnterOneTurn && c.doubleClickOneTurn),
  draftAndInFlightSurviveReload: Boolean(c.draftSurvivesReload && c.reloadMidSendNoDuplicate),
  reloadBeforeAckVariant: Boolean(c.reloadAtOnceNeverLostNeverDoubled),
  imeEnterDoesNotSubmit: "not driven (limit)",
  nothingLeft: Boolean(c.nothingLeft),
};
record.passed = !record.failure && Object.values(record.verdicts).every((v) => v === true || typeof v === "string");
console.log(JSON.stringify(writeRecord("m0-03-no-text-lost.json", record), null, 2));
process.exit(record.passed ? 0 : 1);
