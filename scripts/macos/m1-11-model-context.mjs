#!/usr/bin/env node
/**
 * M1-11 native macOS proof: pick an available model and follow the context.
 *
 * The plan's acceptance (an unavailable model, a change between sessions, a
 * compaction; context and choice reflect the server) and the Windows pieces
 * (the picker's label follows each conversation; a switched model persists
 * across conversation switches; the host's context usage renders), in one
 * isolated instance on the pinned engine. Three live turns, plus whatever the
 * engine spends on one compaction.
 *
 * Two conversations A and B in the same project (one host). A keeps its model;
 * B switches to another catalog model through the picker. The host's own view
 * is read back with list_models per session (isActive). A 28,000-character
 * turn on B makes the host report context usage; Compact now is clicked once.
 * An unavailable model id is sent through the app's set_model command (the
 * picker only lists the live catalog, so no click can choose one).
 *
 *   node scripts/macos/m1-11-model-context.mjs --exe ~/muse-proofs/app/08b291d/muse-desktop
 *     [--port 9445] [--base $TMPDIR/muse-proofs-g4/m1-11] [--out docs/evidence/2026-10-13-macos-closure/m1-11-model-context-macos.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue, sleep, waitFor } from "../cdp-harness.mjs";
import { newProjectConversation, sendFirstMessage, transcript } from "./smoke-real-turn.mjs";
import { launch } from "./test-instance.mjs";
import { platform, redactPaths } from "./m1-05-terminal-lib.mjs";

const EXE = resolve(argValue("--exe", "src-tauri/target/debug/muse-desktop"));
const PORT = Number(argValue("--port", "9445"));
const ID = Date.now().toString(36).toUpperCase();
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g4", `m1-11-${ID.toLowerCase()}`)));
const OUT = argValue("--out", null);
const PROJECT = join(BASE, "project");

const record = {
  schema: "muse-desktop.m1-11-model-context-macos.v1",
  ticket: "M1-11",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: platform(),
  engine: null,
  liveTurns: 0,
  harness: `scripts/macos/m1-11-model-context.mjs on scripts/macos/test-instance.mjs, bridge port ${PORT}`,
  isolation: null,
  method: "One isolated instance on the pinned engine, one project folder under the proof's temp folder, two conversations in it (one host). Messages typed in the real composer and sent with a real Enter; the model picker and Compact now are clicked in the page. The host's own state is read back through the app's list_models command per conversation (isActive), the label from the picker's trigger, the context reading from the ContextMeter.",
  checks: {},
  verdicts: {},
  limits: [],
};
const check = (name, data) => {
  record.checks[name] = data;
  console.error(`- ${name}: ${JSON.stringify(data).slice(0, 360)}`);
};

const running = (app) => app.ev("document.querySelector('.task-metadata .dot')?.getAttribute('data-running') === 'true'");
const picker = (app) => app.ev(`(() => {
  const control = document.querySelector('details.model-control');
  if (!control) return { present: false };
  return {
    present: true,
    label: control.querySelector('summary strong')?.textContent ?? '',
    options: [...control.querySelectorAll('button.model-option')].map((b) => ({ label: b.querySelector('strong')?.textContent ?? '', detail: b.querySelector('small')?.textContent ?? '', selected: b.getAttribute('aria-selected') === 'true' })),
  };
})()`);
const meter = (app) => app.ev(`(() => {
  const m = document.querySelector('.context-meter');
  if (!m) return { present: false };
  return { present: true, trigger: m.querySelector('summary')?.getAttribute('aria-label') ?? '', title: m.querySelector('summary')?.getAttribute('title') ?? '', pressure: m.getAttribute('data-pressure'), popover: (m.querySelector('.context-meter-popover')?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 400) };
})()`);
const hostModels = (app, sid) => app.ev(`window.__TAURI_INTERNALS__.invoke('list_models', { sessionId: ${JSON.stringify(sid)} }).then((rows) => rows.map((r) => ({ modelId: r.modelId ?? r.model_id, label: r.displayLabel ?? r.display_label, isActive: r.isActive ?? r.is_active, isDefault: r.isDefault ?? r.is_default })), (e) => ({ error: String(e).slice(0, 200) }))`);
const activeOf = (rows) => (Array.isArray(rows) ? rows.find((r) => r.isActive)?.modelId ?? null : null);
const select = async (app, sid) => {
  await app.ev(`(document.querySelector('li.session-item[data-session-id="${sid}"] button.session-select')?.click(), true)`);
  await waitFor(() => app.ev(`document.querySelector('li.session-item.active')?.getAttribute('data-session-id') === ${JSON.stringify(sid)}`), 10_000, 200);
  await sleep(2_000);
};

/** Types in the composer, real Enter, waits for an assistant entry holding `expect` and the turn's end. */
async function turn(app, sid, text, expect) {
  const before = (await transcript(app, sid)).length;
  await app.ev("(document.querySelector('textarea[aria-label=\"Message Muse\"]').focus(), true)");
  await app.send("Input.insertText", { text });
  await waitFor(() => app.ev(`document.querySelector('textarea[aria-label="Message Muse"]').value.length === ${text.length}`), 10_000, 100);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  record.liveTurns += 1;
  const reply = await waitFor(async () => {
    const hit = (await transcript(app, sid)).slice(before).find((e) => e.role === "assistant" && String(e.text).includes(expect));
    return hit && !(await running(app)) ? String(hit.text).slice(0, 200) : null;
  }, 240_000, 1_000);
  return reply;
}

