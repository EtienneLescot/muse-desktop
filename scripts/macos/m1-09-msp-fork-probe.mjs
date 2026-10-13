#!/usr/bin/env node
/**
 * M1-09 on macOS, engine side, with no model call: `muse serve --provider echo`
 * on the pinned engine (never ~/.local/bin/muse), MUSE_NO_AUTO_UPDATE=1.
 *
 * Answers what the 05/10 Windows probe (scripts/msp-echo-probe.mjs) could not:
 * does `session/fork` create a branch on the macOS 1.4.2 engine, at which
 * anchors, and is the branch a real copy of the source history?
 *
 *   - three completed turns, then a fork at each of them, at an unknown turn
 *     id and with no cut point;
 *   - each created branch: new id, `forkedFrom` naming the source, same
 *     workspace, history equal to the source history up to the cut;
 *   - independence: a turn in the branch never reaches the source, and a turn
 *     in the source never reaches the branch;
 *   - durability: a second host process reads the branch's provenance back.
 *
 *   node scripts/macos/m1-09-msp-fork-probe.mjs [--engine <muse-bin>] [--base <dir>] [--out <file.json>]
 *
 * The report is path-free: the workspace is named W.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argValue } from "../cdp-harness.mjs";
import { bounded, connect, createHost, startSession, uuidv7 } from "../msp-probe.mjs";
import { DEFAULT_ENGINE, engineVersion } from "./test-instance.mjs";

const ENGINE = resolve(argValue("--engine", DEFAULT_ENGINE));
const BASE = resolve(argValue("--base", join(tmpdir(), "muse-proofs-g8")));
const OUT = argValue("--out", null);
const ID = Date.now().toString(36);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ARGS = ["--provider", "echo", "--disable-sandbox"];

async function turn(host, sessionId, text) {
  const mark = host.mark();
  const result = await host.request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text }] });
  for (let i = 0; i < 200; i++) {
    const done = host.since(mark).find((e) => e.method === "turn/completed" && e.params?.turnId === result.turnId);
    if (done) return { turnId: result.turnId, terminal: done.params?.terminal ?? null };
    await sleep(100);
  }
  return { turnId: result.turnId, terminal: null };
}

/** The user/agent messages of a session, in order, as "u:<text>" / "a:<text>". */
async function history(host, sessionId) {
  const read = await host.request("session/read", { sessionId, excludeItems: false });
  const items = read.history?.items ?? [];
  return {
    session: read.session,
    messages: items.filter((i) => i.kind === "userMessage" || i.kind === "agentMessage")
      .map((i) => `${i.kind === "userMessage" ? "u" : "a"}:${bounded(String(i.text ?? ""), 60)}`),
    kinds: [...new Set(items.map((i) => i.kind))].sort(),
  };
}

async function fork(host, sessionId, lastTurnId) {
  const started = Date.now();
  return host.request("session/fork", { sessionId, commandId: uuidv7(), excludeItems: true, ...(lastTurnId ? { cutPoint: { lastTurnId } } : {}) })
    .then((r) => ({
      created: true,
      ms: Date.now() - started,
      sessionId: r.session.sessionId,
      newId: r.session.sessionId !== sessionId,
      status: r.session.status,
      turnCount: r.session.turnCount,
      forkedFrom: r.session.forkedFrom ? {
        sourceIsTheSource: r.session.forkedFrom.sessionId === sessionId,
        cutExplicit: r.session.forkedFrom.cutExplicit,
        cutCursor: String(r.session.forkedFrom.cutCursor).replace(sessionId, "<source>"),
      } : null,
    }))
    .catch((error) => ({ created: false, code: error.code, kind: error.kind, detail: bounded(error.message.replace(sessionId, "<source>"), 160) }));
}

