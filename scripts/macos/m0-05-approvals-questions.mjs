#!/usr/bin/env node
/**
 * M0-05 on macOS: approvals and questions stay answerable after an incident
 * (host restart, window reload), each choice reaches only its target. The
 * macOS replay of the Windows M0-05 scenario (m0-05-06-approvals.json,
 * m0-05-questions.json, m0-05-final.json) on the pinned 1.4.2 engine, in an
 * isolated test instance (scripts/macos/test-instance.mjs), one fresh instance
 * and data folder per phase. Posture Ask (promptUnmatched) unless stated.
 *
 * Phases (--phases a,b,...; results merge into --out):
 *   reject    1 turn. A shell write with a variable argument (the host cannot
 *             clear it statically): the card shows the host's choices; the
 *             posture is switched to "Ask only for more access" and back with
 *             the card pending (still pending, still decidable); Reject: tool
 *             denied, no false resume, no file.
 *   reload    1 turn. Card pending, page reloaded: the card comes back from
 *             list_pending_requests with no action; a real double-click on the
 *             accepting choice sends one decision per stage (or a stale one
 *             refused -32053 with a calm notice); a replay of a decided stage's
 *             token through invoke('approve') is refused; the file is written.
 *   two       2 turns. Projects A and B wait on cards together; A's exact
 *             tool_request is copied into B (same approval id, same token);
 *             deciding A reaches A only: B's host still lists B's approval
 *             with the same token, B's cards stay; then B is decided.
 *   kill      1 turn. Card pending, the app is killed (SIGKILL) and relaunched
 *             on the same data: no phantom card, the cancel line once, the
 *             conversation not left working, no file.
 *   questions 2 turns. A asks two single-select questions in a row, B one
 *             pick-exactly-two question; both wait together; A's question is
 *             copied into B; A answered with Cmd+Enter reaches A only; A's
 *             second question skipped with a double-click (one cancel); B's
 *             one-box answer refused (-32057) and corrected on the same card.
 *   death     2 turns. A and B each wait on a question; A's engine alone is
 *             killed with the app open: A's card removed with the cancel line,
 *             Reconnect works, no phantom card; then the app is closed from
 *             its window with B's question pending and relaunched: no card,
 *             the cancel line once, not left working.
 *
 *   node scripts/macos/m0-05-approvals-questions.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9424] [--base $TMPDIR/muse-proofs-g2/m0-05] [--phases reject,reload,two,kill,questions,death]
 *     [--out docs/evidence/2026-10-13-macos-closure/m0-05-approvals-questions.json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { INSTALL_IPC_TRACE, argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { engineVersion, launch, processTree } from "./test-instance.mjs";
import {
  INSTALL_FORGE, addProject, approvalButton, decideAll, engines, fullLog, installTraces, ipc, labelOf, macPlatform,
  mouseOn, page, pending, runRedactor, select, setPosture, startIn, untilIdle, waitCard,
} from "./m0-05-06-common.mjs";

const EXE = resolve(argValue("--exe", join(homedir(), "muse-proofs", "app", "08b291d", "muse-desktop")));
const PORT = Number(argValue("--port", "9424"));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g2", "m0-05")));
const PHASES = argValue("--phases", "reject,reload,two,kill,questions,death").split(",");
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m0-05-approvals-questions.json");
const RUN = join(BASE, `run-${Date.now().toString(36)}`);
const redact = runRedactor([[RUN, "<run>"], [BASE, "<proof>"]]);
const recipe = (tag) => `Use your shell tool to run exactly this command in the workspace, unchanged, once, then answer in one short line: m='${tag}'; printf '%s\\n' "$m" > probe.txt` +
  " Do not use any file-writing tool and do not run anything else.";
const Q_TWO = 'Before anything else, call your request_user_input tool exactly once, with one single-select question: id "fruit", header "Fruit", question "Which fruit should I name?", options "Apple", "Banana", "Cherry". After my answer, call request_user_input once more with one single-select question: id "veg", header "Vegetable", question "Which vegetable should I name?", options "Carrot", "Leek", "Pea". Then reply with exactly first=<the fruit or SKIPPED> second=<the vegetable or SKIPPED>, in capital letters. Use no other tool.';
const Q_PAIR = 'Before anything else, call your request_user_input tool exactly once, with one multi-select question: id "colors", header "Colors", question "Pick exactly two colors", options "Red", "Green", "Blue", selection {"mode": "multiple", "min_selections": 2, "max_selections": 2}. After my answer, reply with only the colors I picked, in capital letters, joined by a plus sign. Use no other tool.';
const Q_ONE = (id) => `Before anything else, call your request_user_input tool exactly once, with one single-select question: id "${id}", header "Pick", question "Which letter should I name?", options "Alpha", "Beta", "Gamma". After my answer, reply with only the letter name I picked, in capital letters. Use no other tool.`;

const CANCEL_APPROVAL = /Approval cancelled: Muse closed before you answered, so the action did not run\./;
const CANCEL_INPUT = /Input cancelled: Muse stopped before you answered\./;
const CANCEL_INPUT_RESTART = /Input cancelled: Muse closed before you answered\./;

function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }

/** A fresh instance with projects (name -> folder) created through the Projects panel. */
async function freshInstance(name, projects, extra = {}) {
  const data = join(RUN, name, "data");
  const folders = {};
  for (const key of Object.keys(projects)) {
    folders[key] = join(RUN, name, projects[key]);
    mkdirSync(folders[key], { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: folders[key] });
  }
  const inst = await launch({ exe: EXE, port: PORT, data, ...extra });
  await waitFor(() => inst.app.ev(page("return q('.primary-nav button[aria-label=\"New conversation\"]').length > 0;")), 60_000);
  await installTraces(inst.app);
  const ids = {};
  for (const key of Object.keys(projects)) {
    ids[key] = await addProject(inst.app, `m05-${name}-${key.toLowerCase()}`, folders[key]);
    if (!ids[key]) throw new Error(`project ${key} not created`);
  }
  return { inst, data, folders, ids };
}