async function firstTurn(app, label) {
  const ready = await newProjectConversation(app, PROJECT);
  if (ready !== "ready") throw new Error(`welcome flow ${label}: ${ready}`);
  const token = `OK-${label}-${ID}`;
  const sid = await sendFirstMessage(app, `Reply with exactly ${token} and nothing else.`);
  if (!sid) throw new Error(`start_session ${label}`);
  record.liveTurns += 1;
  const reply = await waitFor(async () => {
    const hit = (await transcript(app, sid)).find((e) => e.role === "assistant" && String(e.text).includes(token));
    return hit && !(await running(app)) ? true : null;
  }, 240_000, 1_000);
  await sleep(1_500);
  return { sid, replied: Boolean(reply) };
}

mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, "README.md"), "M1-11 proof project\n");
const inst = await launch({ exe: EXE, port: PORT, data: join(BASE, "data") });
record.engine = inst.engineVersion;
record.isolation = inst.isolation;
const { app } = inst;
try {
  // ---- A and B, one host -------------------------------------------------------
  const a = await firstTurn(app, "A");
  const pickerAFresh = await picker(app);
  const b = await firstTurn(app, "B");
  const pickerBFresh = await picker(app);
  // A fresh conversation's picker, right after its first turn (no switch yet).
  check("fresh-picker", { a: pickerAFresh, b: pickerBFresh });
  // Then each one opened from the sidebar, as a user switching conversations.
  await select(app, a.sid);
  const pickerA1 = await picker(app);
  const hostA1 = await hostModels(app, a.sid);
  await select(app, b.sid);
  const pickerB1 = await picker(app);
  const hostB1 = await hostModels(app, b.sid);
  const workspaces = await app.ev(`(() => { const s = JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]'); return s.filter((x) => [${JSON.stringify(a.sid)}, ${JSON.stringify(b.sid)}].includes(x.session_id)).map((x) => x.workspace); })()`);
  check("conversations", { a: a.replied, b: b.replied, sameProject: workspaces.length === 2 && workspaces[0] === workspaces[1], pickerA1, hostActiveA1: activeOf(hostA1), pickerB1, hostActiveB1: activeOf(hostB1), catalog: Array.isArray(hostA1) ? hostA1.map((r) => r.modelId) : hostA1 });
  if (!pickerB1.present || pickerB1.options.length < 2) throw new Error("model picker missing or fewer than two models");

  // ---- B switches model through the picker ---------------------------------------
  const target = pickerB1.options.find((o) => !o.selected && o.label !== pickerA1.label) ?? pickerB1.options.find((o) => !o.selected);
  const callsBefore = await app.ev("window.__baselineIpc.calls.length");
  await app.ev(`(() => {
    const control = document.querySelector('details.model-control');
    control.setAttribute('open', '');
    const option = [...control.querySelectorAll('button.model-option')].find((b) => (b.querySelector('strong')?.textContent ?? '') === ${JSON.stringify(target.label)});
    option?.click();
    return Boolean(option);
  })()`);
  const setCall = await waitFor(async () => (await app.ev(`window.__baselineIpc.calls.slice(${callsBefore}).filter((c) => c.cmd === 'set_model' && c.result !== undefined)`)).at(-1) ?? null, 10_000, 200);
  await sleep(1_500);
  const pickerB2 = await picker(app);
  const hostB2 = await hostModels(app, b.sid);
  const targetId = Array.isArray(hostB2) ? hostB2.find((r) => r.label === target.label)?.modelId ?? null : null;
  check("b-switch", { target: target.label, targetId, setModel: setCall ? { ok: setCall.ok, args: setCall.args, result: setCall.result } : null, pickerB2: pickerB2.label, hostActiveB2: activeOf(hostB2) });

  // ---- back to A, then B: each keeps its own ------------------------------------
  await select(app, a.sid);
  const pickerA2 = await picker(app);
  const hostA2 = await hostModels(app, a.sid);
  await select(app, b.sid);
  const pickerB3 = await picker(app);
  const hostB3 = await hostModels(app, b.sid);
  check("round-trip", { pickerA2: pickerA2.label, hostActiveA2: activeOf(hostA2), pickerB3: pickerB3.label, hostActiveB3: activeOf(hostB3) });
  record.verdicts.labelFollowsConversation = Boolean(pickerA2.label === pickerA1.label && pickerB2.label === target.label && pickerA1.label !== target.label);
  record.verdicts.hostStateIsPerConversation = Boolean(activeOf(hostA2) === activeOf(hostA1) && activeOf(hostB2) === targetId && targetId && activeOf(hostA2) !== targetId);
  record.verdicts.switchPersistsAcrossSwitches = Boolean(pickerB3.label === target.label && activeOf(hostB3) === targetId);

  // ---- a large turn on B, on the switched model: the host reports context ------
  const meterBefore = await meter(app);
  const filler = "The lighthouse keeper wrote careful notes about the weather every single hour of every single day. ".repeat(285);
  const bigReply = await turn(app, b.sid, `${filler}\n\nReply with exactly CTX-${ID} and nothing else.`, `CTX-${ID}`);
  await waitFor(async () => (await meter(app)).present, 30_000, 1_000);
  await app.ev("(document.querySelector('.context-meter')?.setAttribute('open', ''), true)");
  await sleep(500);
  const meterAfter = await meter(app);
  const hostB4 = await hostModels(app, b.sid);
  check("context", { meterBefore, replied: Boolean(bigReply), meterAfter, hostActiveB4: activeOf(hostB4) });
  record.verdicts.turnRunsOnSwitchedModel = Boolean(bigReply && activeOf(hostB4) === targetId);
  record.verdicts.contextUsageRendered = Boolean(meterAfter.present && /Context \d+% used/.test(meterAfter.trigger) && /Context window/.test(meterAfter.popover));

  // ---- one compaction, from the meter's button -----------------------------------
  const compactBefore = await app.ev("window.__baselineIpc.calls.length");
  const clicked = await app.ev("(() => { const b = document.querySelector('.context-meter-compact'); if (!b || b.disabled) return false; b.click(); return true; })()");
  const states = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await app.ev("(() => { const m = document.querySelector('.context-meter'); if (!m) return null; return { summary: m.querySelector('summary')?.textContent?.trim() ?? '', note: [...m.querySelectorAll('.context-meter-note')].at(-1)?.textContent ?? '', button: m.querySelector('.context-meter-compact')?.textContent ?? '' }; })()");
    const key = JSON.stringify(s);
    if (states.at(-1)?.key !== key) states.push({ key, atMs: 120_000 - (deadline - Date.now()), ...s });
    if (s && !/Compacting/.test(s.summary + s.button) && states.length > 1) break;
    await sleep(500);
  }
  const compactCalls = await app.ev(`window.__baselineIpc.calls.slice(${compactBefore}).filter((c) => /compact/i.test(c.cmd)).map((c) => ({ cmd: c.cmd, ok: c.ok, result: String(c.result ?? '').slice(0, 300) }))`);
  await sleep(2_000);
  const meterAfterCompact = await meter(app);
  check("compaction", { clicked, ipc: compactCalls, states: states.map(({ key, ...rest }) => rest), meterAfterCompact });
  record.verdicts.compactionAdmissionShown = Boolean(clicked && compactCalls.length > 0 && states.some((s) => /compact/i.test(s.note) && !/^Compacting asks/.test(s.note)));

  // ---- an unavailable model -------------------------------------------------------
  const bogus = `no-such-model-${ID.toLowerCase()}`;
  const refused = await app.ev(`window.__TAURI_INTERNALS__.invoke('set_model', { sessionId: ${JSON.stringify(b.sid)}, modelId: ${JSON.stringify(bogus)} }).then(() => ({ accepted: true }), (e) => ({ error: String(e).slice(0, 300) }))`);
  const hostB5 = await hostModels(app, b.sid);
  check("unavailable-model", { modelId: bogus, outcome: refused, hostActiveAfter: activeOf(hostB5), pickerAfter: (await picker(app)).label });
  record.verdicts.unavailableModelRefused = Boolean(refused.error && activeOf(hostB5) === targetId);
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 800);
} finally {
  record.consoleErrors = app.errors.slice(0, 20);
  record.stop = await inst.stop();
}
record.verdicts.noProcessLeft = record.stop.leftAfterQuit.length === 0;
record.verdicts.isolationKept = record.stop.defaultStoresUnchangedAtEnd === true && record.stop.testStoreDeleted === true;
record.verdicts.all = !record.failure && Object.values(record.verdicts).every((v) => v === true);
const out = redactPaths([[PROJECT, "<project>"], [BASE, "<proof>"]])(record);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
}
console.log(JSON.stringify(out.verdicts, null, 2));
if (record.failure) console.error(record.failure);
process.exit(record.verdicts.all ? 0 : 1);