const workspace = join(BASE, `msp-${ID}`, "w");
mkdirSync(workspace, { recursive: true });
const root = realpathSync.native(workspace);
const report = {
  schema: "muse-desktop.m1-09-msp-fork-probe.v1",
  ticket: "M1-09",
  date: new Date().toISOString().slice(0, 10),
  commit: "08b291d",
  platform: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()} (${execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim()}), ${process.arch}`,
  engine: engineVersion(ENGINE),
  argv: ["serve", "--sandbox-network", "restricted", "--trust-workspace", ...ARGS],
  liveTurns: 0,
};
const host = createHost(ENGINE, root, ARGS);
let branchIds = [];
try {
  const init = await connect(host);
  report.serverVersion = init?.serverInfo?.version ?? null;
  report.platformOs = init?.platformOs ?? null;
  const { sessionId } = await startSession(host, root);
  const turns = [];
  for (const word of ["ALPHA", "BETA", "GAMMA"]) turns.push(await turn(host, sessionId, `turn ${turns.length + 1} ${word}`));
  report.sourceTurns = turns.map((t) => t.terminal);
  const source = await history(host, sessionId);
  report.source = { turnCount: source.session.turnCount, messages: source.messages, itemKinds: source.kinds };

  report.forks = {
    atTurn1: await fork(host, sessionId, turns[0].turnId),
    atTurn2: await fork(host, sessionId, turns[1].turnId),
    atTurn3Latest: await fork(host, sessionId, turns[2].turnId),
    atUnknownTurn: await fork(host, sessionId, uuidv7()),
    anchorless: await fork(host, sessionId),
  };
  branchIds = Object.values(report.forks).filter((f) => f.created).map((f) => f.sessionId);
  report.writeFailedSeen = Object.values(report.forks).some((f) => /WriteFailed/.test(f.detail ?? ""));

  // The created branches: same workspace, history = the source up to the cut.
  report.branches = {};
  for (const [name, f] of Object.entries(report.forks)) {
    if (!f.created) continue;
    const b = await history(host, f.sessionId);
    report.branches[name] = {
      sameWorkspace: b.session.workspaceRoot === source.session.workspaceRoot,
      turnCount: b.session.turnCount,
      messages: b.messages,
      historyEqualsSource: JSON.stringify(b.messages) === JSON.stringify(source.messages),
    };
  }

  // Independence, both ways, on the anchorless branch.
  const branchId = report.forks.anchorless.created ? report.forks.anchorless.sessionId : null;
  if (branchId) {
    const inBranch = await turn(host, branchId, "branch only DELTA");
    const inSource = await turn(host, sessionId, "source only EPSILON");
    const s = await history(host, sessionId);
    const b = await history(host, branchId);
    report.independence = {
      branchTurn: inBranch.terminal,
      sourceTurn: inSource.terminal,
      sourceTurnCount: s.session.turnCount,
      branchTurnCount: b.session.turnCount,
      sourceHasBranchTurn: s.messages.some((m) => m.includes("DELTA")),
      branchHasSourceTurn: b.messages.some((m) => m.includes("EPSILON")),
      sourceKeepsItsHistory: JSON.stringify(s.messages.slice(0, source.messages.length)) === JSON.stringify(source.messages),
      branchKeepsTheCopiedHistory: JSON.stringify(b.messages.slice(0, source.messages.length)) === JSON.stringify(source.messages),
    };
  }
} catch (error) {
  report.failure = bounded(String(error?.message ?? error), 240);
} finally {
  await host.stop();
}

// Durability: a second host process reads the branch back from the store.
if (report.forks?.anchorless?.created) {
  const reader = createHost(ENGINE, root, ARGS);
  try {
    await connect(reader);
    const read = await reader.request("session/read", { sessionId: report.forks.anchorless.sessionId, excludeItems: true });
    report.durableProvenance = {
      readByAnotherHost: true,
      status: read.session.status,
      forkedFromKept: read.session.forkedFrom?.cutExplicit === false && typeof read.session.forkedFrom?.sessionId === "string",
    };
  } catch (error) {
    report.durableProvenance = { readByAnotherHost: false, detail: bounded(String(error?.message ?? error), 160) };
  } finally {
    await reader.stop();
  }
}
for (const f of Object.values(report.forks ?? {})) delete f.sessionId;

/**
 * `--live-active` (two billed turns, default provider): fork while the source
 * turn runs, anchorless and at the last completed turn, then read what each
 * branch holds. The contract: "Omitted means all completed turns", and a cut
 * is inclusive of a completed turn: the running turn belongs to neither.
 */
if (process.argv.includes("--live-active")) {
  const live = createHost(ENGINE, root, []);
  report.activeSource = {};
  try {
    await connect(live);
    const { sessionId } = await startSession(live, root);
    await live.request("session/setApprovalMode", { sessionId, commandId: uuidv7(), mode: "promptUnmatched" }).catch(() => undefined);
    const first = await turn(live, sessionId, "Do not call any tool. Reply with exactly OK1 and nothing else.");
    report.liveTurns++;
    const mark = live.mark();
    const running = await live.request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text: "Do not call any tool. Write a numbered list of twelve short facts about rivers." }] });
    report.liveTurns++;
    // Fork as soon as the host reports the turn started, before it ends.
    for (let i = 0; i < 200 && !live.since(mark).some((e) => e.method === "turn/started"); i++) await sleep(25);
    const statusAtFork = (await live.request("session/read", { sessionId })).session.status;
    const anchorless = await fork(live, sessionId);
    const atLastCompleted = await fork(live, sessionId, first.turnId);
    const endedBeforeForks = live.since(mark).some((e) => e.method === "turn/completed" && e.params?.turnId === running.turnId);
    for (let i = 0; i < 1200 && !live.since(mark).some((e) => e.method === "turn/completed" && e.params?.turnId === running.turnId); i++) await sleep(100);
    const describe = async (f) => {
      if (!f.created) return f;
      const b = await live.request("session/read", { sessionId: f.sessionId, excludeItems: false });
      const items = b.history?.items ?? [];
      const turnIds = [...new Set(items.map((i) => i.turnId))];
      return {
        created: true,
        cut: f.forkedFrom?.cutCursor?.replace(/^.*:turn:/, "turn:"),
        cutExplicit: f.forkedFrom?.cutExplicit,
        turnCount: b.session.turnCount,
        turnsInHistory: turnIds.length,
        userMessages: items.filter((i) => i.kind === "userMessage").map((i) => bounded(String(i.text), 50)),
        runningTurnPromptCopied: items.some((i) => i.kind === "userMessage" && String(i.text).includes("rivers")),
        runningTurnIdReused: turnIds.includes(running.turnId),
      };
    };
    report.activeSource = {
      sourceStatusAtFork: statusAtFork,
      sourceTurnEndedBeforeForks: endedBeforeForks,
      anchorless: await describe(anchorless),
      atLastCompletedTurn: await describe(atLastCompleted),
    };
  } catch (error) {
    report.activeSource.failure = bounded(String(error?.message ?? error), 240);
  } finally {
    await live.stop();
  }
}

const f = report.forks ?? {};
report.verdict = {
  engineIs142: /^Muse Code 1\.4\.2 \(1\.4\.2-R4684\.1\)$/.test(report.engine) && report.serverVersion === "1.4.2",
  noWriteFailed: report.writeFailedSeen === false,
  forkAtLatestTurnCreated: f.atTurn3Latest?.created === true && f.atTurn3Latest.newId && f.atTurn3Latest.forkedFrom?.sourceIsTheSource && f.atTurn3Latest.forkedFrom?.cutExplicit === true,
  anchorlessForkCreated: f.anchorless?.created === true && f.anchorless.newId && f.anchorless.forkedFrom?.sourceIsTheSource && f.anchorless.forkedFrom?.cutExplicit === false,
  branchesAreRealCopies: Object.values(report.branches ?? {}).length > 0 && Object.values(report.branches).every((b) => b.sameWorkspace && b.historyEqualsSource),
  unknownTurnRefused: f.atUnknownTurn?.created === false && f.atUnknownTurn.kind === "forkBoundaryInvalid",
  independentBothWays: report.independence?.sourceHasBranchTurn === false && report.independence?.branchHasSourceTurn === false
    && report.independence?.sourceKeepsItsHistory === true && report.independence?.branchKeepsTheCopiedHistory === true,
  provenanceDurable: report.durableProvenance?.forkedFromKept === true,
  forkAtEarlierCompletedTurnCreated: f.atTurn1?.created === true && f.atTurn2?.created === true,
};
if (report.activeSource) {
  const a = report.activeSource;
  report.verdict.activeSourceForkStopsAtLastCompletedTurn = a.sourceStatusAtFork === "running" && a.sourceTurnEndedBeforeForks === false
    && [a.anchorless, a.atLastCompletedTurn].every((b) => b?.created && b.turnsInHistory === 1 && !b.runningTurnPromptCopied);
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (OUT) { mkdirSync(dirname(resolve(OUT)), { recursive: true }); writeFileSync(OUT, text); }
process.stdout.write(text);
