#!/usr/bin/env node
/**
 * Small, opt-in native MSP smoke test for the Windows sidecar.
 *
 * By default this stops before a model turn: it proves that two real
 * `muse serve` processes can handshake, own independent workspaces, create a
 * session and answer a read-only model catalogue request. The explicit
 * `--exercise-control` path admits and immediately interrupts one turn per
 * host to validate the native cancellation contract. The explicit
 * `--exercise-errors` path asks each host for two malformed operations and
 * checks that the structured JSON-RPC category is preserved without exposing
 * a raw wire payload. It is a diagnostic harness, not a substitute for the
 * full Tauri E2E scenario in M0-01c.
 * The explicit `--exercise-approval` path records the host's startup posture
 * and attempts each supported mode, accepting either an effective projection
 * or the host's explicit ceiling rejection.
 * The explicit `--exercise-isolation` path kills host B after setup and
 * verifies that host A still answers a read-only request.
 * The explicit `--exercise-cut-during-turn` path accepts a turn on host B,
 * closes that sidecar before a terminal notification, and verifies that host
 * A remains reachable. It is a transport/isolation proof, not a model test.
 * The explicit `--exercise-user-shell` path negotiates the `userShell`
 * capability, admits a harmless command in each workspace and observes the
 * corresponding shell item without sending a model turn.
 * The explicit `--exercise-user-shell-slow` path admits a ~9s command that
 * prints a unique marker, then records whether the host serves the output
 * back through its item stream or readable history. Absence of output is
 * reported as an explicit boundary, never as a successful restitution.
 * The explicit `--exercise-reconnect` path reads each live session and its
 * pending approval/input snapshot. This is the native reconciliation half of
 * M0-02/M0-05; it deliberately does not claim a cold resume because the
 * bundled sidecar currently reports ephemeral session durability.
 * The explicit `--exercise-history` path probes the bounded `session/list`
 * and `view/page` reads used by the renderer's restore fallback. Unsupported
 * methods are reported as such rather than treated as a successful proof.
 * The explicit `--exercise-terminal` path tightens `--exercise-control` by
 * requiring a terminal turn notification after the interrupt acknowledgement.
 * The explicit `--exercise-reasoning` path applies the supported reasoning
 * effort values to each ephemeral session and records the host's effective
 * projection without starting a model turn.
 * The explicit `--exercise-model` path selects one model from `model/list`,
 * applies it to each ephemeral session and re-reads the catalogue to check
 * whether the host projects the active model.
 * The explicit `--exercise-compaction` path probes `session/compact` on a
 * fresh session and records whether the host admits a no-op, reports that a
 * turn is missing/active, or does not expose the method. It never starts a
 * model turn or sends conversation content.
 * The explicit `--exercise-queue` path admits two synthetic turns on each
 * session, records the host disposition for the second one and reclaims it
 * with `turn/unqueue` when the host actually queues it.
 *
 * Usage:
 *   node scripts/native-smoke.mjs
 *   node scripts/native-smoke.mjs --binary C:\\path\\to\\muse.exe
 *   node scripts/native-smoke.mjs --exercise-control
 *   node scripts/native-smoke.mjs --exercise-errors
 *   node scripts/native-smoke.mjs --exercise-approval
 *   node scripts/native-smoke.mjs --exercise-isolation
 *   node scripts/native-smoke.mjs --exercise-cut-during-turn
 *   node scripts/native-smoke.mjs --exercise-user-shell
 *   node scripts/native-smoke.mjs --exercise-user-shell --exercise-user-shell-slow
 *   node scripts/native-smoke.mjs --exercise-reconnect
 *   node scripts/native-smoke.mjs --exercise-history
 *   node scripts/native-smoke.mjs --exercise-reasoning
 *   node scripts/native-smoke.mjs --exercise-model
 *   node scripts/native-smoke.mjs --exercise-compaction
 *   node scripts/native-smoke.mjs --exercise-queue
 *   node scripts/native-smoke.mjs --exercise-control --exercise-terminal
 *   node scripts/native-smoke.mjs --report artifacts/native-smoke.json
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const SESSION_LIST_LIMIT = 200;
const SESSION_LIST_MAX_PAGES = 20;
const SESSION_LIST_MAX_CURSOR_CHARS = 4_096;
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BINARY = join(
  REPO_ROOT,
  "src-tauri",
  "binaries",
  "muse-x86_64-pc-windows-msvc.exe",
);

function binaryArgument() {
  const index = process.argv.indexOf("--binary");
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : DEFAULT_BINARY;
}

function reportArgument() {
  const index = process.argv.indexOf("--report");
  if (index < 0) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    fail("--report requires a destination file");
  }
  return resolve(process.argv[index + 1]);
}

function exercisesControlPath() {
  return process.argv.includes("--exercise-control");
}

function exercisesErrorPath() {
  return process.argv.includes("--exercise-errors");
}

function exercisesApprovalPath() {
  return process.argv.includes("--exercise-approval");
}

function exercisesIsolationPath() {
  return process.argv.includes("--exercise-isolation");
}

function exercisesCutDuringTurnPath() {
  return process.argv.includes("--exercise-cut-during-turn");
}

function exercisesUserShellPath() {
  return process.argv.includes("--exercise-user-shell");
}

function exercisesUserShellSlowPath() {
  return process.argv.includes("--exercise-user-shell-slow");
}

function exercisesReconnectPath() {
  return process.argv.includes("--exercise-reconnect");
}

function exercisesHistoryPath() {
  return process.argv.includes("--exercise-history");
}

function exercisesReasoningPath() {
  return process.argv.includes("--exercise-reasoning");
}

function exercisesModelPath() {
  return process.argv.includes("--exercise-model");
}

function exercisesCompactionPath() {
  return process.argv.includes("--exercise-compaction");
}

function exercisesQueuePath() {
  return process.argv.includes("--exercise-queue");
}

function exercisesTerminalPath() {
  return process.argv.includes("--exercise-terminal");
}

async function waitForTerminalNotification(host, turnId, label, required) {
  for (const method of ["turn/completed", "turn/retracted", "turn/stopped"]) {
    try {
      const params = await host.waitForNotification(
        method,
        (candidate) => candidate?.turnId === turnId,
        2_500,
      );
      return { method, params };
    } catch {
      // Compatible hosts use different terminal aliases. Keep probing the
      // allowlisted forms, but never treat an interrupt acknowledgement as a
      // terminal state by itself.
    }
  }
  if (required) fail(`${label} did not emit a terminal notification for ${turnId}`);
  return { method: null, params: null };
}

function fail(message) {
  throw new Error(message);
}

function uuidv7() {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now()) & 0xffffffffffffn;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createHost(binary, workspace, label) {
  const child = spawn(binary, ["serve", "--no-session-log"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const notifications = [];
  const notificationMethods = new Set();
  const notificationWaiters = [];

  const closePending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

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
        closePending(new Error(`${label} returned an invalid JSON frame`));
        return;
      }
      if (typeof frame.method === "string") {
        const notification = { method: frame.method, params: frame.params };
        notificationMethods.add(frame.method);
        notifications.push(notification);
        if (notifications.length > 100) notifications.shift();
        for (let index = notificationWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = notificationWaiters[index];
          if (waiter.method !== notification.method || !waiter.predicate(notification.params)) continue;
          notificationWaiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(notification.params);
        }
        continue;
      }
      if (frame.id !== undefined) {
        const request = pending.get(String(frame.id));
        if (!request) continue;
        pending.delete(String(frame.id));
        clearTimeout(request.timer);
        if (frame.error) {
          const error = new Error(`${request.method} failed: ${frame.error.message || "MSP request failed"}`);
          // Keep only the structured fields needed by the harness. The raw
          // frame is deliberately never included in diagnostics or output.
          error.code = Number.isInteger(frame.error.code) ? frame.error.code : -1;
          error.kind = typeof frame.error.data?.kind === "string" ? frame.error.data.kind : "unknown";
          error.reason = typeof frame.error.data?.reason === "string" ? frame.error.data.reason : undefined;
          error.retryable = typeof frame.error.data?.retryable === "boolean" ? frame.error.data.retryable : undefined;
          request.reject(error);
        }
        else request.resolve(frame.result);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.once("error", (error) => {
    closed = true;
    closePending(new Error(`${label} could not start: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    closed = true;
    resolveExit(true);
    const detail = stderr.trim() ? ` (${stderr.trim().replace(/\s+/g, " ")})` : "";
    closePending(new Error(`${label} exited before the response (code ${code ?? "?"}, signal ${signal ?? "?"})${detail}`));
  });

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error(`${label} is already closed`));
    const id = nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`${label} timed out on ${method}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(String(id), { method, resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function waitForNotification(method, predicate = () => true, timeoutMs = REQUEST_TIMEOUT_MS) {
    const existing = notifications.find(
      (notification) => notification.method === method && predicate(notification.params),
    );
    if (existing) return Promise.resolve(existing.params);
    if (closed) return Promise.reject(new Error(`${label} is already closed`));
    return new Promise((resolveNotification, reject) => {
      const timer = setTimeout(() => {
        const index = notificationWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) notificationWaiters.splice(index, 1);
        const seen = [...notificationMethods].sort().join(", ") || "none";
        reject(new Error(`${label} timed out waiting for ${method} (notifications: ${seen})`));
      }, timeoutMs);
      notificationWaiters.push({ method, predicate, resolve: resolveNotification, reject, timer });
    });
  }

  async function close() {
    if (!closed) {
      closed = true;
      closePending(new Error(`${label} closed`));
      for (const waiter of notificationWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label} closed`));
      }
      if (process.platform === "win32") {
        // Kill the complete sidecar tree before the parent can exit and lose
        // the PID that taskkill needs to reach WSL descendants.
        await forceTerminate(child);
      } else {
        child.kill();
      }
    }
    const exitedInTime = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), PROCESS_EXIT_TIMEOUT_MS)),
    ]);
    if (exitedInTime !== true) {
      await forceTerminate(child);
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_TIMEOUT_MS)),
      ]);
    }
  }

  function snapshotNotifications() {
    return notifications.map((notification) => ({ ...notification }));
  }

  return { request, notify, waitForNotification, snapshotNotifications, close };
}

async function removeTemporaryDirectory(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/**
 * Windows can leave a native sidecar (or one of its descendants) alive after
 * ChildProcess.kill(). Use taskkill only as a bounded fallback so temporary
 * workspaces are never removed while the process still owns a file handle.
 */
