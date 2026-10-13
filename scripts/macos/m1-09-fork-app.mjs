#!/usr/bin/env node
/**
 * M1-09 — "Create a faithful conversation branch", native macOS proof in the
 * app. One isolated instance (scripts/macos/test-instance.mjs) on the pinned
 * engine; the project lives in a fresh temp folder.
 *
 * Exit criteria (plan M1-09): an independent branch, an unchanged source, an
 * invalid point, an active source and a failure; the branch keeps provenance
 * and workspace, imports history without sharing drafts, and is never a
 * summary in place of the requested fork.
 *
 *   1. source: two real turns (code words ALPHA, BETA), then an unsent draft;
 *   2. "Fork from this turn" on the FIRST turn (an earlier completed turn);
 *   3. an unknown anchor straight through the backend command (invalid point);
 *   4. "Fork from this turn" on the LATEST turn: branch B1, its transcript,
 *      workspace, empty composer;
 *   5. a real turn in B1 (GAMMA) asking for every code word;
 *   6. back in the source, a real turn asking for every code word, and
 *      "Fork conversation" from the conversation actions while it runs: B2;
 *   7. a page reload: both branches and their transcripts are still there;
 *   8. after the app quits, a separate echo host reads source, B1 and B2 back
 *      from the engine's store: provenance, cut, the exact history.
 *
 *   node scripts/macos/m1-09-fork-app.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop [--port 9481] [--base <dir>] [--out <file.json>]
 *
 * Four live turns. Prints the record as JSON (paths redacted).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, redactor, sleep, waitFor } from "../cdp-harness.mjs";
import { bounded, connect, createHost, uuidv7 } from "../msp-probe.mjs";
import { DEFAULT_ENGINE, launch, processTree } from "./test-instance.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9481"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g8")));
const OUT = argValue("--out", null);
const ID = Date.now().toString(36).toUpperCase();
const W = { alpha: `ALPHA-${ID}`, beta: `BETA-${ID}`, gamma: `GAMMA-${ID}`, draft: `DRAFT-${ID}` };

const sessions = (app) => app.ev(`JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]').map((s) => ({ id: s.session_id, title: s.title, workspace: s.workspace, running: s.running }))`);
const activeId = (app) => app.ev(`(() => { const v = JSON.parse(localStorage.getItem('muse-desktop.active.v1') || 'null'); return typeof v === 'string' ? v : null; })()`);
const banner = (app) => app.ev(`document.querySelector('.error-banner[role=alert]')?.innerText?.trim() ?? null`);
const ipc = (app, cmd) => app.ev(`window.__baselineIpc.calls.filter((c) => c.cmd === ${JSON.stringify(cmd)}).map((c) => ({ args: c.args, ok: c.ok, result: c.result }))`);
const summary = (log) => log.map((e) => ({ role: e.role, open: e.open === true, turnId: e.turnId ?? null, text: bounded(String(e.text ?? ""), 80) }));
const said = (log, word) => log.some((e) => e.role === "assistant" && e.open !== true && String(e.text).includes(word));
/** The closed user and assistant texts of a transcript, in order. */
const messages = (log) => log.filter((e) => (e.role === "user" || e.role === "assistant") && e.open !== true && String(e.text).trim()).map((e) => `${e.role[0]}:${e.text}`);

/** A real (isTrusted) left click at the centre of the element the expression returns. */
async function click(app, expression) {
  const at = await app.ev(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!at) return false;
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(150);
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  return true;
}

/** Types into the conversation composer and presses Enter; resolves on the send_input call. */
async function sendInConversation(app, text) {
  const before = (await ipc(app, "send_input")).length;
  await app.ev(`(document.querySelector('textarea[aria-label="Message Muse"]').focus(), true)`);
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`(() => { const b = document.querySelector('button[aria-label="Send message"]'); return document.activeElement?.value === ${JSON.stringify(text)} && b && !b.disabled; })()`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  return waitFor(async () => { const calls = await ipc(app, "send_input"); return calls.length > before && calls.at(-1).ok !== undefined ? calls.at(-1) : null; }, 30_000, 200);
}

/** The reply carrying `word` is stored, closed, and the conversation is idle. */
const settled = (app, sid, word, ms = 240_000) => waitFor(async () => {
  const log = await transcript(app, sid);
  const row = (await sessions(app)).find((s) => s.id === sid);
  return said(log, word) && !log.some((e) => e.open === true) && row && row.running !== true ? log : null;
}, ms, 1_000);