const fileOf = (folder) => (existsSync(join(folder, "probe.txt")) ? readFileSync(join(folder, "probe.txt"), "utf8").trim() : null);

// ---- approvals --------------------------------------------------------------

async function rejectPhase() {
  const { inst, folders, ids } = await freshInstance("reject", { A: "a" });
  const app = inst.app;
  const r = { liveTurns: 1, isolation: inst.isolation };
  try {
    r.posture = await app.ev("localStorage.getItem('muse-desktop.authorization-mode.v1')");
    const { sid, startSession } = await startIn(app, ids.A, recipe("m05-reject"));
    r.startSession = startSession;
    r.engineArgv = Object.values(engines(inst.pid));
    const card = await waitCard(app, sid);
    if (!card) throw new Error("no approval card");
    r.card = { msToCard: card.msToCard, host: card.snap.approvals[0], dom: card.ui.cards[0] };
    r.cardButtonsAreHostChoices = JSON.stringify(card.ui.cards[0].buttons) === JSON.stringify(card.snap.approvals[0].choices.map((c) => c.label));
    // Posture switch with the card pending, then back.
    const before = JSON.stringify(card.snap.approvals[0].requirement);
    r.toMiddle = await setPosture(app, "workspace");
    await sleep(1_500);
    const mid = await pending(app, sid);
    r.afterSwitch = { stillPending: mid.approvals.length === 1, sameRequirement: JSON.stringify(mid.approvals[0]?.requirement) === before,
      cardStillPainted: (await app.ev(page("return view().cards.length;"))) > 0 };
    r.backToAsk = await setPosture(app, "ask");
    await sleep(1_000);
    r.setApprovalMode = (await ipc(app, "set_approval_mode")).map((c) => ({ mode: c.args?.mode, ok: c.ok, result: (c.result ?? "").slice(0, 300) }));
    await select(app, sid);
    // Reject every stage the host raises.
    r.stages = await decideAll(app, sid, false);
    r.decideCalls = (await ipc(app, "approve")).map((c) => ({ sessionId: c.args?.sessionId === sid, choiceId: c.args?.choiceId, ok: c.ok, result: (c.result ?? "").slice(0, 200) }));
    r.end = await untilIdle(app, sid);
    r.noFalseResume = !r.end.healthSamples.some((s) => /resuming/i.test(s.health));
    r.file = fileOf(folders.A);
    r.transcript = (await fullLog(app, sid)).filter((e) => e.role !== "user").slice(-6).map((e) => ({ role: e.role, text: e.text.slice(0, 240) }));
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stop = await inst.stop();
  }
  r.verdict = {
    cardShowsHostChoices: r.cardButtonsAreHostChoices === true && !r.card?.dom?.noChoices,
    postureSwitchKeepsCardDecidable: Boolean(r.afterSwitch?.stillPending && r.afterSwitch.sameRequirement && r.afterSwitch.cardStillPainted),
    postureReachedHost: ["onRequest", "promptUnmatched"].every((m) => (r.setApprovalMode ?? []).some((c) => c.ok && c.result.includes(`"mode":"${m}"`))),
    rejectDenies: r.file === null && (r.stages ?? []).length > 0 && r.end?.idle === true,
    noFalseResume: r.noFalseResume === true,
  };
  return r;
}