async function forceTerminate(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: PROCESS_EXIT_TIMEOUT_MS,
      });
    } catch {
      // The process may have exited between the initial kill and taskkill.
    }
    return;
  }
  if (!child.killed) child.kill("SIGKILL");
}

async function main() {
  if (process.platform !== "win32" && !process.argv.includes("--binary")) {
    fail("The bundled smoke binary is Windows-only; pass --binary for another target.");
  }
  const binary = binaryArgument();
  const exerciseControl = exercisesControlPath();
  const exerciseErrors = exercisesErrorPath();
  const exerciseApproval = exercisesApprovalPath();
  const exerciseIsolation = exercisesIsolationPath();
  const exerciseCutDuringTurn = exercisesCutDuringTurnPath();
  const exerciseUserShell = exercisesUserShellPath();
  const exerciseUserShellSlow = exercisesUserShellSlowPath();
  const negotiateUserShell = exerciseUserShell || exerciseUserShellSlow;
  const exerciseReconnect = exercisesReconnectPath();
  const exerciseHistory = exercisesHistoryPath();
  const exerciseReasoning = exercisesReasoningPath();
  const exerciseModel = exercisesModelPath();
  const exerciseCompaction = exercisesCompactionPath();
  const exerciseQueue = exercisesQueuePath();
  const exerciseTerminal = exercisesTerminalPath();
  if (exerciseTerminal && !exerciseControl) {
    fail("--exercise-terminal requires --exercise-control");
  }
  const reportPath = reportArgument();
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "muse-native-smoke-a-")),
    mkdtemp(join(tmpdir(), "muse-native-smoke-b-")),
  ]);
  const hosts = roots.map((root, index) =>
    createHost(binary, root, `host-${String.fromCharCode(65 + index)}`),
  );
  try {
    const sessions = [];
    const durabilities = [];
    const controls = [];
    const errors = [];
    const approvalModes = [];
    const userShellChecks = [];
    const userShellSlowChecks = [];
    const reconnectChecks = [];
    const historyChecks = [];
    const reasoningChecks = [];
    const modelChecks = [];
    const compactionChecks = [];
    const queueChecks = [];
    const cutDuringTurnChecks = [];
    let isolation = null;
    for (const [index, host] of hosts.entries()) {
      const initialized = await host.request("initialize", {
        clientInfo: { name: "muse_desktop_native_smoke", version: "0.1.0" },
        ...(negotiateUserShell ? { capabilities: { requestedCapabilities: ["userShell"] } } : {}),
      });
      if (initialized?.serverInfo?.name !== "muse") fail(`host-${index === 0 ? "A" : "B"} returned an unexpected server name`);
      if (initialized?.schema?.version !== 1 || typeof initialized?.schema?.fingerprint !== "string") {
        fail(`host-${index === 0 ? "A" : "B"} returned an incompatible schema`);
      }
      if (negotiateUserShell && !Array.isArray(initialized?.grantedCapabilities)) {
        fail(`host-${index === 0 ? "A" : "B"} returned no capability grant list`);
      }
      if (negotiateUserShell && !initialized.grantedCapabilities.includes("userShell")) {
        fail(`host-${index === 0 ? "A" : "B"} did not grant userShell`);
      }
      const sessionDurability = typeof initialized?.sessionDurability === "string" && initialized.sessionDurability.trim().length > 0
        ? initialized.sessionDurability.trim()
        : "unknown";
      durabilities.push(sessionDurability);
      host.notify("initialized");
      const result = await host.request("session/start", {
        commandId: uuidv7(),
        workspaceRoot: roots[index],
      });
      const session = result?.session;
      const sessionId = session?.sessionId ?? session?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) fail(`host-${index === 0 ? "A" : "B"} did not return a session id`);
      sessions.push(sessionId);
      if (exerciseHistory) {
        let sessionList = "available";
        let sessionCount = 0;
        let sessionListPages = 0;
        let sessionListHasCursor = false;
        try {
          let cursor;
          const seenCursors = new Set();
          for (let page = 0; page < SESSION_LIST_MAX_PAGES; page += 1) {
            const listed = await host.request("session/list", {
              limit: SESSION_LIST_LIMIT,
              ...(cursor === undefined ? {} : { cursor }),
            });
            if (listed === null || typeof listed !== "object") {
              fail(`host-${index === 0 ? "A" : "B"} returned no session list envelope`);
            }
            if (listed.sessions !== undefined && !Array.isArray(listed.sessions)) {
              fail(`host-${index === 0 ? "A" : "B"} returned invalid session list rows`);
            }
            sessionCount += Array.isArray(listed.sessions) ? listed.sessions.length : 0;
            sessionListPages += 1;
            const rawCursor = listed.nextCursor ?? listed.next_cursor;
            if (rawCursor === undefined || rawCursor === null || (typeof rawCursor === "string" && rawCursor.trim().length === 0)) {
              break;
            }
            if (typeof rawCursor !== "string" || rawCursor.trim().length > SESSION_LIST_MAX_CURSOR_CHARS) {
              fail(`host-${index === 0 ? "A" : "B"} returned an invalid session list cursor`);
            }
            const nextCursor = rawCursor.trim();
            if (seenCursors.has(nextCursor)) {
              fail(`host-${index === 0 ? "A" : "B"} returned a repeated session list cursor`);
            }
            seenCursors.add(nextCursor);
            sessionListHasCursor = true;
            cursor = nextCursor;
            if (page + 1 === SESSION_LIST_MAX_PAGES) {
              fail(`host-${index === 0 ? "A" : "B"} exceeded the bounded session list page limit`);
            }
          }
        } catch (error) {
          if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
          sessionList = "unsupported";
        }
        let viewPage = "available";
        let eventCount = 0;
        try {
          const page = await host.request("view/page", {
            sessionId,
            direction: "forward",
            limit: 200,
          });
          if (page === null || typeof page !== "object") {
            fail(`host-${index === 0 ? "A" : "B"} returned no view page envelope`);
          }
          const events = page.events ?? page.items;
          if (events !== undefined && !Array.isArray(events)) {
            fail(`host-${index === 0 ? "A" : "B"} returned invalid view page rows`);
          }
          eventCount = Array.isArray(events) ? events.length : 0;
        } catch (error) {
          if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
          viewPage = "unsupported";
        }
        historyChecks.push({
          host: String.fromCharCode(65 + index),
          sessionList,
          sessionCount,
          sessionListPages,
          sessionListHasCursor,
          viewPage,
          eventCount,
        });
      }
      if (exerciseApproval) {
        const startupMode = session?.approvalMode?.mode;
        if (typeof startupMode !== "string" || startupMode.length === 0) {
          fail(`host-${index === 0 ? "A" : "B"} did not return an effective approval mode`);
        }
        const attempts = [];
        for (const mode of ["onRequest", "promptUnmatched", "allowAll"]) {
          try {
            const changed = await host.request("session/setApprovalMode", {
              commandId: uuidv7(),
              sessionId,
              mode,
            });
            if (changed?.status !== "accepted" || changed?.effectiveMode?.mode !== mode) {
              fail(`host-${index === 0 ? "A" : "B"} returned an incomplete approval mode result for ${mode}`);
            }
            attempts.push({ mode, status: "accepted", effectiveMode: changed.effectiveMode.mode });
          } catch (error) {
            if (error?.code !== -32030 || error?.kind !== "commandRejected" || error?.reason !== "approval_mode_ceiling") {
              fail(`host-${index === 0 ? "A" : "B"} returned an unexpected approval mode error for ${mode}`);
            }
            attempts.push({ mode, status: "rejected", reason: error.reason });
          }
        }
        approvalModes.push({ host: String.fromCharCode(65 + index), startupMode, attempts });
      }
      const catalogue = await host.request("model/list");
      if (catalogue === null || typeof catalogue !== "object") fail(`host-${index === 0 ? "A" : "B"} returned no model catalogue`);
      if (exerciseModel) {
        const models = Array.isArray(catalogue.models)
          ? catalogue.models
          : Array.isArray(catalogue.items)
            ? catalogue.items
            : [];
        const candidate = models.find((model) => {
          const id = model?.modelId ?? model?.model_id ?? model?.id;
          return typeof id === "string" && id.trim().length > 0;
        });
        if (!candidate) {
          modelChecks.push({ host: String.fromCharCode(65 + index), status: "no-model" });
        } else {
          const modelId = String(candidate.modelId ?? candidate.model_id ?? candidate.id).trim();
          try {
            const changed = await host.request("session/setModel", {
              commandId: uuidv7(),
              sessionId,
              model: { modelId },
            });
            if (changed?.status !== "accepted") {
              fail(`host-${index === 0 ? "A" : "B"} returned an incomplete model result for ${modelId}`);
            }
            const refreshed = await host.request("model/list");
            const refreshedModels = Array.isArray(refreshed?.models)
              ? refreshed.models
              : Array.isArray(refreshed?.items)
                ? refreshed.items
                : [];
            const active = refreshedModels.find((model) => {
              const id = model?.modelId ?? model?.model_id ?? model?.id;
              return id === modelId;
            });
            modelChecks.push({
              host: String.fromCharCode(65 + index),
              requested: modelId,
              status: "accepted",
              ...(typeof active?.isActive === "boolean"
                ? { active: active.isActive, projection: "reported" }
                : { active: null, projection: "not-reported" }),
            });
          } catch (error) {
            if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
            modelChecks.push({ host: String.fromCharCode(65 + index), requested: modelId, status: "unsupported" });
          }
        }
      }
      if (exerciseReasoning) {
        const efforts = [];
        for (const reasoningEffort of ["none", "high", "ultra"]) {
          try {
            const changed = await host.request("session/setReasoningEffort", {
              commandId: uuidv7(),
              sessionId,
              reasoningEffort,
            });
            if (changed?.status !== "accepted") {
              fail(`host-${index === 0 ? "A" : "B"} returned an incomplete reasoning effort result for ${reasoningEffort}`);
            }
            const effective = changed?.effectiveReasoningEffort ?? changed?.reasoningEffort;
            efforts.push({
              requested: reasoningEffort,
              status: "accepted",
              ...(typeof effective === "string" && effective.length > 0
                ? { effective }
                : { effective: null, projection: "not-reported" }),
            });
          } catch (error) {
            if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
            efforts.push({ requested: reasoningEffort, status: "unsupported" });
            break;
          }
        }
        reasoningChecks.push({ host: String.fromCharCode(65 + index), efforts });
      }
      if (exerciseCompaction) {
        const hostLabel = String.fromCharCode(65 + index);
        try {
          const compacted = await host.request("session/compact", {
            commandId: uuidv7(),
            sessionId,
          });
          if (compacted === null || typeof compacted !== "object") {
            fail(`host-${hostLabel} returned no compaction envelope`);
          }
          const status = compacted.status;
          if (status !== "accepted" && status !== "noop") {
            fail(`host-${hostLabel} returned an unknown compaction status`);
          }
          compactionChecks.push({ host: hostLabel, status });
        } catch (error) {
          if (error?.code === -32601 && error?.kind === "methodNotFound") {
            compactionChecks.push({ host: hostLabel, status: "unsupported" });
          } else if (error?.code === -32030 && error?.kind === "commandRejected") {
            if (error.reason === "missing_run") {
              compactionChecks.push({ host: hostLabel, status: "missing-run" });
            } else if (error.reason === "run_active") {
              compactionChecks.push({ host: hostLabel, status: "run-active" });
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }
      if (exerciseReconnect) {
        // These are the same point-in-time reads used by the renderer after a
        // reconnect. Keep the result intentionally small: the smoke proves
        // identity and shape, while the transcript itself remains private.
        let sessionRead = "matched";
        let history = "omitted";
        let approvals = 0;
        let userInputs = 0;
        try {
          const read = await host.request("session/read", {
            sessionId,
            excludeItems: false,
          });
          const readSessionId = read?.session?.sessionId ?? read?.session?.id;
          if (readSessionId !== sessionId) {
            fail(`host-${index === 0 ? "A" : "B"} returned a mismatched session from session/read`);
          }
          if (read?.history !== undefined && (typeof read.history !== "object" || read.history === null)) {
            fail(`host-${index === 0 ? "A" : "B"} returned an invalid history envelope`);
          }
          history = read?.history === undefined ? "omitted" : "available";
        } catch (error) {
          if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
          sessionRead = "unsupported";
        }
        try {
          const pending = await host.request("approval/listPending", { sessionId });
          if (pending === null || typeof pending !== "object") {
            fail(`host-${index === 0 ? "A" : "B"} returned an invalid pending snapshot`);
          }
          if (pending.approvals !== undefined && !Array.isArray(pending.approvals)) {
            fail(`host-${index === 0 ? "A" : "B"} returned invalid approvals`);
          }
          if (pending.userInputs !== undefined && !Array.isArray(pending.userInputs)) {
            fail(`host-${index === 0 ? "A" : "B"} returned invalid userInputs`);
          }
          approvals = Array.isArray(pending.approvals) ? pending.approvals.length : 0;
          userInputs = Array.isArray(pending.userInputs) ? pending.userInputs.length : 0;
        } catch (error) {
          if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
          sessionRead = sessionRead === "matched" ? "pending-unsupported" : "unsupported";
        }
        reconnectChecks.push({
          host: String.fromCharCode(65 + index),
          sessionRead,
          history,
          approvals,
          userInputs,
        });
      }
      if (exerciseUserShell) {
        const commandId = uuidv7();
        const shellResult = await host.request("session/userShell", {
          commandId,
          commandText: "echo muse-native-smoke",
          sessionId,
        });
        if (shellResult?.status !== "accepted" || shellResult?.commandId !== commandId) {
          fail(`host-${index === 0 ? "A" : "B"} did not accept the userShell probe`);
        }
        let itemStarted = false;
        try {
          const item = await host.waitForNotification(
            "item/started",
            (params) => params?.sessionId === sessionId && params?.item?.kind === "userShell",
            2_000,
          );
          const itemId = item?.item?.itemId ?? item?.item?.id;
          itemStarted = typeof itemId === "string" && itemId.length > 0;
        } catch {
          // Some compatible hosts acknowledge userShell but do not expose its
          // item stream to this bare connection. Keep that distinction visible
          // instead of treating admission as transcript proof.
        }
        let historyItem = false;
        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const read = await host.request("session/read", { excludeItems: false, sessionId });
          const items = read?.history?.items;
          historyItem = Array.isArray(items) && items.some(
            (item) => item?.kind === "userShell" && item?.commandId === commandId,
          );
        } catch {
          // An ephemeral or older host may not serve inline history here.
        }
        userShellChecks.push({
          host: String.fromCharCode(65 + index),
          status: "accepted",
          itemStarted,
          historyItem,
        });
      }
    }
    if (new Set(sessions).size !== sessions.length) fail("the two native hosts returned the same session id");
    if (exerciseUserShellSlow) {
      // Admit one slow command per host and record whether the host serves
      // its output back. Only session/userShell, item notifications and
      // session/read are used; a missing output stays an explicit boundary.
      for (const [index, host] of hosts.entries()) {
        const hostLabel = String.fromCharCode(65 + index);
        const marker = `SLOW-SHELL-${randomBytes(6).toString("hex").toUpperCase()}`;
        const markerFile = `${marker}.txt`;
        const markerPath = join(tmpdir(), markerFile).replace(/\\/g, "/");
        const slowCommandId = uuidv7();
        const admitted = await host.request("session/userShell", {
          commandId: slowCommandId,
          commandText: `node -e "setTimeout(()=>{console.log('${marker}');require('fs').writeFileSync('${markerPath}','done')},9000)"`,
          sessionId: sessions[index],
        });
        if (admitted?.status !== "accepted" || admitted?.commandId !== slowCommandId) {
          fail(`host-${hostLabel} did not accept the slow userShell probe`);
        }
        const admittedAt = Date.now();
        let itemStarted = false;
        try {
          await host.waitForNotification(
            "item/started",
            (params) => JSON.stringify(params ?? "").includes(slowCommandId),
            8_000,
          );
          itemStarted = true;
        } catch {
          // Some hosts serve shell output without an item stream.
        }
        let sessionRead = "checked";
        let historyFound = false;
        let outputMatched = false;
        let outputExcerpt = null;
        const deadline = Date.now() + 30_000;
        try {
          for (;;) {
            const read = await host.request("session/read", { excludeItems: false, sessionId: sessions[index] });
            const flat = JSON.stringify(read?.history?.items ?? []).slice(0, 200_000);
            if (flat.includes(slowCommandId)) {
              historyFound = true;
              const at = flat.indexOf(marker);
              if (at >= 0) {
                outputMatched = true;
                outputExcerpt = flat.slice(Math.max(0, at - 80), at + marker.length + 80);
              }
              break;
            }
            if (Date.now() > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        } catch (error) {
          if (error?.code !== -32601 || error?.kind !== "methodNotFound") throw error;
          sessionRead = "unsupported";
        }
        const waitForFile = admittedAt + 14_000 - Date.now();
        if (waitForFile > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitForFile));
        }
        let executed = false;
        try {
          await access(join(tmpdir(), markerFile));
          executed = true;
        } catch {
          // No side-effect file appeared: the command may never have run.
        }
        const observedMethods = [...new Set(
          host.snapshotNotifications()
            .filter((notification) => JSON.stringify(notification.params ?? "").includes(slowCommandId))
            .map((notification) => notification.method),
        )].sort();
        userShellSlowChecks.push({
          host: hostLabel,
          commandId: slowCommandId,
          status: "accepted",
          executed,
          itemStarted,
          sessionRead,
          historyFound,
          outputMatched,
          ...(outputExcerpt === null ? {} : { outputExcerpt }),
          observedMethods,
        });
      }
    }
    if (exerciseQueue) {
      for (const [index, host] of hosts.entries()) {
        const hostLabel = String.fromCharCode(65 + index);
        const first = await host.request("turn/start", {
          commandId: uuidv7(),
          sessionId: sessions[index],
          input: [{ type: "text", text: "Native queue smoke probe — first turn." }],
        });
        if (first?.status !== "accepted" || typeof first?.turnId !== "string" || first.turnId.length === 0) {
          fail(`host-${hostLabel} did not accept the first queue probe`);
        }
        let second = null;
        let secondError = null;
        try {
          second = await host.request("turn/start", {
            commandId: uuidv7(),
            sessionId: sessions[index],
            input: [{ type: "text", text: "Native queue smoke probe — second turn." }],
          });
        } catch (error) {
          secondError = error;
        }
        const disposition = typeof second?.disposition === "string"
          ? second.disposition
          : second?.status === "accepted"
            ? "started"
            : null;
        let reclaimed = "not-applicable";
        if (disposition === "queued" && typeof second?.turnId === "string") {
          try {
            const unqueued = await host.request("turn/unqueue", {
              commandId: uuidv7(),
              sessionId: sessions[index],
              turnId: second.turnId,
            });
            if (unqueued?.status !== "accepted" || unqueued?.turnId !== second.turnId) {
              fail(`host-${hostLabel} returned an incomplete queue reclaim result`);
            }
            reclaimed = "accepted";
          } catch (error) {
            if (error?.code === -32601 && error?.kind === "methodNotFound") reclaimed = "unsupported";
            else throw error;
          }
        }
        queueChecks.push({
          host: hostLabel,
          firstTurnId: first.turnId,
          second: secondError === null
            ? { status: second?.status ?? "unknown", disposition, ...(second?.turnId ? { turnId: second.turnId } : {}) }
            : { status: "rejected", reason: secondError.reason ?? secondError.kind ?? "unknown" },
          reclaimed,
        });
        try {
          await host.request("turn/interrupt", {
            commandId: uuidv7(),
            sessionId: sessions[index],
            retract: false,
          });
        } catch {
          // A host may have completed the synthetic turn before cleanup.
        }
      }
    }
    if (exerciseErrors) {
      // These requests never reach a model or touch a workspace. They prove
      // that the host's actionable category survives the child-process
      // transport for both isolated owners.
      for (const [index, host] of hosts.entries()) {
        const label = `host-${String.fromCharCode(65 + index)}`;
        const cases = [
          { method: "native-smoke/unknown", params: {}, code: -32601, kind: "methodNotFound" },
          { method: "turn/interrupt", params: {}, code: -32602, kind: "invalidParams" },
        ];
        for (const testCase of cases) {
          try {
            await host.request(testCase.method, testCase.params);
            fail(`${label} unexpectedly accepted ${testCase.method}`);
          } catch (error) {
            if (error?.code !== testCase.code || error?.kind !== testCase.kind) {
              fail(`${label} returned an unexpected ${testCase.method} error (${error?.code ?? "?"}/${error?.kind ?? "unknown"})`);
            }
            errors.push({ host: String.fromCharCode(65 + index), method: testCase.method, code: error.code, kind: error.kind });
          }
        }
      }
    }
    if (exerciseControl) {
      // This path is deliberately opt-in: admit both real turns in parallel,
      // then interrupt each target independently. It proves the native
      // control contract without waiting for a model response or persisting
      // user content in the default memory-only host.
      const started = await Promise.all(hosts.map((host, index) =>
        host.request("turn/start", {
          commandId: uuidv7(),
          sessionId: sessions[index],
          input: [{ type: "text", text: "Native control smoke probe. Stop immediately." }],
        }),
      ));
      const turnIds = started.map((turn, index) => {
        const turnId = turn?.turnId;
        if (turn?.status !== "accepted" || typeof turnId !== "string" || turnId.length === 0) {
          fail(`host-${index === 0 ? "A" : "B"} did not accept the control probe`);
        }
        return turnId;
      });
      const interrupted = await Promise.all(hosts.map((host, index) =>
        host.request("turn/interrupt", {
          commandId: uuidv7(),
          sessionId: sessions[index],
          // The host requires `turnId` (and `commandId`); without it the request
          // is refused as invalidParams, the turn is never interrupted, and no
          // terminal can arrive. Omitting it made this probe report
          // `terminalNotification: unsupported` for a host that does emit one —
          // see docs/evidence/2026-09-20-windows-sessions/terminal-apres-interruption.md.
          turnId: turnIds[index],
          retract: false,
        }),
      ));
      const terminals = await Promise.all(hosts.map((host, index) =>
        waitForTerminalNotification(host, turnIds[index], `host-${index === 0 ? "A" : "B"}`, exerciseTerminal),
      ));
      interrupted.forEach((result, index) => {
        if (result?.status !== "accepted" || result?.turnId !== turnIds[index]) {
          fail(`host-${index === 0 ? "A" : "B"} did not acknowledge interruption of ${turnIds[index]}`);
        }
        if (terminals[index]?.params?.turnId !== undefined && terminals[index].params.turnId !== turnIds[index]) {
          fail(`host-${index === 0 ? "A" : "B"} emitted a mismatched terminal turn`);
        }
        controls.push({
          host: String.fromCharCode(65 + index),
          turnId: turnIds[index],
          status: "interrupted",
          ...(terminals[index].method === null
            ? { terminalNotification: "unsupported" }
            : { terminalMethod: terminals[index].method }),
        });
      });
    }
    if (exerciseCutDuringTurn) {
      // Admit a real turn on B, then close only B before it can report a
      // terminal event. The surviving host must keep its own route alive.
      const turn = await hosts[1].request("turn/start", {
        commandId: uuidv7(),
        sessionId: sessions[1],
        input: [{ type: "text", text: "Native cut-during-turn smoke probe." }],
      });
      if (turn?.status !== "accepted" || typeof turn?.turnId !== "string" || turn.turnId.length === 0) {
        fail("host-B did not accept the cut-during-turn probe");
      }
      await hosts[1].close();
      const catalogue = await hosts[0].request("model/list");
      if (catalogue === null || typeof catalogue !== "object") {
        fail("host-A stopped answering after host-B was cut during a turn");
      }
      cutDuringTurnChecks.push({
        killedHost: "B",
        turnId: turn.turnId,
        terminalNotification: "not-observed-before-close",
        survivingHost: "A",
        survivingModelCatalogue: "available",
      });
    }
    if (exerciseIsolation) {
      // Kill only B after both hosts have completed their setup. A must keep
      // its own process, session identity and read-only catalogue alive.
      await hosts[1].close();
      const catalogue = await hosts[0].request("model/list");
      if (catalogue === null || typeof catalogue !== "object") {
        fail("host-A stopped answering after host-B exited");
      }
      isolation = {
        failedHost: "B",
        survivingHost: "A",
        survivingModelCatalogue: "available",
      };
    }
    const report = {
      schema: "muse-desktop.native-smoke.v1",
      hosts: sessions.map((sessionId, index) => ({
        host: String.fromCharCode(65 + index),
        sessionId,
        sessionDurability: durabilities[index],
      })),
      distinctWorkspaces: true,
      modelCatalogue: "available",
      turnsSent: exerciseControl ? controls.length : 0,
      ...(exerciseControl ? { controls } : {}),
      ...(exerciseErrors ? { errorsChecked: errors.length, errors } : {}),
      ...(exerciseApproval ? { approvalModes } : {}),
      ...(exerciseIsolation ? { isolation } : {}),
      ...(exerciseUserShell ? { userShell: userShellChecks } : {}),
      ...(exerciseUserShellSlow ? { userShellSlow: userShellSlowChecks } : {}),
      ...(exerciseReconnect ? { reconnect: reconnectChecks } : {}),
      ...(exerciseHistory ? { history: historyChecks } : {}),
      ...(exerciseReasoning ? { reasoningEffort: reasoningChecks } : {}),
      ...(exerciseModel ? { modelSelection: modelChecks } : {}),
      ...(exerciseCompaction ? { compaction: compactionChecks } : {}),
      ...(exerciseQueue ? { queue: queueChecks } : {}),
      ...(exerciseCutDuringTurn ? { cutDuringTurn: cutDuringTurnChecks } : {}),
    };
    if (reportPath !== null) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await Promise.all(roots.map(removeTemporaryDirectory));
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
