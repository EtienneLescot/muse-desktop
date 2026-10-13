#!/usr/bin/env node
/**
 * M3-05 native macOS proof: invoke a skill with its real context, through
 * the composer of a conversation in the proof project.
 *
 * Plan acceptance (docs/plans/2026-09-15-agent-implementation-plan.md §M3-05):
 * a real invocation with a resource, a skill deleted between suggestion and
 * sending, a refused permission; no double insertion on retry. The Windows ☑
 * (27/09) rests on a host-catalogue skill executed by the live host.
 *
 * Skills of the proof project (the default folder, and the conversation's):
 *   .agents/skills/g6-host      in the host catalogue (1.4.2 lists .agents/skills):
 *                               sent as a native skill part, expanded by the host.
 *   .muse/skills/g6-ctx         client route (not in the host catalogue): its
 *                               resource context.txt is read just before sending
 *                               and sent inside <skill-resource>.
 *   .muse/skills/g6-gone        its resource is deleted after the scan.
 *   .muse/skills/g6-link-res    its resource is a symlink to a file outside the
 *                               skill directory: the native reader refuses it.
 *
 *   host      /g6-host -> a skill part; the reply quotes a code only SKILL.md holds. 1 turn.
 *   gone      /g6-gone -> a system entry, no send_input, no user bubble.
 *   refused   /g6-link-res -> refused by the reader, no send.
 *   retry     /g6-ctx with the first send refused by the harness (a failed
 *             send): one Unsent row; Retry -> the same expanded text sent once,
 *             one user entry; the reply quotes the code only context.txt holds. 1 turn.
 *
 *   node scripts/macos/m3-05-skill-invoke.mjs [--exe <muse-desktop>] [--port 9466]
 *     [--base $TMPDIR/muse-proofs-g6/m3-05] [--out docs/evidence/2026-10-13-macos-closure/m3-05-skill-invoke.json]
 *
 * Two live turns.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue } from "../cdp-harness.mjs";
import { launch } from "./test-instance.mjs";
import {
  EXE_DEFAULT, COMMIT, J, compareStamps, installTrace, ipcCalls, openExtensions, page, pickDefaultFolder, platform,
  processesMentioning, redactorFor, sleep, startConversationNoTurn, userEngineStamp, waitFor, waitTurn, writeRecord,
} from "./m3-g6-common.mjs";

const EXE = resolve(argValue("--exe", EXE_DEFAULT));
const PORT = Number(argValue("--port", "9466"));
const ID = Date.now().toString(36);
const BASE = join(resolve(argValue("--base", join(tmpdir(), "muse-proofs-g6", "m3-05"))), ID);
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m3-05-skill-invoke.json");
const PROJECT = join(BASE, "project");
const OUTSIDE = join(BASE, "outside");
const HOST_CODE = `HOST-${randomBytes(3).toString("hex").toUpperCase()}`;
const CTX_CODE = `CTX-${randomBytes(3).toString("hex").toUpperCase()}`;
const redact = redactorFor(BASE);

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skill = (name, description, body, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
put(join(PROJECT, "README.md"), "M3-05 macOS proof project: nothing to change here.\n");
put(join(PROJECT, ".agents/skills/g6-host/SKILL.md"), skill("g6-host", "M3-05 proof skill run by the host. Use only when invoked explicitly.",
  `When this skill is invoked, reply with exactly ${HOST_CODE} and nothing else. Do not call any tool.`));
put(join(PROJECT, ".muse/skills/g6-ctx/SKILL.md"), skill("g6-ctx", "M3-05 proof skill with a resource.",
  "Reply with exactly the code written in the resource context.txt below, and nothing else. Do not call any tool.", "resources: [context.txt]\n"));
put(join(PROJECT, ".muse/skills/g6-ctx/context.txt"), `CODE: ${CTX_CODE}\n`);
put(join(PROJECT, ".muse/skills/g6-gone/SKILL.md"), skill("g6-gone", "M3-05 proof skill whose resource disappears.", "Use gone.txt.", "resources: [gone.txt]\n"));
put(join(PROJECT, ".muse/skills/g6-gone/gone.txt"), "about to disappear\n");
put(join(OUTSIDE, "secret.txt"), "OUTSIDE-THE-SKILL\n");
put(join(PROJECT, ".muse/skills/g6-link-res/SKILL.md"), skill("g6-link-res", "M3-05 proof skill whose resource leaves its folder.", "Use linked.txt.", "resources: [linked.txt]\n"));
symlinkSync(join(OUTSIDE, "secret.txt"), join(PROJECT, ".muse/skills/g6-link-res/linked.txt"));

/** Type a slash command in the conversation composer and press Enter (once more if a completion took the first). */
async function typeCommand(app, sid, command) {
  await app.ev(page(`
    if (activeSid() !== ${J(sid)}) { sessionRow(${J(sid)})?.querySelector('button.session-select')?.click(); await pause(800); }
    const box = document.querySelector('textarea[aria-label="Message Muse"]');
    setValue(box, ''); box.focus(); return true;
  `));
  await app.send("Input.insertText", { text: command });
  await waitFor(() => app.ev(`document.querySelector('textarea[aria-label="Message Muse"]')?.value === ${J(command)}`), 10_000, 100);
  const enter = async () => {
    await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
    await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  };
  await enter();
  await sleep(600);
  const left = await app.ev("document.querySelector('textarea[aria-label=\"Message Muse\"]')?.value ?? ''");
  if (left.trim().length > 0) { await enter(); await sleep(600); }
  return { secondEnter: left.trim().length > 0 };
}
const sends = async (app, since) => (await ipcCalls(app, "send_input")).slice(since).map((c) => ({
  blockedByHarness: c.blockedByHarness === true, ok: c.ok ?? null, sessionId: c.args?.sessionId ?? null,
  parts: (c.args?.parts ?? c.args?.inputParts ?? []).map((p) => ({ type: p.type, selector: p.selector ?? undefined, text: p.text !== undefined ? String(p.text).slice(0, 1500) : undefined })),
  text: c.args?.text !== undefined ? String(c.args.text).slice(0, 1500) : undefined,
}));
const sendCount = async (app) => (await ipcCalls(app, "send_input")).length;
const logOf = (app, sid) => app.ev(page(`return logOf(${J(sid)}).map((e) => ({ role: e.role, text: String(e.text || '').slice(0, 1500), clientMessageId: e.clientMessageId ?? null }));`));