async function reloadPhase() {
  const { inst, folders, ids } = await freshInstance("reload", { A: "a" });
  const app = inst.app;
  const r = { liveTurns: 1, isolation: inst.isolation };
  try {
    const { sid, startSession } = await startIn(app, ids.A, recipe("m05-reload"));
    r.startSession = startSession;
    const card = await waitCard(app, sid);
    if (!card) throw new Error("no approval card");
    const first = card.snap.approvals[0];
    r.beforeReload = { approvalId: first.approvalId, requirement: first.requirement, cards: card.ui.cards.length };
    await app.ev("(window.__beforeReload = true)");
    await app.send("Page.reload", {});
    await waitFor(() => app.ev("!window.__beforeReload && document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 300);
    await app.ev(INSTALL_IPC_TRACE);
    await app.ev(INSTALL_FORGE);
    if ((await app.ev(page("return activeSid();"))) !== sid) await select(app, sid);
    const back = await waitFor(() => app.ev(page("return view().cards.length > 0 ? view() : null;")), 30_000, 500);
    const after = await pending(app, sid);
    r.afterReload = { cardBack: Boolean(back), cards: back?.cards.length ?? 0, sameApproval: after.approvals[0]?.approvalId === first.approvalId,
      sameRequirement: JSON.stringify(after.approvals[0]?.requirement) === JSON.stringify(first.requirement), decideCallsBeforeAnyClick: (await ipc(app, "approve")).length };
    // A real double-click on the accepting choice of stage 0.
    const label = labelOf(after, true);
    r.doubleClick = await mouseOn(app, approvalButton(label), 2);
    await sleep(2_500);
    r.afterDoubleClick = { approveCalls: (await ipc(app, "approve")).map((c) => ({ requirement: JSON.stringify(c.args?.requirementId), choiceId: c.args?.choiceId, ok: c.ok, result: (c.result ?? "").slice(0, 200) })),
      alerts: await app.ev(page("return alerts();")) };
    // Stale replay of stage 0's token, once the host has moved on (or resolved).
    r.staleReplay = await app.ev(`window.__TAURI_INTERNALS__.invoke('approve', { sessionId: ${JSON.stringify(sid)}, approvalId: ${JSON.stringify(first.approvalId)},
      choiceId: ${JSON.stringify(first.choices.find((c) => c.label === label)?.choiceId)}, requirementId: ${JSON.stringify(first.requirement)} })
      .then((v) => ({ accepted: true, value: v }), (e) => ({ refused: String(e).slice(0, 240) }))`);
    r.rest = await decideAll(app, sid, true);
    r.end = await untilIdle(app, sid);
    r.file = fileOf(folders.A);
    r.transcript = (await fullLog(app, sid)).filter((e) => e.role !== "user").slice(-6).map((e) => ({ role: e.role, text: e.text.slice(0, 240) }));
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stop = await inst.stop();
  }
  const calls = r.afterDoubleClick?.approveCalls ?? [];
  const stage0 = JSON.stringify(r.beforeReload?.requirement);
  r.verdict = {
    cardRebuiltAfterReloadWithoutAction: Boolean(r.afterReload?.cardBack && r.afterReload.sameApproval && r.afterReload.sameRequirement && r.afterReload.decideCallsBeforeAnyClick === 0),
    doubleClickOneDecision: calls.filter((c) => c.ok).length === 1 && calls.every((c) => c.requirement === stage0) && (calls.length === 1 || calls.filter((c) => !c.ok).every((c) => /-32053|stale|already/i.test(c.result))),
    staleTokenRefused: Boolean(r.staleReplay?.refused),
    turnEndsWithTheAction: r.end?.idle === true,
  };
  r.fileWritten = r.file === "m05-reload";
  return r;
}

async function twoPhase() {
  const { inst, folders, ids } = await freshInstance("two", { A: "a", B: "b" });
  const app = inst.app;
  const r = { liveTurns: 2, isolation: inst.isolation };
  try {
    const a = await startIn(app, ids.A, recipe("m05-two-a"));
    const cardA = await waitCard(app, a.sid);
    const b = await startIn(app, ids.B, recipe("m05-two-b"));
    const cardB = await waitCard(app, b.sid);
    if (!cardA || !cardB) throw new Error(`cards: A ${Boolean(cardA)}, B ${Boolean(cardB)}`);
    const pa = await pending(app, a.sid);
    const pb = await pending(app, b.sid);
    r.together = { aPending: pa.approvals.length, bPending: pb.approvals.length };
    // A's exact tool_request copied into B.
    const seenA = (await app.ev("window.__forge.seen")).filter((e) => e.kind === "tool_request" && e.session_id === a.sid).at(-1);
    await app.ev(`(window.__forge.queue.push({ kind: 'tool_request', session_id: ${JSON.stringify(b.sid)}, payload: ${JSON.stringify(seenA?.payload ?? null)} }), true)`);
    await select(app, b.sid);
    await sleep(2_000);
    r.bCardsWithForged = await app.ev(page("return view().cards.map((c) => ({ key: c.key, buttons: c.buttons }));"));
    r.forgedApplied = (await app.ev("window.__forge.applied.length")) === 1;
    // Decide A, every stage.
    await select(app, a.sid);
    const approveBefore = (await ipc(app, "approve")).length;
    r.aStages = await decideAll(app, a.sid, true);
    r.aEnd = await untilIdle(app, a.sid);
    r.aApproveCalls = (await ipc(app, "approve")).slice(approveBefore).map((c) => ({ toA: c.args?.sessionId === a.sid, toB: c.args?.sessionId === b.sid, ok: c.ok }));
    const pb2 = await pending(app, b.sid);
    await select(app, b.sid);
    await sleep(1_000);
    r.bAfterA = { hostStillPending: pb2.approvals.length, sameRequirement: JSON.stringify(pb2.approvals[0]?.requirement) === JSON.stringify(pb.approvals[0]?.requirement),
      cards: await app.ev(page("return view().cards.map((c) => ({ key: c.key, buttons: c.buttons }));")) };
    // Then B's own card.
    const bKey = `${b.sid}:${pb.approvals[0].approvalId}`;
    const bStages = [];
    for (let i = 0; i < 5; i++) {
      const snap = await pending(app, b.sid);
      if (snap.approvals.length === 0) break;
      const req = JSON.stringify(snap.approvals[0].requirement);
      bStages.push(await mouseOn(app, approvalButton(labelOf(snap, true), bKey)));
      await waitFor(async () => { const n = await pending(app, b.sid); return n.approvals.length === 0 || JSON.stringify(n.approvals[0].requirement) !== req; }, 30_000, 400);
      await sleep(1_500);
    }
    r.bStages = bStages;
    // B's own approval decided: the host lists nothing, B's turn ends with its reply. The forged
    // copy of A's card stays painted in B (no host behind it) until the page re-reads the host.
    r.bHostPendingAfter = (await pending(app, b.sid)).approvals.length;
    r.bReplied = Boolean(await waitFor(async () => (await fullLog(app, b.sid)).some((e) => e.role === "assistant"), 120_000, 1_000));
    r.files = { A: fileOf(folders.A), B: fileOf(folders.B) };
    r.bCardsBeforeReload = await app.ev(page("return view().cards.map((c) => c.key);"));
    await app.ev("(window.__beforeReload = true)");
    await app.send("Page.reload", {});
    await waitFor(() => app.ev("!window.__beforeReload && document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 300);
    await installTraces(app);
    if ((await app.ev(page("return activeSid();"))) !== b.sid) await select(app, b.sid);
    await sleep(3_000);
    r.bEnd = await untilIdle(app, b.sid, 60_000);
    r.bCardsAfterReload = await app.ev(page("return view().cards.map((c) => c.key);"));
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stop = await inst.stop();
  }
  r.verdict = {
    bothWaitingTogether: r.together?.aPending === 1 && r.together.bPending === 1,
    forgedSameIdInB: r.forgedApplied === true && (r.bCardsWithForged ?? []).length === 2,
    decidingAReachesOnlyA: (r.aApproveCalls ?? []).length > 0 && r.aApproveCalls.every((c) => c.toA && !c.toB) && r.aEnd?.idle === true,
    bUntouched: r.bAfterA?.hostStillPending === 1 && r.bAfterA.sameRequirement && r.bAfterA.cards.length === 2,
    bDecidedAfterwards: r.bHostPendingAfter === 0 && r.bReplied === true && r.files?.B === "m05-two-b",
    forgedCardGoneAfterReload: (r.bCardsAfterReload ?? [1]).length === 0 && r.bEnd?.idle === true,
  };
  return r;
}

async function killPhase() {
  const { inst, data, folders, ids } = await freshInstance("kill", { A: "a" });
  let app = inst.app;
  const r = { liveTurns: 1, isolation: inst.isolation };
  let sid;
  let second = null;
  try {
    ({ sid } = await startIn(app, ids.A, recipe("m05-kill")));
    const card = await waitCard(app, sid);
    if (!card) throw new Error("no approval card");
    r.cardPending = true;
    const engineBefore = Object.keys(engines(inst.pid)).map(Number);
    process.kill(inst.pid, "SIGKILL");
    r.appKilled = Boolean(await waitFor(() => inst.child.exitCode !== null || inst.child.signalCode !== null, 10_000, 100));
    await sleep(2_000);
    r.enginesAliveAfterKill = engineBefore.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length;
  } finally {
    r.stopKilled = await inst.stop({ keepStore: true });
  }
  try {
    second = await launch({ exe: EXE, port: PORT, data });
    app = second.app;
    await installTraces(app);
    await waitFor(() => app.ev(page(`return Boolean(document.querySelector('li.session-item[data-session-id="${sid}"]'));`)), 30_000);
    await select(app, sid);
    r.connected = Boolean(await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 60_000, 1_000));
    await sleep(8_000);
    r.afterRelaunch = await app.ev(page("return view();"));
    r.hostPending = await pending(app, sid);
    const log = await fullLog(app, sid);
    r.cancelLines = log.filter((e) => CANCEL_APPROVAL.test(e.text)).length;
    r.transcript = log.filter((e) => e.role !== "user").slice(-5).map((e) => ({ role: e.role, text: e.text.slice(0, 240) }));
    r.running = await app.ev(page(`return running(${JSON.stringify(sid)});`));
    r.decideCalls = (await ipc(app, "approve")).length;
    r.file = fileOf(folders.A);
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    if (second) r.stop = await second.stop();
  }
  r.verdict = {
    appForceKilled: r.appKilled === true,
    enginesEndedWithTheApp: r.enginesAliveAfterKill === 0,
    reopenedAndConnected: r.connected === true,
    noPhantomCard: (r.afterRelaunch?.cards ?? [1]).length === 0 && (r.hostPending?.approvals ?? [1]).length === 0,
    cancelLineOnce: r.cancelLines === 1,
    notLeftWorking: r.running !== "true",
    noDecisionSentNoFile: r.decideCalls === 0 && r.file === null,
  };
  return r;
}

// ---- questions -----------------------------------------------------------------

const inputCard = (sid, inputId) => `q('.approval').find((g) => /^Input needed/.test(g.getAttribute('aria-label') || '') && fiberKey(g) === ${JSON.stringify(`${sid}:${inputId}`)})`;

async function questionsPhase() {
  const { inst, ids } = await freshInstance("questions", { A: "a", B: "b" });
  const app = inst.app;
  const r = { liveTurns: 2, isolation: inst.isolation };
  try {
    const a = await startIn(app, ids.A, Q_TWO);
    const qa = await waitCard(app, a.sid, { kind: "input" });
    const b = await startIn(app, ids.B, Q_PAIR);
    const qb = await waitCard(app, b.sid, { kind: "input" });
    if (!qa || !qb) throw new Error(`questions: A ${Boolean(qa)}, B ${Boolean(qb)}`);
    const pa = await pending(app, a.sid);
    const pb = await pending(app, b.sid);
    r.together = { a: pa.inputs.length, b: pb.inputs.length, rawKeys: pa.rawKeys };
    // A's question copied into B.
    const seenA = (await app.ev("window.__forge.seen")).filter((e) => e.kind === "input_request" && e.session_id === a.sid).at(-1);
    await app.ev(`(window.__forge.queue.push({ kind: 'input_request', session_id: ${JSON.stringify(b.sid)}, payload: ${JSON.stringify(seenA?.payload ?? null)} }), true)`);
    await select(app, b.sid);
    await sleep(2_000);
    r.bInputsWithForged = await app.ev(page("return view().inputs;"));
    // A: pick Apple with a click, answer with Cmd+Enter on the card.
    await select(app, a.sid);
    const aId = pa.inputs[0].id;
    r.aPick = await mouseOn(app, `const c = ${inputCard(a.sid, aId)}; return c ? [...c.querySelectorAll('.input-question button')].find((n) => n.innerText.trim() === 'Apple') : null;`);
    await app.ev(page(`const c = ${inputCard(a.sid, aId)}; c?.querySelector('.input-question button[aria-pressed="true"]')?.focus(); return Boolean(c);`));
    const answersBefore = (await ipc(app, "answer_input")).length;
    await app.ev("(window.__keys = [], window.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, target: e.target?.tagName, trusted: e.isTrusted }), { capture: true }), true)");
    r.focusBeforeKey = await app.ev("document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.innerText || '').trim().slice(0, 20) : null");
    await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 4, text: "\r" });
    await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 4 });
    await sleep(2_000);
    r.keysSeen = await app.ev("window.__keys");
    r.aAnswer = (await ipc(app, "answer_input")).slice(answersBefore).map((c) => ({ toA: c.args?.sessionId === a.sid, toB: c.args?.sessionId === b.sid, answers: c.args?.answers, ok: c.ok }));
    if (r.aAnswer.length === 0) {
      // Cmd+Enter did not answer: the scenario goes on with a click on Send answer (recorded).
      r.aAnswerFallbackClick = await mouseOn(app, `const c = ${inputCard(a.sid, aId)}; return c ? [...c.querySelectorAll('.approval-actions button')].find((n) => n.innerText.trim() === 'Send answer') : null;`);
      await sleep(2_000);
      r.aAnswerByClick = (await ipc(app, "answer_input")).slice(answersBefore).map((c) => ({ toA: c.args?.sessionId === a.sid, toB: c.args?.sessionId === b.sid, answers: c.args?.answers, ok: c.ok }));
    }
    const pb2 = await pending(app, b.sid);
    r.bAfterAAnswer = { hostInputs: pb2.inputs.map((x) => x.id), sameAsBefore: JSON.stringify(pb2.inputs.map((x) => x.id)) === JSON.stringify(pb.inputs.map((x) => x.id)) };
    // A's second question: Skip double-clicked.
    const q2 = await waitFor(async () => { const p = await pending(app, a.sid); return p.inputs.find((x) => x.id !== aId) ?? null; }, 120_000, 700);
    r.aSecondQuestion = Boolean(q2);
    if (q2) {
      await waitFor(() => app.ev(page(`return Boolean(${inputCard(a.sid, q2.id)});`)), 20_000, 300);
      const cancelsBefore = (await ipc(app, "cancel_input")).length;
      r.skipDouble = await mouseOn(app, `const c = ${inputCard(a.sid, q2.id)}; return c ? [...c.querySelectorAll('.approval-actions button')].find((n) => n.innerText.trim() === 'Skip') : null;`, 2);
      await sleep(2_000);
      r.skipCalls = (await ipc(app, "cancel_input")).slice(cancelsBefore).map((c) => ({ toA: c.args?.sessionId === a.sid, ok: c.ok }));
      r.answersAfterSkip = (await ipc(app, "answer_input")).length - answersBefore;
    }
    r.aEnd = await untilIdle(app, a.sid, 150_000);
    r.aReply = (await fullLog(app, a.sid)).filter((e) => e.role === "assistant").map((e) => e.text).join(" ").match(/first=\S+\s+second=\S+/i)?.[0] ?? null;
    // B: one box, refused; a second box on the same card, accepted.
    await select(app, b.sid);
    const bId = pb.inputs[0].id;
    const box = (label) => `const c = ${inputCard(b.sid, bId)}; return c ? [...c.querySelectorAll('label.check')].find((l) => l.innerText.trim() === ${JSON.stringify(label)})?.querySelector('input') : null;`;
    const send = `const c = ${inputCard(b.sid, bId)}; return c ? [...c.querySelectorAll('.approval-actions button')].find((n) => n.innerText.trim() === 'Send answer') : null;`;
    await mouseOn(app, box("Red"));
    const bBefore = (await ipc(app, "answer_input")).length;
    await mouseOn(app, send);
    await sleep(2_500);
    r.bFirst = { calls: (await ipc(app, "answer_input")).slice(bBefore).map((c) => ({ toB: c.args?.sessionId === b.sid, ok: c.ok, result: (c.result ?? "").slice(0, 200) })),
      card: await app.ev(page(`const c = ${inputCard(b.sid, bId)}; return c ? { present: true, redTicked: [...c.querySelectorAll('label.check')].find((l) => l.innerText.trim() === 'Red')?.querySelector('input').checked ?? null, error: c.querySelector('[role="alert"]')?.innerText || null } : { present: false };`)),
      alerts: await app.ev(page("return alerts();")),
      hostStillWaiting: (await pending(app, b.sid)).inputs.some((x) => x.id === bId) };
    await mouseOn(app, box("Green"));
    const bBefore2 = (await ipc(app, "answer_input")).length;
    await mouseOn(app, send);
    await sleep(2_000);
    r.bSecond = (await ipc(app, "answer_input")).slice(bBefore2).map((c) => ({ toB: c.args?.sessionId === b.sid, ok: c.ok, answers: c.args?.answers }));
    r.bReply = await waitFor(async () => (await fullLog(app, b.sid)).filter((e) => e.role === "assistant").map((e) => e.text).join(" ").match(/[A-Z]+\+[A-Z]+/)?.[0] ?? null, 150_000, 1_000);
    r.bHostInputsAfter = (await pending(app, b.sid)).inputs.length;
    // The forged copy of A's question stays painted in B (no host behind it) until the page re-reads the host.
    r.bInputsBeforeReload = await app.ev(page("return view().inputs.map((c) => c.questions);"));
    await app.ev("(window.__beforeReload = true)");
    await app.send("Page.reload", {});
    await waitFor(() => app.ev("!window.__beforeReload && document.readyState === 'complete' && Boolean(document.querySelector('.primary-nav'))").catch(() => false), 30_000, 300);
    await installTraces(app);
    if ((await app.ev(page("return activeSid();"))) !== b.sid) await select(app, b.sid);
    await sleep(3_000);
    r.bEnd = await untilIdle(app, b.sid, 60_000);
    r.bAfterReload = { inputs: await app.ev(page("return view().inputs.length;")), cancelLines: (await fullLog(app, b.sid)).filter((e) => CANCEL_INPUT.test(e.text)).length };
    r.consoleErrors = app.errors.slice(0, 10);
  } finally {
    r.stop = await inst.stop();
  }
  // Not an M0-05 criterion (the answer path is), kept as an observation: WebKit does not focus a
  // button on a mouse click, so Cmd+Enter after a mouse pick lands on <body>, outside the card.
  r.observations = { cmdEnterAfterMousePick: (r.aAnswer ?? []).length === 1 && r.aAnswer[0].ok ? "answered" : `not answered (key reached ${r.keysSeen?.[0]?.target ?? "nothing"}, focus ${r.focusBeforeKey ?? "?"}); answered by a click on Send answer` };
  r.verdict = {
    bothWaitingTogether: r.together?.a === 1 && r.together.b === 1,
    forgedSameQuestionInB: (r.bInputsWithForged ?? []).length === 2,
    answerReachesAOnly: [...(r.aAnswer ?? []), ...(r.aAnswerByClick ?? [])].filter((c) => c.ok).length === 1 && [...(r.aAnswer ?? []), ...(r.aAnswerByClick ?? [])].every((c) => c.toA && !c.toB),
    bUnchangedWhileAAnswered: r.bAfterAAnswer?.sameAsBefore === true,
    skipDoubleClickOneCancel: (r.skipCalls ?? []).length === 1 && r.skipCalls[0].ok && r.answersAfterSkip === 1,
    aReplyFollowsAnswers: /first=APPLE\s+second=SKIPPED/i.test(r.aReply ?? ""),
    oneBoxRefused: (r.bFirst?.calls ?? []).length === 1 && !r.bFirst.calls[0].ok && /-32057|min/i.test(r.bFirst.calls[0].result) && r.bFirst.card.present && r.bFirst.card.redTicked === true && r.bFirst.hostStillWaiting,
    refusalShown: (r.bFirst?.alerts ?? []).some((t) => /answer_input failed|invalid/i.test(t)) || Boolean(r.bFirst?.card?.error),
    correctedOnSameCard: (r.bSecond ?? []).length === 1 && r.bSecond[0].ok && /RED\+GREEN|GREEN\+RED/.test(r.bReply ?? "") && r.bHostInputsAfter === 0,
    forgedCardGoneAfterReloadNoCancelLine: r.bAfterReload?.inputs === 0 && r.bAfterReload.cancelLines === 0 && r.bEnd?.idle === true,
  };
  return r;
}

