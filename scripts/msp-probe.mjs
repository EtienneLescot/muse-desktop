#!/usr/bin/env node

/**
 * Bounded MSP host-contract probe for the Windows sidecar.
 *
 * This script answers one question: which of the remaining group-1 acceptance
 * criteria are blocked by the Muse host itself, as opposed to by the desktop
 * client or by the test harness? It talks to a real `muse serve` child over
 * stdio and records exactly what the host does or does not emit.
 *
 * Deliberately separate from `native-smoke.mjs`: that script is the CI-safe
 * transport check and must stay free of model turns. This probe is opt-in and
 * its `--live` paths spend real provider tokens, so nothing here runs unless a
 * mode flag is passed explicitly.
 *
 * Usage:
 *   node scripts/msp-probe.mjs --no-live
 *   node scripts/msp-probe.mjs --interrupt --live
 *   node scripts/msp-probe.mjs --approval --live
 *   node scripts/msp-probe.mjs --approval --live --approval-mode onRequest --decide abort --stale
 *   node scripts/msp-probe.mjs --user-shell
 *   node scripts/msp-probe.mjs --all --live
 *
 * Every path writes only bounded, path-free facts. Raw frames, prompts and
 * transcripts are never included in the report.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_BINARY = join(REPO, "src-tauri", "binaries", "muse-x86_64-pc-windows-msvc.exe");
const REQUEST_TIMEOUT_MS = 20_000;
const NOTIFICATION_WINDOW_MS = 25_000;
const MAX_APPROVAL_STAGES = 4;

const argv = process.argv.slice(2);
export const has = (name) => argv.includes(name);
export const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : undefined;
};

const MODE_ALL = has("--all");
const mode = (name) => MODE_ALL || has(`--${name}`);

export function bounded(value, max = 160) {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function reason(error) {
  return bounded(error instanceof Error ? error.message : String(error), 200);
}

/** Minimal MSP client over newline JSON-RPC on a real child process. */
function createHost(binary, workspace) {
  // The app's own argv (main.rs HostSandboxPolicy for the workspace mode), so
  // the probe measures the host the desktop actually runs. The launcher
  // self-updates unless told not to.
  const child = spawn(binary, ["serve", "--sandbox-network", "restricted", "--trust-workspace"], {
    cwd: workspace,
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notifications = [];

  // Drain stderr: the pipe is declared but nothing consumes it otherwise, and
  // a host that writes more than the pipe capacity (~64 KiB) would block on
  // stderr and stop answering, which the probe would misreport as a timeout.
  child.stderr.resume();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof frame.method === "string") {
        // A frame carrying both `method` and `id` is a server request, which
        // blocks the host until answered. `approval/request` gets an empty
        // result (the decision itself goes through `approval/decide`);
        // anything else is refused the way the SDK does without a handler.
        const serverRequest = frame.id !== undefined && frame.id !== null;
        if (serverRequest && !closed) {
          const reply = frame.method === "approval/request"
            ? { jsonrpc: "2.0", id: frame.id, result: {} }
            : { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `method not found: ${frame.method}`, data: { kind: "methodNotFound" } } };
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        }
        notifications.push({ method: frame.method, params: frame.params, at: Date.now(), serverRequest });
        if (notifications.length > 500) notifications.shift();
        continue;
      }
      if (frame.id === undefined) continue;
      const request = pending.get(String(frame.id));
      if (!request) continue;
      pending.delete(String(frame.id));
      clearTimeout(request.timer);
      if (frame.error) {
        const error = new Error(`${request.method} failed: ${frame.error.message || "MSP request failed"}`);
        error.code = Number.isInteger(frame.error.code) ? frame.error.code : -1;
        error.kind = typeof frame.error.data?.kind === "string" ? frame.error.data.kind : "unknown";
        error.reason = typeof frame.error.data?.reason === "string" ? frame.error.data.reason : undefined;
        request.reject(error);
      } else {
        request.resolve(frame.result);
      }
    }
  });
  child.once("error", () => { closed = true; });
  child.once("exit", () => { closed = true; });

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error(`${method}: host is closed`));
    const id = nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`${method}: timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(String(id), { method, resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  const since = (mark) => notifications.filter((entry) => entry.at >= mark);

  return {
    request,
    notify,
    since,
    mark: () => Date.now(),
    methods: () => [...new Set(notifications.map((entry) => entry.method))].sort(),
    async stop() {
      if (closed) return;
      try { child.stdin.end(); } catch { /* already gone */ }
      await new Promise((done) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } done(); }, 4_000);
        child.once("exit", () => { clearTimeout(timer); done(); });
      });
    },
  };
}

export const uuidv7 = () => {
  // RFC 9562: 48-bit big-endian Unix millisecond timestamp, then version 7 in
  // the high nibble of byte 6 and the RFC 4122 variant in byte 8. The previous
  // form shifted the timestamp right by 16 bits and wrote 32 bits over six
  // bytes, so every identifier started with 0000 and was neither time-sortable
  // nor conformant.
  const now = BigInt(Date.now());
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number(now & 0xffffffffffffn), 0, 6);
  for (let index = 6; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function connect(host, capabilities) {
  const initialized = await host.request("initialize", {
    clientInfo: { name: "msp_probe", version: "1.0.0" },
    ...(capabilities ? { capabilities } : {}),
  });
  host.notify("initialized", {});
  return initialized;
}

async function startSession(host, workspaceRoot) {
  const commandId = uuidv7();
  const result = await host.request("session/start", { commandId, workspaceRoot });
  const session = result?.session;
  return { commandId, sessionId: session?.sessionId ?? session?.id };
}

/** Classify what a host does after `turn/interrupt`. */
async function probeInterrupt(host, sessionId, live) {
  const turnId = uuidv7();
  const sent = await host
    .request("turn/start", {
      sessionId,
      commandId: uuidv7(),
      turnId,
      input: [{ type: "text", text: "count slowly from one to forty, one number per line" }],
      ifBusy: "queue",
    })
    .catch((error) => ({ error: reason(error) }));
  if (sent?.error) return { sent: "rejected", detail: sent.error };
  if (!live) return { sent: "accepted", interrupted: "skipped (no --live)" };

  const mark = host.mark();
  await new Promise((done) => setTimeout(done, 1_500));
  const interrupted = await host
    .request("turn/interrupt", { sessionId, turnId, commandId: uuidv7() })
    .then(() => "accepted")
    .catch((error) => `rejected: ${reason(error)}`);

  const deadline = Date.now() + NOTIFICATION_WINDOW_MS;
  let terminal = null;
  while (Date.now() < deadline && !terminal) {
    terminal = host
      .since(mark)
      .find((entry) =>
        ["turn/completed", "turn/retracted", "turn/stopped"].includes(entry.method) &&
        (!entry.params?.sessionId || entry.params.sessionId === sessionId));
    if (!terminal) await new Promise((done) => setTimeout(done, 400));
  }
  const observed = host
    .since(mark)
    .map((entry) => entry.method)
    .filter((method, index, all) => all.indexOf(method) === index)
    .sort();

  return {
    sent: "accepted",
    interrupted,
    terminalNotification: terminal ? terminal.method : "unsupported",
    observedNotifications: observed,
    waitedMs: NOTIFICATION_WINDOW_MS,
  };
}

/** Path-free projection of `approval/request(ed)` params or a listPending row. */
function describeApproval(params) {
  return {
    approvalId: bounded(params?.approvalId),
    currentRequirementId: bounded(JSON.stringify(params?.currentRequirementId)),
    toolName: bounded(params?.toolName),
    subjectKind: bounded(params?.subject?.kind),
    choices: Array.isArray(params?.availableChoices)
      ? params.availableChoices.map((choice) => ({
        choiceId: bounded(choice?.choiceId),
        decision: bounded(choice?.decision?.kind ?? choice?.decision),
        scope: bounded(choice?.scope),
      }))
      : null,
  };
}

/**
 * The next stage of a compound approval: the same approvalId re-issued with a
 * requirement token that has not been decided yet. Metadata-only updates carry
 * no token and are skipped (main.rs keeps the last token for those too).
 */
export function nextApprovalStage(entries, approvalId, decided) {
  return entries.find((entry) =>
    ["approval/updated", "approval/request", "approval/requested"].includes(entry.method) &&
    entry.params?.approvalId === approvalId &&
    entry.params?.currentRequirementId != null &&
    !decided.has(JSON.stringify(entry.params.currentRequirementId)));
}

/** Classify what a host does with an approval-gated turn. */
async function probeApproval(host, sessionId, live, workspace) {
  if (!live) return { skipped: "requires --live" };
  const approvalMode = value("--approval-mode") ?? "onRequest";
  const modeSet = await host
    .request("session/setApprovalMode", { sessionId, commandId: uuidv7(), mode: approvalMode })
    .then((result) => ({ applyOutcome: bounded(result?.applyOutcome), effectiveMode: bounded(result?.effectiveMode?.mode) }))
    .catch((error) => ({ rejected: reason(error), code: error?.code, kind: error?.kind }));

  // `echo` is on the onRequest read-only allowlist and never prompts. A write
  // whose argument is a variable cannot be resolved statically, so it must.
  const mark = host.mark();
  const sent = await host
    .request("turn/start", {
      sessionId,
      commandId: uuidv7(),
      turnId: uuidv7(),
      input: [{
        type: "text",
        text: "Run exactly this PowerShell command in the workspace, unchanged: $m = 'm05'; Set-Content -Path probe.txt -Value $m",
      }],
      ifBusy: "queue",
    })
    .catch((error) => ({ error: reason(error) }));
  if (sent?.error) return { approvalMode, modeSet, sent: "rejected", detail: sent.error };

  const ofSession = (method) => host
    .since(mark)
    .find((entry) => entry.method === method && entry.params?.sessionId === sessionId);
  const deadline = Date.now() + NOTIFICATION_WINDOW_MS;
  let request = null;
  while (Date.now() < deadline && !request) {
    request = ofSession("approval/requested") ?? ofSession("approval/request");
    if (!request) await new Promise((done) => setTimeout(done, 400));
  }
  if (!request) {
    return { approvalMode, modeSet, sent: "accepted", approvalRequested: false, observedNotifications: host.since(mark).map((e) => e.method) };
  }

  const pendingRows = await host
    .request("approval/listPending", { sessionId })
    .then((result) => (Array.isArray(result?.approvals) ? result.approvals.map(describeApproval) : null))
    .catch((error) => `error: ${reason(error)}`);

  // approval/decide (schema 1.4.2): a server-minted choiceId from
  // availableChoices, and the current requirement token echoed verbatim. A
  // compound command keeps one approvalId across stages: `terminal: false`
  // leaves it pending and the host re-issues it with a new token and new
  // choices, so each stage is decided until one is terminal.
  const wanted = value("--decide") ?? "allow_once";
  const approvalId = request.params?.approvalId;
  // Replay a retired token under a fresh commandId: -32053 when the stage
  // advanced; once terminal the host may answer approvalAlreadyResolved, so
  // the actual code and kind are recorded rather than assumed.
  const replay = (params) => host
    .request("approval/decide", { ...params, commandId: uuidv7() })
    .then((result) => ({ accepted: true, status: bounded(result?.status), expectedCode: -32053 }))
    .catch((error) => ({ code: error?.code, kind: error?.kind, expectedCode: -32053, matched: error?.code === -32053 }));
  const decided = new Set();
  const decisions = [];
  let stale;
  let lastDecided;
  let stage = request;
  while (stage && decisions.length < MAX_APPROVAL_STAGES) {
    const requirementId = stage.params?.currentRequirementId;
    decided.add(JSON.stringify(requirementId));
    const offered = Array.isArray(stage.params?.availableChoices) &&
      stage.params.availableChoices.some((candidate) => candidate?.choiceId === wanted);
    if (!offered) {
      decisions.push({ choiceId: bounded(wanted, 40), skipped: `choice ${bounded(wanted, 40)} not offered` });
      break;
    }
    lastDecided = { sessionId, approvalId, choiceId: wanted, requirementId };
    const decide = await host
      .request("approval/decide", { ...lastDecided, commandId: uuidv7() })
      .then((result) => ({ status: bounded(result?.status), terminal: result?.terminal ?? null }))
      .catch((error) => ({ rejected: reason(error), code: error?.code, kind: error?.kind }));
    decisions.push({ requirementId: bounded(JSON.stringify(requirementId)), choiceId: bounded(wanted, 40), ...decide });
    // main.rs approval_terminal: only an explicit `false` keeps it pending.
    if (decide.terminal !== false) break;
    stage = null;
    const stageDeadline = Date.now() + NOTIFICATION_WINDOW_MS;
    while (Date.now() < stageDeadline && !stage) {
      stage = nextApprovalStage(host.since(mark), approvalId, decided);
      if (!stage) await new Promise((done) => setTimeout(done, 400));
    }
    if (stage && has("--stale") && !stale) stale = await replay(lastDecided);
  }
  if (has("--stale") && !stale && lastDecided) stale = await replay(lastDecided);
  const last = decisions.at(-1);
  const decidedTerminally = Boolean(last && !last.skipped && !last.rejected && last.terminal !== false);

  const resumedDeadline = Date.now() + NOTIFICATION_WINDOW_MS;
  let terminal = null;
  while (Date.now() < resumedDeadline && !terminal) {
    terminal = host
      .since(mark)
      .find((entry) =>
        ["turn/completed", "turn/retracted", "turn/stopped"].includes(entry.method) &&
        (!entry.params?.sessionId || entry.params.sessionId === sessionId));
    if (!terminal) await new Promise((done) => setTimeout(done, 400));
  }
  const requested = ofSession("approval/requested");
  const hostRequest = ofSession("approval/request");
  return {
    approvalMode,
    modeSet,
    sent: "accepted",
    approvalRequested: requested ? describeApproval(requested.params) : false,
    serverRequest: hostRequest
      ? { ...describeApproval(hostRequest.params), answeredWithEmptyResult: hostRequest.serverRequest }
      : false,
    pendingRows,
    decisions,
    ...(stale ? { stale } : {}),
    // "unsupported" is a host finding only when every stage was decided
    // terminally; otherwise the turn is still waiting on the probe.
    resumedToTerminal: terminal ? terminal.method : decidedTerminally ? "unsupported" : "approval not decided terminally",
    probeFileWritten: existsSync(join(workspace, "probe.txt")),
  };
}

/** Check whether a `userShell` command ever surfaces as a transcript item. */
async function probeUserShell(host, sessionId) {
  const commandId = uuidv7();
  const mark = host.mark();
  const admitted = await host
    .request("session/userShell", { sessionId, commandId, commandText: "echo probe-user-shell-marker" })
    .then(() => "accepted")
    .catch((error) => `rejected: ${reason(error)}`);
  if (admitted !== "accepted") return { admitted, itemStarted: false, outputRef: null };

  const deadline = Date.now() + NOTIFICATION_WINDOW_MS;
  let item = null;
  while (Date.now() < deadline && !item) {
    item = host
      .since(mark)
      .find((entry) =>
        ["item/started", "item/completed", "item/updated"].includes(entry.method) &&
        entry.params?.item?.kind === "userShell");
    if (!item) await new Promise((done) => setTimeout(done, 400));
  }
  const readBack = await host
    .request("session/read", { sessionId, excludeItems: false })
    .then((result) => (Array.isArray(result?.items) ? result.items : null))
    .catch(() => null);

  return {
    admitted,
    itemStarted: Boolean(item),
    itemKind: item?.params?.item?.kind ?? null,
    outputRef: typeof item?.params?.item?.outputRef === "string" ? "present" : null,
    historyReadable: readBack !== null,
    historyUserShellItems: readBack
      ? readBack.filter((entry) => entry?.kind === "userShell").length
      : null,
  };
}

/** Record which optional read surfaces the host actually serves. */
async function probeReadSurfaces(host, sessionId) {
  const attempt = async (method, params) => {
    try {
      await host.request(method, params);
      return "available";
    } catch (error) {
      return error?.kind === "methodNotFound" ? "unsupported" : `error: ${reason(error)}`;
    }
  };
  return {
    "session/read": await attempt("session/read", { sessionId, excludeItems: true }),
    "session/resume": await attempt("session/resume", { sessionId, commandId: uuidv7() }),
    "session/list": await attempt("session/list", { limit: 5 }),
    "view/page": await attempt("view/page", { sessionId, limit: 5 }),
    "approval/listPending": await attempt("approval/listPending", { sessionId }),
  };
}

/** Report whether `approval/listPending` returns a usable list, not just no error. */
async function probeApprovalList(host, sessionId) {
  try {
    const result = await host.request("approval/listPending", { sessionId });
    const approvals = Array.isArray(result?.approvals) ? result.approvals.length : null;
    const userInputs = Array.isArray(result?.userInputs) ? result.userInputs.length : null;
    return {
      status: "available",
      resultShape: Array.isArray(result) ? "array" : Object.keys(result ?? {}).sort(),
      pendingApprovals: approvals,
      pendingUserInputs: userInputs,
    };
  } catch (error) {
    return { status: error?.kind === "methodNotFound" ? "unsupported" : `error: ${reason(error)}` };
  }
}

async function main() {
  const binary = resolve(value("--binary") ?? DEFAULT_BINARY);
  if (!existsSync(binary)) {
    process.stderr.write(`probe binary is missing: ${binary}\n`);
    process.stderr.write("copy the Muse Windows binary into src-tauri/binaries/ first\n");
    process.exitCode = 1;
    return;
  }
  if (!mode("no-live") && !mode("interrupt") && !mode("approval") && !mode("user-shell") && !mode("surfaces") && !MODE_ALL) {
    process.stderr.write("nothing to do: pass --no-live, --surfaces, --user-shell, --interrupt --live or --approval --live\n");
    process.exitCode = 1;
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "msp-probe-"));
  await writeFile(join(workspace, "README.md"), "msp-probe scratch workspace\n", "utf8");
  const host = createHost(binary, workspace);
  const report = { schema: "muse-desktop.msp-probe.v1", live: has("--live"), checks: {} };

  try {
    const initialized = await connect(host, mode("user-shell") ? { requestedCapabilities: ["userShell"] } : undefined);
    report.host = {
      serverInfo: bounded(initialized?.serverInfo?.name),
      serverVersion: bounded(initialized?.serverInfo?.version),
      schemaVersion: initialized?.schema?.version ?? null,
      sessionDurability: initialized?.sessionDurability ?? null,
      grantedCapabilities: Array.isArray(initialized?.grantedCapabilities)
        ? initialized.grantedCapabilities
        : null,
      initializeFields: Object.keys(initialized ?? {}).sort(),
    };

    const { sessionId } = await startSession(host, workspace);
    report.sessionCreated = Boolean(sessionId);
    if (!sessionId) throw new Error("host did not return a session id");

    if (mode("surfaces") || MODE_ALL) {
      report.checks.readSurfaces = await probeReadSurfaces(host, sessionId);
      report.checks.approvalListPending = await probeApprovalList(host, sessionId);
    }
    if (mode("user-shell") || MODE_ALL) report.checks.userShell = await probeUserShell(host, sessionId);
    if (mode("interrupt") || MODE_ALL) {
      report.checks.interrupt = await probeInterrupt(host, sessionId, has("--live"));
    }
    if (mode("approval") || MODE_ALL) {
      report.checks.approval = await probeApproval(host, sessionId, has("--live"), workspace);
    }
    report.notificationMethods = host.methods();
  } catch (error) {
    report.failure = reason(error);
  } finally {
    await host.stop();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
