#!/usr/bin/env node

/**
 * Non-billed host-contract probe: `muse serve --provider echo`.
 *
 * Answers, without spending model tokens, two questions the roadmap left as
 * host blockers:
 *   - M1-09: does `session/fork` create a branch on this host build?
 *   - M2-01/M2-05: does `turn/start.workspaceRoots` (1.4.x) move a session's
 *     working root, so a conversation can continue in another folder?
 *
 * Usage:
 *   node scripts/msp-echo-probe.mjs [--binary <muse-bin.exe>] [--live-tool]
 *
 * `--live-tool` adds one billed turn (default provider) to see where the
 * model's own shell tool runs after the move.
 *
 * The report is path-free: roots are named A and B.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bounded, connect, createHost, has, startSession, uuidv7, value } from "./msp-probe.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BINARY = value("--binary") ?? join(REPO, "src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
const WINDOW_MS = 20_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * workspaceRoots entries must already be canonical: on Windows that is the
 * verbatim `\\?\C:\...` form the host resolves them to.
 */
const canonicalRoot = (path) =>
  process.platform === "win32" ? `\\\\?\\${realpathSync.native(path)}` : realpathSync.native(path);

async function waitFor(host, mark, match) {
  const deadline = Date.now() + WINDOW_MS;
  while (Date.now() < deadline) {
    const hit = host.since(mark).find(match);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

async function turn(host, sessionId, text, extra = {}) {
  const mark = host.mark();
  let turnId = null;
  const sent = await host
    .request("turn/start", { sessionId, commandId: uuidv7(), input: [{ type: "text", text }], ...extra })
    .then((result) => { turnId = result?.turnId ?? result?.turn?.turnId ?? null; return "accepted"; })
    .catch((error) => `rejected: ${bounded(error.message, 200)}`);
  // The host names the turn; match its terminal by that id when it was returned.
  const done = sent === "accepted"
    ? await waitFor(host, mark, (e) => e.method === "turn/completed" && (!turnId || e.params?.turnId === turnId))
    : null;
  return { turnId: turnId ?? done?.params?.turnId ?? null, sent, terminal: done?.params?.terminal ?? null };
}

/**
 * Say which root a user shell runs in. The host runs the command line as argv
 * (no shell parsing), so `cmd /c cd` / `pwd` prints the working directory.
 */
async function shellRoot(host, sessionId, roots) {
  const mark = host.mark();
  const admitted = await host
    .request("session/userShell", { sessionId, commandId: uuidv7(), commandText: process.platform === "win32" ? "cmd /c cd" : "pwd" })
    .then(() => "accepted")
    .catch((error) => `rejected: ${bounded(error.message, 200)}`);
  if (admitted !== "accepted") return { admitted };
  const item = await waitFor(host, mark, (e) => e.method === "item/completed" && e.params?.item?.kind === "userShell");
  const printed = String(item?.params?.item?.visibleOutput ?? "").trim().toLowerCase();
  // Longest match first: B is not a prefix of A here, but stay exact anyway.
  const cwd = Object.entries(roots).find(([, path]) => printed.endsWith(path.toLowerCase()))?.[0] ?? "neither";
  return { admitted, status: item?.params?.item?.status ?? null, cwd };
}
/** Which root `session/read` reports as the session's workspace. */
async function sessionRoot(host, sessionId, roots) {
  const read = await host.request("session/read", { sessionId, excludeItems: true }).catch(() => null);
  const root = String(read?.session?.workspaceRoot ?? "").toLowerCase();
  return Object.entries(roots).find(([, path]) => root.endsWith(path.toLowerCase()))?.[0] ?? "neither";
}

/**
 * Live (billed) check on a second host with the default provider: start in A,
 * move the session to B with `turn/start.workspaceRoots`, and ask the model to
 * print its working directory with its own shell tool.
 */
async function modelToolRoot(_, roots) {
  const live = createHost(BINARY, roots.A, ["--disable-sandbox"]);
  try {
    await connect(live);
    const { sessionId } = await startSession(live, roots.A);
    await live.request("session/setApprovalMode", { sessionId, commandId: uuidv7(), mode: "allowAll" }).catch(() => undefined);
    const mark = live.mark();
    const moved = await turn(live, sessionId, "Run exactly `cmd /c cd` with your shell tool and reply with its output only.", { workspaceRoots: [canonicalRoot(roots.B)] });
    const outputs = live.since(mark)
      .filter((e) => e.method === "item/completed" && e.params?.item?.kind === "toolCall")
      .map((e) => JSON.stringify(e.params.item).toLowerCase().replaceAll("\\\\", "\\"));
    const cwd = Object.entries(roots).find(([, path]) => outputs.some((text) => text.includes(path.toLowerCase())))?.[0] ?? "neither";
    return { sent: moved.sent, terminal: moved.terminal, toolCalls: outputs.length, cwd };
  } finally {
    await live.stop();
  }
}

async function fork(host, sessionId, cutPoint) {
  return host
    .request("session/fork", { sessionId, commandId: uuidv7(), excludeItems: true, ...(cutPoint ? { cutPoint } : {}) })
    .then((result) => ({ created: Boolean(result?.session?.sessionId ?? result?.session?.id), forkedFrom: Boolean(result?.session?.forkedFrom) }))
    .catch((error) => ({ created: false, code: error.code, kind: error.kind, detail: bounded(error.message, 240) }));
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), "muse-echo-probe-"));
  const roots = { A: join(base, "a"), B: join(base, "b") };
  // workspaceRoots entries must already be canonical: on Windows that is the
  // verbatim `\\?\C:\...` form the host resolves them to.

  await mkdir(roots.A);
  await mkdir(roots.B);
  execFileSync("git", ["init", "-q"], { cwd: roots.A });
  const host = createHost(BINARY, roots.A, ["--provider", "echo", "--disable-sandbox"]);
  // The Windows shell sandbox defect (managed shell sandbox is unavailable)
  // would fail every userShell; the elevated posture lets `cd` report the root.
  const report = { schema: "muse-desktop.msp-echo-probe.v1", provider: "echo", sandbox: "disabled" };
  try {
    const initialized = await connect(host, { requestedCapabilities: ["userShell"] });
    report.serverVersion = initialized?.serverInfo?.version ?? null;
    const { sessionId } = await startSession(host, roots.A);
    if (!sessionId) throw new Error("no session id");

    const first = await turn(host, sessionId, "first turn");
    const second = await turn(host, sessionId, "second turn");
    report.turns = [first, second].map(({ sent, terminal }) => ({ sent, terminal }));

    report.fork = {
      atFirstTurn: await fork(host, sessionId, { lastTurnId: first.turnId }),
      anchorless: await fork(host, sessionId),
    };

    report.workspaceRoots = { before: await shellRoot(host, sessionId, roots) };
    const moved = await turn(host, sessionId, "turn in B", { workspaceRoots: [canonicalRoot(roots.B)] });
    report.workspaceRoots.turnInB = { sent: moved.sent, terminal: moved.terminal };
    report.workspaceRoots.after = await shellRoot(host, sessionId, roots);
    report.workspaceRoots.sessionReadRoot = await sessionRoot(host, sessionId, roots);
    if (has("--live-tool")) report.workspaceRoots.modelToolAfterMove = await modelToolRoot(sessionId, roots);
    const back = await turn(host, sessionId, "turn back in A", { workspaceRoots: [canonicalRoot(roots.A)] });
    report.workspaceRoots.turnBackInA = { sent: back.sent, terminal: back.terminal };
    report.workspaceRoots.afterBack = await shellRoot(host, sessionId, roots);
  } catch (error) {
    report.failure = bounded(error.message, 240);
  } finally {
    await host.stop();
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