async function deathPhase() {
  const { inst, data, folders, ids } = await freshInstance("death", { A: "a", B: "b" });
  let app = inst.app;
  const r = { liveTurns: 2, isolation: inst.isolation };
  let a;
  let b;
  let second = null;
  try {
    const enginesBefore = engines(inst.pid);
    a = await startIn(app, ids.A, Q_ONE("death"));
    const aEngine = Object.keys(engines(inst.pid)).find((pid) => !(pid in enginesBefore));
    const qa = await waitCard(app, a.sid, { kind: "input" });
    b = await startIn(app, ids.B, Q_ONE("restart"));
    const qb = await waitCard(app, b.sid, { kind: "input" });
    if (!qa || !qb || !aEngine) throw new Error(`questions: A ${Boolean(qa)}, B ${Boolean(qb)}, A's engine ${aEngine}`);
    // A's engine alone (the one its start spawned) is killed, the app open.
    await select(app, a.sid);
    const allBefore = Object.keys(engines(inst.pid));
    process.kill(Number(aEngine), "SIGKILL");
    r.onlyAsEngineKilled = Boolean(await waitFor(() => { const now = Object.keys(engines(inst.pid)); return !now.includes(aEngine) && now.length === allBefore.length - 1 ? true : null; }, 15_000, 300));
    const gone = await waitFor(() => app.ev(page("return view().inputs.length === 0 ? view() : null;")), 30_000, 500);
    r.aAfterDeath = { cardRemoved: Boolean(gone), cancelLines: (await fullLog(app, a.sid)).filter((e) => CANCEL_INPUT.test(e.text)).length,
      pill: await app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() || null;")) };
    await app.ev(page("const b = q('button.workspace-button').find((n) => /^Reconnect/.test(n.innerText.trim())); if (b) b.click(); return !!b;"));
    r.aReconnected = Boolean(await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 60_000, 1_000));
    await sleep(6_000);
    r.aAfterReconnect = { cards: (await app.ev(page("return view().inputs.length;"))), answers: (await ipc(app, "answer_input")).length,
      cancelLines: (await fullLog(app, a.sid)).filter((e) => CANCEL_INPUT.test(e.text)).length, running: await app.ev(page(`return running(${JSON.stringify(a.sid)});`)) };
    // B's question still pending: the app is closed from its window.
    r.bPendingAtClose = (await pending(app, b.sid)).inputs.length;
    r.consoleErrorsFirst = app.errors.slice(0, 10);
  } finally {
    r.stopFirst = await inst.stop({ keepStore: true });
  }
  try {
    second = await launch({ exe: EXE, port: PORT, data });
    app = second.app;
    await installTraces(app);
    await waitFor(() => app.ev(page(`return Boolean(document.querySelector('li.session-item[data-session-id="${b.sid}"]'));`)), 30_000);
    await select(app, b.sid);
    r.bConnected = Boolean(await waitFor(() => app.ev(page("return document.querySelector('.connection-state')?.textContent.trim() === 'Connected';")), 60_000, 1_000));
    await sleep(60_000);
    r.bAfterRelaunch = { cards: await app.ev(page("return view().inputs.length;")), hostInputs: (await pending(app, b.sid)).inputs.length,
      cancelLines: (await fullLog(app, b.sid)).filter((e) => CANCEL_INPUT_RESTART.test(e.text)).length, running: await app.ev(page(`return running(${JSON.stringify(b.sid)});`)),
      health: await app.ev(page("return health();")),
      transcript: (await fullLog(app, b.sid)).filter((e) => e.role !== "user").slice(-4).map((e) => ({ role: e.role, text: e.text.slice(0, 200) })) };
    r.consoleErrorsSecond = app.errors.slice(0, 10);
  } finally {
    if (second) r.stop = await second.stop();
  }
  r.verdict = {
    onlyAsEngineKilled: r.onlyAsEngineKilled === true,
    aCardRemovedWithCancelLine: r.aAfterDeath?.cardRemoved === true && r.aAfterDeath.cancelLines >= 1,
    aReconnectWorks: r.aReconnected === true,
    aNoPhantomCardNoAnswer: r.aAfterReconnect?.cards === 0 && r.aAfterReconnect.answers === 0,
    bPendingAtClose: r.bPendingAtClose === 1,
    bClosedFromItsWindow: r.stopFirst?.quitBy === "window closed",
    bReopenedConnected: r.bConnected === true,
    bNoPhantomCard: r.bAfterRelaunch?.cards === 0,
    bCancelLineOnce: r.bAfterRelaunch?.cancelLines === 1,
    bNotLeftWorking: r.bAfterRelaunch?.running !== "true",
  };
  return r;
}