const record = {
  schema: "muse-desktop.macos-m3-05-skill-invoke.v1",
  ticket: "M3-05",
  date: new Date().toISOString().slice(0, 10),
  commit: COMMIT,
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: "scripts/macos/m3-05-skill-invoke.mjs on scripts/macos/test-instance.mjs",
  criteria: "docs/plans/2026-09-15-agent-implementation-plan.md §M3-05 (a real invocation with a resource, a skill deleted between suggestion and sending, a refused permission; no double insertion on retry) and docs/ROADMAP.md §M3-05 (skill/list catalogue per session, /selector -> MSP skill part, skills_read_resources re-reading resources just before sending, <skill-resource> context, a resource error creating a system entry with no partial send)",
  isolation: null,
  method: [
    "One isolated instance of the debug build (ADR 0003 amendment) on the pinned engine; the proof project is both the default folder (Scan workspace) and the conversation's project.",
    "The conversation is started with its first message refused by the harness (no turn), that unsent setup message discarded; every skill is then typed in the composer (CDP insertText) and sent with a real Enter.",
    "send_input calls are read from the IPC trace (parts or text as sent). A send refused by the harness is the 'failed send' of the retry scenario: the outbox keeps it, the Unsent row's Retry resends it.",
    "Each code (HOST-…, CTX-…) exists only in one file of the project, so a reply quoting it shows where the model's context came from.",
    "Interpretation of 'a refused permission': the resource reader refuses a resource that resolves outside its skill directory (a symlink); the send never leaves.",
  ],
  phases: {},
  verdicts: {},
  limits: [],
};