/** "Fork from this turn" on the message whose text holds `needle` (last such message). */
const forkButtonOf = (needle) => `[...document.querySelectorAll('.msg')].filter((m) => m.innerText.includes(${JSON.stringify(needle)}) && m.querySelector('button.msg-fork')).at(-1)?.querySelector('button.msg-fork')`;

const project = join(BASE, `app-${ID}`, "project");
mkdirSync(project, { recursive: true });
const projectReal = realpathSync.native(project);
const redact = redactor([[projectReal, "<project>"], [project, "<project>"], [BASE, "<tmp>"], [realpathSync.native(BASE), "<tmp>"], [homedir(), "<home>"]]);
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, `app-${ID}`, "data") });
const app = inst.app;
const record = {
  schema: "muse-desktop.m1-09-fork-app.v1",
  ticket: "M1-09",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}; debug build 08b291d, WKWebView through the test bridge`,
  engine: inst.engineVersion,
  isolation: inst.isolation,
  liveTurns: 0,
  steps: {},
};
const ids = {};
try {
  // 1. Source: two real turns, then an unsent draft.
  record.steps.start = await newProjectConversation(app, project);
  ids.source = await sendFirstMessage(app, `The code word of this message is ${W.alpha}. Do not call any tool and do not save anything to memory. Reply with exactly OK1 and nothing else.`);
  record.liveTurns++;
  if (!(await settled(app, ids.source, "OK1"))) throw new Error("turn 1 never settled");
  await sleep(1_000);
  record.steps.turn2Send = await sendInConversation(app, `The code word of this message is ${W.beta}. Do not call any tool and do not save anything to memory. Reply with exactly OK2 and nothing else.`).then((c) => ({ ok: c?.ok ?? null }));
  record.liveTurns++;
  const sourceLog = await settled(app, ids.source, "OK2");
  if (!sourceLog) throw new Error("turn 2 never settled");
  const turnIds = [...new Set(sourceLog.filter((e) => e.role === "assistant" && e.turnId).map((e) => e.turnId))];
  ids.turn1 = turnIds[0];
  ids.turn2 = turnIds[1];
  record.steps.source = { entries: summary(sourceLog), userTurns: turnIds.length };
  await app.ev(`(document.querySelector('textarea[aria-label="Message Muse"]').focus(), true)`);
  await app.send("Input.insertText", { text: `${W.draft} unsent` });
  await sleep(500);
  record.steps.sourceDraft = await app.ev(`localStorage.getItem('muse-desktop.draft.' + ${JSON.stringify(ids.source)})`);
  const sessionsBefore = await sessions(app);

  // 2. "Fork from this turn" on the first (earlier, completed) turn.
  const earlierClicked = await click(app, forkButtonOf("OK1"));
  await waitFor(async () => (await ipc(app, "fork_session")).length >= 1 && (await ipc(app, "fork_session"))[0].ok !== undefined, 30_000, 200);
  await sleep(1_000);
  const earlierCall = (await ipc(app, "fork_session"))[0];
  record.steps.forkEarlierTurn = {
    clicked: earlierClicked,
    anchorIsTurn1: Boolean(ids.turn1) && earlierCall?.args?.lastTurnId === ids.turn1,
    ok: earlierCall?.ok ?? null,
    hostError: bounded(String(earlierCall?.result ?? ""), 240)?.replaceAll(ids.source, "<source>"),
    banner: await banner(app),
    sessionsUnchanged: JSON.stringify((await sessions(app)).map((s) => s.id).sort()) === JSON.stringify(sessionsBefore.map((s) => s.id).sort()),
    activeUnchanged: (await activeId(app)) === ids.source,
  };

  // 3. Invalid point: an anchor the host never had, through the backend command.
  const unknown = uuidv7();
  const invalid = await app.ev(`window.__TAURI_INTERNALS__.invoke('fork_session', { sessionId: ${JSON.stringify(ids.source)}, lastTurnId: ${JSON.stringify(unknown)} }).then((r) => ({ ok: true, id: r.session_id }), (e) => ({ ok: false, error: String(e) }))`);
  record.steps.forkUnknownAnchor = {
    ok: invalid.ok,
    hostError: bounded(String(invalid.error ?? ""), 240)?.replaceAll(ids.source, "<source>"),
    sessionsUnchanged: JSON.stringify((await sessions(app)).map((s) => s.id).sort()) === JSON.stringify(sessionsBefore.map((s) => s.id).sort()),
  };

  // 4. "Fork from this turn" on the latest turn: branch B1.
  const latestClicked = await click(app, forkButtonOf("OK2"));
  const b1 = await waitFor(async () => (await sessions(app)).find((s) => !sessionsBefore.some((o) => o.id === s.id)) ?? null, 30_000, 300);
  if (!b1) throw new Error(`no branch from the latest turn (banner: ${await banner(app)})`);
  ids.b1 = b1.id;
  await sleep(1_500);
  const b1Call = (await ipc(app, "fork_session")).filter((c) => c.ok).at(-1);
  const b1Log = await transcript(app, ids.b1);
  const sourceRow = (await sessions(app)).find((s) => s.id === ids.source);
  record.steps.forkLatestTurn = {
    clicked: latestClicked,
    anchorIsTurn2: Boolean(ids.turn2) && b1Call?.args?.lastTurnId === ids.turn2,
    newId: ids.b1 !== ids.source,
    title: b1.title?.replace(ID, "<id>"),
    sameWorkspace: b1.workspace === sourceRow?.workspace,
    workspace: b1.workspace,
    active: (await activeId(app)) === ids.b1,
    entries: summary(b1Log),
    noOpenEntries: !b1Log.some((e) => e.open === true),
    hasBothTurns: b1Log.some((e) => e.role === "user" && e.text.includes(W.alpha)) && b1Log.some((e) => e.role === "user" && e.text.includes(W.beta)),
    banner: await banner(app),
    branchComposer: await app.ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? null`),
    branchDraftStored: await app.ev(`localStorage.getItem('muse-desktop.draft.' + ${JSON.stringify(ids.b1)})`),
    sourceDraftKept: (await app.ev(`localStorage.getItem('muse-desktop.draft.' + ${JSON.stringify(ids.source)})`))?.includes(W.draft) ?? false,
  };

  // 5. A real turn in B1.
  record.steps.b1Send = await sendInConversation(app, `The code word of this message is ${W.gamma}. Do not call any tool and do not read or save memory. List every code word that appears in the messages of this conversation, comma separated, and nothing else.`).then((c) => ({ ok: c?.ok ?? null, toB1: c?.args?.sessionId === ids.b1 }));
  record.liveTurns++;
  const b1After = await settled(app, ids.b1, W.gamma);
  const b1Reply = b1After?.filter((e) => e.role === "assistant").at(-1)?.text ?? "";
  record.steps.b1Turn = { reply: bounded(b1Reply.replaceAll(ID, "<id>"), 200), knowsAlpha: b1Reply.includes(W.alpha), knowsBeta: b1Reply.includes(W.beta), knowsGamma: b1Reply.includes(W.gamma) };

  // 6. Source: a real turn, and "Fork conversation" while it runs: B2.
  const sourceTitle = sourceRow?.title ?? "";
  await click(app, `[...document.querySelectorAll('button.session-select')].find((b) => b.title === ${JSON.stringify(sourceTitle)})`);
  await waitFor(async () => (await activeId(app)) === ids.source, 10_000, 200);
  await sleep(800);
  record.steps.sourceComposerOnReturn = bounded(String(await app.ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value ?? ''`)).replaceAll(ID, "<id>"), 80);
  // The draft is the user's: cleared here only to send the next turn.
  await app.ev(`(() => { const a = document.querySelector('textarea[aria-label="Message Muse"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, ''); a.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const beforeB2 = await sessions(app);
  record.steps.sourceSend = await sendInConversation(app, `Do not call any tool and do not read or save memory. Write a numbered list of eight short facts about rivers. Then, on a last line, list every code word that appears in the messages of this conversation, comma separated.`).then((c) => ({ ok: c?.ok ?? null, toSource: c?.args?.sessionId === ids.source }));
  record.liveTurns++;
  const sourceBusy = async () => (await app.ev(`document.querySelector('button.session-select[aria-current="page"] .dot')?.getAttribute('data-running') === 'true'`))
    || (await transcript(app, ids.source)).some((e) => e.open === true);
  const runningSeen = await waitFor(sourceBusy, 30_000, 100);
  await click(app, `[...document.querySelectorAll('button.conversation-more')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Actions for ${sourceTitle}`)})`);
  await waitFor(() => app.ev(`document.querySelector('dialog.conversation-actions-dialog')?.open === true`), 5_000, 100);
  const sourceRunningBeforeFork = await sourceBusy();
  const forkMenuClicked = await click(app, `[...document.querySelectorAll('dialog.conversation-actions-dialog button')].find((b) => b.innerText.trim() === 'Fork conversation')`);
  const b2 = await waitFor(async () => (await sessions(app)).find((s) => !beforeB2.some((o) => o.id === s.id)) ?? null, 30_000, 100);
  if (!b2) throw new Error(`no branch from the running source (banner: ${await banner(app)})`);
  ids.b2 = b2.id;
  const sourceLogAtFork = await transcript(app, ids.source);
  const sourceRunningAfterFork = await sourceBusy();
  await sleep(1_000);
  const b2Call = (await ipc(app, "fork_session")).filter((c) => c.ok).at(-1);
  const b2Result = (() => { try { return JSON.parse(b2Call?.result ?? "null"); } catch { return null; } })();
  const b2Log = await transcript(app, ids.b2);
  record.steps.forkActiveSource = {
    runningSeen: Boolean(runningSeen),
    menuClicked: forkMenuClicked,
    sourceRunningBeforeFork,
    sourceRunningAfterFork,
    anchorless: b2Call?.args?.lastTurnId === null || b2Call?.args?.lastTurnId === undefined,
    branchRunning: b2Result?.running ?? null,
    sourceOpenEntriesAtFork: sourceLogAtFork.filter((e) => e.open === true).length,
    sourceRiverAnswerAtFork: bounded(sourceLogAtFork.filter((e) => e.role === "assistant" && /river/i.test(e.text)).map((e) => e.text).join(" "), 80) ?? null,
    entries: summary(b2Log),
    noOpenEntries: !b2Log.some((e) => e.open === true),
    carriesRunningTurnUserMessage: b2Log.some((e) => e.role === "user" && e.text.includes("rivers")),
    carriesPartialAnswer: b2Log.some((e) => e.role === "assistant" && /river/i.test(e.text)),
    banner: await banner(app),
  };
  const sourceAfter = await settled(app, ids.source, "iver");
  const sourceReply = sourceAfter?.filter((e) => e.role === "assistant").at(-1)?.text ?? "";
  record.steps.sourceTurn3 = { settled: Boolean(sourceAfter), knowsAlpha: sourceReply.includes(W.alpha), knowsBeta: sourceReply.includes(W.beta), knowsGamma: sourceReply.includes(W.gamma), lastLine: bounded(sourceReply.trim().split("\n").at(-1).replaceAll(ID, "<id>"), 160) };
  const b2Later = await transcript(app, ids.b2);
  record.steps.b2UntouchedBySourceTurn = JSON.stringify(messages(b2Later)) === JSON.stringify(messages(b2Log));

  // 7. Reload: the branches and their transcripts are still there.
  const kept = { source: messages(await transcript(app, ids.source)), b1: messages(await transcript(app, ids.b1)), b2: messages(await transcript(app, ids.b2)) };
  await app.send("Page.reload", {});
  await sleep(2_000);
  await waitFor(() => app.ev(`document.readyState === 'complete' && document.querySelectorAll('button.session-select').length >= 3`).catch(() => false), 60_000, 500);
  await sleep(3_000);
  const after = await sessions(app);
  const again = { source: messages(await transcript(app, ids.source)), b1: messages(await transcript(app, ids.b1)), b2: messages(await transcript(app, ids.b2)) };
  record.steps.afterReload = {
    branchesListed: [ids.b1, ids.b2].every((id) => after.some((s) => s.id === id)),
    titles: after.map((s) => s.title?.replace(ID, "<id>")),
    messagesKept: Object.fromEntries(Object.keys(kept).map((k) => [k, JSON.stringify(kept[k]) === JSON.stringify(again[k])])),
    messageCounts: Object.fromEntries(Object.keys(kept).map((k) => [k, [kept[k].length, again[k].length]])),
    rowsOnScreen: await app.ev(`[...document.querySelectorAll('button.session-select')].map((b) => b.title)`).then((t) => t.map((x) => x.replace(ID, "<id>"))),
  };
  record.processes = processTree(inst.pid).map((p) => p.command.replace(/^.*\//, "").slice(0, 120));
} catch (error) {
  record.failure = String(error?.message ?? error).replaceAll(ID, "<id>");
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}

// 8. The engine's own record, read by a separate echo host once the app is gone.
if (ids.source) {
  const reader = createHost(DEFAULT_ENGINE, projectReal, ["--provider", "echo", "--disable-sandbox"]);
  record.engineRecord = {};
  try {
    await connect(reader);
    for (const [name, sid] of Object.entries({ source: ids.source, b1: ids.b1, b2: ids.b2 })) {
      if (!sid) continue;
      const read = await reader.request("session/read", { sessionId: sid, excludeItems: false }).catch((e) => ({ error: e.message }));
      if (read.error) { record.engineRecord[name] = { error: bounded(read.error, 160) }; continue; }
      const items = read.history?.items ?? [];
      record.engineRecord[name] = {
        workspaceIsProject: [projectReal, project].includes(read.session.workspaceRoot),
        turnCount: read.session.turnCount,
        forkedFrom: read.session.forkedFrom ? { sourceIsTheSource: read.session.forkedFrom.sessionId === ids.source, cutExplicit: read.session.forkedFrom.cutExplicit, cut: String(read.session.forkedFrom.cutCursor).replace(/^.*:turn:/, "turn:") } : null,
        userMessages: items.filter((i) => i.kind === "userMessage").map((i) => bounded(String(i.text).replaceAll(ID, "<id>"), 120)),
        agentMessages: items.filter((i) => i.kind === "agentMessage").length,
      };
    }
  } catch (error) {
    record.engineRecord.failure = bounded(String(error?.message ?? error), 200);
  } finally {
    await reader.stop();
  }
}

process.stderr.write(`session ids: ${JSON.stringify(ids)}\n`);
const s = record.steps;
const e = record.engineRecord ?? {};
const sourceUsers = e.source?.userMessages ?? [];
record.verdict = {
  engineIs142: record.engine === "Muse Code 1.4.2 (1.4.2-R4684.1)",
  earlierTurnForkFailsCleanly: s.forkEarlierTurn?.ok === false && s.forkEarlierTurn.anchorIsTurn1 && s.forkEarlierTurn.sessionsUnchanged && s.forkEarlierTurn.activeUnchanged && Boolean(s.forkEarlierTurn.banner),
  invalidPointRefused: s.forkUnknownAnchor?.ok === false && s.forkUnknownAnchor.sessionsUnchanged,
  branchCreatedFromLatestTurn: s.forkLatestTurn?.anchorIsTurn2 && s.forkLatestTurn.newId && s.forkLatestTurn.active && s.forkLatestTurn.sameWorkspace && s.forkLatestTurn.hasBothTurns && s.forkLatestTurn.noOpenEntries,
  draftsNotShared: s.forkLatestTurn?.branchComposer === "" && !s.forkLatestTurn.branchDraftStored && s.forkLatestTurn.sourceDraftKept && String(s.sourceComposerOnReturn).includes("DRAFT-"),
  branchHasRealHistory: s.b1Turn?.knowsAlpha && s.b1Turn.knowsBeta && s.b1Turn.knowsGamma,
  activeSourceForkCreated: Boolean(s.forkActiveSource?.sourceRunningBeforeFork && s.forkActiveSource.sourceRunningAfterFork && ids.b2 && s.forkActiveSource.noOpenEntries),
  activeSourceBranchOnScreenStopsAtLastCompletedTurn: s.forkActiveSource?.carriesRunningTurnUserMessage === false && s.forkActiveSource.carriesPartialAnswer === false,
  activeSourceBranchInEngineStopsAtLastCompletedTurn: e.b2?.turnCount === 2 && e.b2?.forkedFrom?.cut === "turn:2"
    && JSON.stringify(e.b2?.userMessages) === JSON.stringify(sourceUsers.slice(0, 2)) && e.b2?.agentMessages === 2,
  sourceUnchangedAndIndependent: s.sourceTurn3?.knowsAlpha && s.sourceTurn3.knowsBeta && !s.sourceTurn3.knowsGamma && s.b2UntouchedBySourceTurn
    && sourceUsers.length === 3 && e.source?.forkedFrom === null,
  survivesReload: s.afterReload?.branchesListed && Object.values(s.afterReload.messagesKept ?? {}).every(Boolean),
  engineProvenance: e.b1?.forkedFrom?.sourceIsTheSource && e.b1.forkedFrom.cutExplicit === true && e.b1.forkedFrom.cut === "turn:2"
    && e.b2?.forkedFrom?.sourceIsTheSource && e.b2.forkedFrom.cutExplicit === false && e.source?.forkedFrom === null,
  engineBranchIsTheRealCopy: e.b1?.workspaceIsProject && e.b2?.workspaceIsProject
    && JSON.stringify(e.b1?.userMessages?.slice(0, 2)) === JSON.stringify(sourceUsers.slice(0, 2)) && e.b1?.userMessages?.length === 3,
  noProcessLeft: record.stop?.leftAfterQuit?.length === 0 && record.stop?.groupLeftAfterQuit?.length === 0,
  defaultStoresUnchanged: record.stop?.defaultStoresUnchangedAtEnd === true,
};
const out = redact(record);
const text = `${JSON.stringify(out, null, 2)}\n`;
if (OUT) { mkdirSync(dirname(resolve(OUT)), { recursive: true }); writeFileSync(OUT, text); }
process.stdout.write(text);