const TABLE = { reject: rejectPhase, reload: reloadPhase, two: twoPhase, kill: killPhase, questions: questionsPhase, death: deathPhase };

async function main() {
  mkdirSync(RUN, { recursive: true });
  const record = readJson(OUT, null) ?? {
    schema: "muse-desktop.m0-05-approvals-questions-macos.v1",
    ticket: "M0-05",
    commit: "08b291d",
    platform: macPlatform(),
    harness: `scripts/macos/m0-05-approvals-questions.mjs (+ scripts/macos/m0-05-06-common.mjs), port ${PORT}`,
    posture: "Ask -> promptUnmatched, no client auto-approval (decision 05/10); the reject phase switches to the middle posture (onRequest) and back with a card pending",
    phases: {},
  };
  record.date = new Date().toISOString().slice(0, 10);
  record.engine = engineVersion();
  record.isolation = "One isolated test instance per phase (scripts/macos/test-instance.mjs): fresh data folder and WKWebView store under the run folder, projects in folders under the run folder created through the Projects panel (folder dialog answered by the IPC trace), the pinned engine with MUSE_NO_AUTO_UPDATE=1; each phase's stop records the default stores unchanged and no process left. The engine's session store is shared with the user (ADR 0003).";
  record.method = "Real 1.4.2 turns. The approval recipe is a shell write with a variable argument (m='<tag>'; printf ... > probe.txt), which the host cannot clear statically; the question recipes call request_user_input with fixed ids and options. Clicks are real mouse events through the bridge (Input.dispatchMouseEvent, isTrusted), first messages are typed (Input.insertText) and sent with Enter. Decisions and answers are counted on the page's IPC transport (window.__baselineIpc); host state is read through list_pending_requests. The 'same id in two conversations' cases copy A's exact tool_request / input_request event into B's poll_events response, the path every bridge event takes to the renderer. Incidents: Page.reload, SIGKILL of the app, SIGKILL of one engine with the app open, a graceful close from the window (Tauri window close).";
  record.limits = [
    "Same scenario as the Windows closure, on the macOS engine 1.4.2: one approval stage per command here (bash), where Windows' PowerShell raised two or three.",
    "WebKit does not focus a button on a mouse click: after a mouse pick, Cmd+Enter (the card's documented shortcut) lands on <body> and does not answer (questions.observations); the answer path itself is proved by a click. Recorded for the backlog, not an M0-05 criterion.",
    "The forged copies (A's card or question in B) stay painted in B until the page re-reads the host; a reload removes them with no cancel line.",
    "The engine keeps listing a dead turn's question after a resume (upstream #92), as on Windows; the app filters on the running turn.",
    "Live turns: 9 recorded here; 9 more were spent in discarded attempts while the harness was being fixed (reload wait, input row ids, forged-card cleanup, the restart cancel line).",
  ];
  for (const phase of PHASES) {
    if (!TABLE[phase]) throw new Error(`unknown phase ${phase}`);
    let result;
    try {
      result = await TABLE[phase]();
    } catch (error) {
      result = { error: String(error?.message ?? error).slice(0, 400), appOutput: (error?.appOutput ?? []).slice(-10) };
    }
    record.phases[phase] = redact({ at: new Date().toISOString(), ...result });
    record.liveTurns = Object.values(record.phases).reduce((n, p) => n + (p.liveTurns ?? 0), 0);
    record.verdicts = Object.fromEntries(Object.entries(record.phases).map(([k, p]) => [k, p.verdict ?? { error: p.error }]));
    mkdirSync(join(OUT, ".."), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
    console.log(phase, JSON.stringify(record.verdicts[phase]));
  }
}

await main();