const userBefore = userEngineStamp();
let inst = null;
let failure = null;
try {
  inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
  const { app } = inst;
  record.engine = inst.engineVersion;
  record.isolation = inst.isolation;
  await installTrace(app);
  await pickDefaultFolder(app, PROJECT);
  await openExtensions(app);
  const scanned = await app.ev(page(`
    const panel = document.querySelector('[aria-label="Skills"]');
    const b = [...panel.querySelectorAll('button')].find((n) => /Scan workspace/.test(n.textContent));
    b.click();
    for (let i = 0; i < 100 && /Scanning/.test(b.textContent); i++) await pause(100);
    await pause(300);
    return { summary: text(panel.querySelector('.skill-scan-result small')), errors: [...panel.querySelectorAll('.skill-scan-errors li')].map((n) => text(n)) };
  `));
  const conv = await startConversationNoTurn(app, PROJECT);
  const sid = conv.sid;
  const discarded = await app.ev(page(`
    const row = q('.pending-send')[0];
    const b = row && [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Discard');
    if (b) b.click();
    await pause(500);
    return { discarded: Boolean(b), left: q('.pending-send').length };
  `));
  await openExtensions(app);
  const hostList = await app.ev(page(`
    const panel = document.querySelector('[aria-label="Skills"]');
    [...panel.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Refresh')?.click();
    await pause(1500);
    return [...panel.querySelectorAll('li.integration-row strong')].map((n) => text(n)).filter((t) => /^\\/g6-/.test(t));
  `));
  record.phases.setup = { scan: scanned, conversation: { approvalMode: conv.approvalMode, firstMessageRefused: conv.firstMessageSends, setupMessage: discarded }, skillsPanel: hostList };
  record.verdicts.catalogues = /^4 discovered/.test(scanned.summary ?? "") && hostList.includes("/g6-host") && !hostList.some((t) => /^\/g6-ctx$/.test(t));
  await app.ev(page("nav('New conversation'); await pause(200); return true;"));
  await app.ev(page(`sessionRow(${J(sid)})?.querySelector('button.session-select')?.click(); await pause(800); return activeSid();`));

  // ---- gone: the resource deleted after the scan ------------------------------------------------
  rmSync(join(PROJECT, ".muse/skills/g6-gone/gone.txt"));
  let mark = await sendCount(app);
  let logBefore = (await logOf(app, sid)).length;
  const goneTyped = await typeCommand(app, sid, "/g6-gone");
  await sleep(1_500);
  const goneLog = (await logOf(app, sid)).slice(logBefore);
  const goneUi = await app.ev(page("return { banners: banners(), pending: q('.pending-send').map((n) => text(n)), progress: text(document.querySelector('.skill-invocation-progress')) };"));
  record.phases.gone = { typed: goneTyped, sends: await sends(app, mark), logAdded: goneLog, ui: goneUi };
  record.verdicts.deletedBetweenScanAndSend = (await sends(app, mark)).length === 0
    && goneLog.some((e) => e.role === "system" && /skill \/g6-gone resources unavailable: .*gone\.txt/.test(e.text)) && !goneLog.some((e) => e.role === "user");

  // ---- refused: a resource resolving outside its skill directory --------------------------------
  mark = await sendCount(app);
  logBefore = (await logOf(app, sid)).length;
  const refusedTyped = await typeCommand(app, sid, "/g6-link-res");
  await sleep(1_500);
  const refusedLog = (await logOf(app, sid)).slice(logBefore);
  record.phases.refused = { typed: refusedTyped, sends: await sends(app, mark), logAdded: refusedLog,
    ui: await app.ev(page("return { banners: banners(), pending: q('.pending-send').map((n) => text(n)) };")) };
  record.verdicts.refusedResourceNoSend = (await sends(app, mark)).length === 0
    && refusedLog.some((e) => e.role === "system" && /resources unavailable: .*linked\.txt: resource is outside the skill directory/.test(e.text))
    && !refusedLog.some((e) => e.role === "user") && !refusedLog.some((e) => e.text.includes("OUTSIDE-THE-SKILL"));

  // ---- host: a host-catalogue skill, expanded by the host (1 turn) --------------------------------
  mark = await sendCount(app);
  logBefore = (await logOf(app, sid)).length;
  const hostTyped = await typeCommand(app, sid, "/g6-host");
  record.liveTurns += 1;
  const hostTurn = await waitTurn(app, sid);
  const hostSends = await sends(app, mark);
  const hostLog = (await logOf(app, sid)).slice(logBefore);
  const hostReply = hostLog.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
  record.phases.host = { typed: hostTyped, sends: hostSends, logAdded: hostLog, approvals: hostTurn.approvals, finished: hostTurn.finished, ms: hostTurn.ms };
  record.verdicts.hostSkillExecutedByHost = hostTurn.finished && hostSends.length === 1 && hostSends[0].ok === true
    && J(hostSends[0].parts.map((p) => `${p.type}:${p.selector ?? ""}`)) === J(["skill:g6-host"])
    && !J(hostSends[0]).includes(HOST_CODE) && hostReply.includes(HOST_CODE)
    && hostLog.filter((e) => e.role === "user").length === 1;

  // ---- retry: a failed send of a client skill with a resource, retried once (1 turn) ----------------
  mark = await sendCount(app);
  logBefore = (await logOf(app, sid)).length;
  await app.ev("(window.__baselineIpc.block = ['send_input'], true)");
  const retryTyped = await typeCommand(app, sid, "/g6-ctx");
  await sleep(1_500);
  await app.ev("(window.__baselineIpc.block = [], true)");
  const failedState = await app.ev(page(`return { pending: q('.pending-send').map((n) => text(n)), banners: banners(),
    users: logOf(${J(sid)}).filter((e) => e.role === 'user').length };`));
  // The resource changes before the retry: the retry must resend the text expanded at the first send, not re-expand it.
  put(join(PROJECT, ".muse/skills/g6-ctx/context.txt"), "CODE: CHANGED-AFTER-FIRST-SEND\n");
  const retryClick = await app.ev(page(`
    const row = q('.pending-send').find((n) => /g6-ctx/.test(n.textContent));
    const b = row && [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Retry');
    if (b) b.click();
    return Boolean(b);
  `));
  record.liveTurns += 1;
  const retryTurn = await waitTurn(app, sid);
  const retrySends = await sends(app, mark);
  const retryLog = (await logOf(app, sid)).slice(logBefore);
  const retryReply = retryLog.filter((e) => e.role === "assistant").map((e) => e.text).join("\n");
  // What the host receives: the input parts when present (send_input's input_parts win over text).
  const sentText = (s) => s.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") || s.text || "";
  const users = retryLog.filter((e) => e.role === "user");
  record.phases.retry = { typed: retryTyped, failedState, retryClicked: retryClick, sends: retrySends, logAdded: retryLog, approvals: retryTurn.approvals, finished: retryTurn.finished,
    pendingAfter: await app.ev(page("return q('.pending-send').map((n) => text(n));")) };
  record.verdicts.resourceInContextAndReply = retryTurn.finished && retrySends.length === 2
    && sentText(retrySends[1]).includes(`<skill-resource path=".muse/skills/g6-ctx/context.txt">`) && sentText(retrySends[1]).includes(CTX_CODE)
    && retryReply.includes(CTX_CODE);
  record.verdicts.noDoubleInsertionOnRetry = retrySends[0]?.blockedByHarness === true && retrySends[1]?.ok === true
    && sentText(retrySends[0]) === sentText(retrySends[1]) && retrySends[0]?.text === retrySends[1]?.text && (sentText(retrySends[1]).match(/<skill-resource /g) ?? []).length === 1
    && !sentText(retrySends[1]).includes("CHANGED-AFTER-FIRST-SEND")
    && failedState.pending.length === 1 && users.length === 1 && record.phases.retry.pendingAfter.length === 0;
  record.consoleErrors = app.errors.slice(0, 10);
} catch (error) {
  failure = String(error?.stack ?? error).slice(0, 1200);
} finally {
  if (inst) record.stop = await inst.stop();
}
await sleep(500);
record.leftoverProcesses = processesMentioning(BASE);
record.userEngineConfig = compareStamps(userBefore, userEngineStamp());
if (failure) record.failure = failure;
record.verdicts.cleanExit = Boolean(record.stop) && record.stop.leftAfterQuit.length === 0 && record.stop.defaultStoresUnchangedAtEnd && record.leftoverProcesses.length === 0;
record.verdicts.userEngineConfigUntouched = record.userEngineConfig.unchanged;
record.passed = !failure && Object.values(record.verdicts).every((x) => x === true);
record.observations = ["The harness presses Enter a second time when the composer still holds the command after the first (typed.secondEnter): a completion or a refused send leaves the text in place, so a refused skill can log its system line twice; no send_input either way."];
record.limits.push(
  "The host catalogue of 1.4.2 also reads the user's own skill roots (a ~/.claude/skills skill appears with source 'user'): read-only, nothing written there.",
  "The failed send is produced by the harness refusing send_input in the page, not by a host failure; the outbox and Retry paths are the app's.",
  "The engine's session store is shared with the user (ADR 0003): the proof conversation stays there.",
);
const out = redact(record);
writeRecord(OUT, out);
console.log(J({ passed: out.passed, verdicts: out.verdicts, failure: out.failure ?? null, leftover: out.leftoverProcesses }, null, 2));
process.exit(out.passed ? 0 : 1);
