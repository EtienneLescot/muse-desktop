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
 * The explicit `--exercise-user-shell` path negotiates the `userShell`
 * capability, admits a harmless command in each workspace and observes the
 * corresponding shell item without sending a model turn.
 *
 * Usage:
 *   node scripts/native-smoke.mjs
 *   node scripts/native-smoke.mjs --binary C:\\path\\to\\muse.exe
 *   node scripts/native-smoke.mjs --exercise-control
 *   node scripts/native-smoke.mjs --exercise-errors
 *   node scripts/native-smoke.mjs --exercise-approval
 *   node scripts/native-smoke.mjs --exercise-isolation
 *   node scripts/native-smoke.mjs --exercise-user-shell
 */
import { mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
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

function exercisesUserShellPath() {
  return process.argv.includes("--exercise-user-shell");
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

  return { request, notify, waitForNotification, close };
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
  const exerciseUserShell = exercisesUserShellPath();
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
    let isolation = null;
    for (const [index, host] of hosts.entries()) {
      const initialized = await host.request("initialize", {
        clientInfo: { name: "muse_desktop_native_smoke", version: "0.1.0" },
        ...(exerciseUserShell ? { capabilities: { requestedCapabilities: ["userShell"] } } : {}),
      });
      if (initialized?.serverInfo?.name !== "muse") fail(`host-${index === 0 ? "A" : "B"} returned an unexpected server name`);
      if (initialized?.schema?.version !== 1 || typeof initialized?.schema?.fingerprint !== "string") {
        fail(`host-${index === 0 ? "A" : "B"} returned an incompatible schema`);
      }
      if (exerciseUserShell && !Array.isArray(initialized?.grantedCapabilities)) {
        fail(`host-${index === 0 ? "A" : "B"} returned no capability grant list`);
      }
      if (exerciseUserShell && !initialized.grantedCapabilities.includes("userShell")) {
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
          retract: false,
        }),
      ));
      interrupted.forEach((result, index) => {
        if (result?.status !== "accepted" || result?.turnId !== turnIds[index]) {
          fail(`host-${index === 0 ? "A" : "B"} did not acknowledge interruption of ${turnIds[index]}`);
        }
        controls.push({ host: String.fromCharCode(65 + index), turnId: turnIds[index], status: "interrupted" });
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
    process.stdout.write(`${JSON.stringify({
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
    })}\n`);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await Promise.all(roots.map(removeTemporaryDirectory));
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
