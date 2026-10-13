#!/usr/bin/env node
/**
 * M2-07, host side: what native Muse 1.4.2 tells a client about the
 * sub-agents its model spawns. The app draws a controllable lane only for an
 * `item/started` whose item kind is `subagent` or `workflow`
 * (src-tauri/src/main.rs is_subagent_item_kind; `reminderchild` is drawn as
 * host-internal). On 1.4.2 the in-app run showed the model's `subagent_spawn`
 * tool accepted with a subagent_id while no such lane appeared: this probe
 * reads the raw MSP stream, with the app's own argv and capabilities, to say
 * whether the host emits anything a lane could be drawn from.
 *
 *   node scripts/macos/m2-07-msp-subagent-notifications.mjs [--binary <muse-bin>]
 *     [--out docs/evidence/2026-10-13-macos-closure/m2-07-msp-subagent-notifications-1.4.2.json]
 *
 * One live turn. Pinned engine, MUSE_NO_AUTO_UPDATE=1, a temp workspace.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argValue, redactor } from "../cdp-harness.mjs";
import { connect, createHost, startSession, uuidv7 } from "../msp-probe.mjs";
import { DEFAULT_ENGINE, engineVersion } from "./test-instance.mjs";

const BINARY = resolve(argValue("--binary", DEFAULT_ENGINE));
const OUT = argValue("--out", "docs/evidence/2026-10-13-macos-closure/m2-07-msp-subagent-notifications-1.4.2.json");
const WS = join(tmpdir(), "muse-proofs-g5", "m2-07-msp", Date.now().toString(36));
mkdirSync(WS, { recursive: true });
const ROOT = realpathSync(WS);
const redact = redactor([[ROOT, "<workspace>"], [WS, "<workspace>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "Start two sub-agents at the same time, in parallel. Each sub-agent must count from 1 to 15, one number per line, and then answer DONE. Do not wait for them: once both are started, reply with just the word SPAWNED.";

const record = {
  schema: "muse-desktop.m2-07-msp-subagent-notifications.v1",
  ticket: "M2-07",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}`,
  engine: engineVersion(BINARY),
  liveTurns: 1,
  harness: "scripts/macos/m2-07-msp-subagent-notifications.mjs on scripts/msp-probe.mjs (createHost, the app's argv: serve --sandbox-network restricted --trust-workspace)",
  method: "initialize with the app's capabilities (userShell, sessionMcp), session/start in a temp folder, session/setApprovalMode allowAll, one turn asking for two parallel sub-agents; every notification kept for 90 s after the turn started.",
  prompt: PROMPT,
};
const host = createHost(BINARY, ROOT);
try {
  const init = await connect(host, { requestedCapabilities: ["userShell", "sessionMcp"] });
  record.server = { name: init?.serverInfo?.name ?? null, version: init?.serverInfo?.version ?? null, capabilityKeys: Object.keys(init?.capabilities ?? {}) };
  const { sessionId } = await startSession(host, ROOT);
  record.approvalMode = await host.request("session/setApprovalMode", { commandId: uuidv7(), sessionId, mode: "allowAll" }).then(() => "allowAll", (e) => `refused: ${e.message}`);
  const mark = host.mark();
  record.turnStart = await host.request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text: PROMPT }] }).then(() => "accepted", (e) => `rejected: ${e.message}`);
  const end = Date.now() + 90_000;
  while (Date.now() < end) await sleep(1_000);
  const events = host.since(mark);
  const kindOf = (e) => e.params?.item?.kind ?? e.params?.itemKind ?? e.params?.kind ?? null;
  record.methods = Object.entries(events.reduce((m, e) => ({ ...m, [e.method]: (m[e.method] ?? 0) + 1 }), {})).sort();
  record.itemKinds = Object.entries(events.filter((e) => e.method === "item/started").reduce((m, e) => ({ ...m, [kindOf(e)]: (m[kindOf(e)] ?? 0) + 1 }), {})).sort();
  record.subagentMethods = events.filter((e) => /subagent|agent\//i.test(e.method)).map((e) => ({ method: e.method, params: JSON.stringify(e.params ?? {}).slice(0, 400) })).slice(0, 20);
  record.spawnToolCalls = events.filter((e) => e.method === "item/started" && /subagent_spawn|spawn/i.test(JSON.stringify(e.params?.item ?? {}))).map((e) => JSON.stringify(e.params.item).slice(0, 500)).slice(0, 4);
  record.childItems = events.filter((e) => e.method === "item/started" && /reminderchild|subagent|workflow/i.test(String(kindOf(e)))).map((e) => ({ kind: kindOf(e), keys: Object.keys(e.params?.item ?? {}), childSession: e.params?.item?.childSessionId ?? null, objective: e.params?.item?.objective ?? null })).slice(0, 12);
  record.otherSessionsNotified = [...new Set(events.map((e) => e.params?.sessionId).filter((s) => s && s !== sessionId))].length;
  record.turnCompleted = events.some((e) => e.method === "turn/completed");
  record.reading = record.childItems.some((c) => /^(subagent|workflow)$/i.test(String(c.kind)))
    ? "the host emits sub-agent items the app can draw as controllable lanes"
    : "the host emits no item of kind subagent or workflow for the spawned sub-agents (only the kinds listed): the app has nothing to draw a controllable lane from";
} catch (error) {
  record.failure = String(error?.stack ?? error).slice(0, 600);
} finally {
  await host.stop();
}
const out = redact(record);
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ methods: out.methods, itemKinds: out.itemKinds, subagentMethods: out.subagentMethods?.length, childItems: out.childItems, reading: out.reading, failure: out.failure }, null, 2));
