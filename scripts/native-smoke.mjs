#!/usr/bin/env node
/**
 * Small, opt-in native MSP smoke test for the Windows sidecar.
 *
 * By default this stops before a model turn: it proves that two real
 * `muse serve` processes can handshake, own independent workspaces, create a
 * session and answer a read-only model catalogue request. The explicit
 * `--exercise-control` path admits and immediately interrupts one turn per
 * host to validate the native cancellation contract. It is a diagnostic
 * harness, not a substitute for the full Tauri E2E scenario in M0-01c.
 *
 * Usage:
 *   node scripts/native-smoke.mjs
 *   node scripts/native-smoke.mjs --binary C:\\path\\to\\muse.exe
 *   node scripts/native-smoke.mjs --exercise-control
 */
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 15_000;
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
      if (frame.id !== undefined) {
        const request = pending.get(String(frame.id));
        if (!request) continue;
        pending.delete(String(frame.id));
        clearTimeout(request.timer);
        if (frame.error) request.reject(new Error(`${request.method} failed: ${frame.error.message || "MSP request failed"}`));
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
    resolveExit();
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

  async function close() {
    if (!closed) {
      closed = true;
      closePending(new Error(`${label} closed`));
      child.kill();
    }
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  return { request, notify, close };
}

async function removeTemporaryDirectory(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function main() {
  if (process.platform !== "win32" && !process.argv.includes("--binary")) {
    fail("The bundled smoke binary is Windows-only; pass --binary for another target.");
  }
  const binary = binaryArgument();
  const exerciseControl = exercisesControlPath();
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "muse-native-smoke-a-")),
    mkdtemp(join(tmpdir(), "muse-native-smoke-b-")),
  ]);
  const hosts = roots.map((root, index) =>
    createHost(binary, root, `host-${String.fromCharCode(65 + index)}`),
  );
  try {
    const sessions = [];
    const controls = [];
    for (const [index, host] of hosts.entries()) {
      const initialized = await host.request("initialize", {
        clientInfo: { name: "muse_desktop_native_smoke", version: "0.1.0" },
      });
      if (initialized?.serverInfo?.name !== "muse") fail(`host-${index === 0 ? "A" : "B"} returned an unexpected server name`);
      if (initialized?.schema?.version !== 1 || typeof initialized?.schema?.fingerprint !== "string") {
        fail(`host-${index === 0 ? "A" : "B"} returned an incompatible schema`);
      }
      host.notify("initialized");
      const result = await host.request("session/start", {
        commandId: uuidv7(),
        workspaceRoot: roots[index],
      });
      const session = result?.session;
      const sessionId = session?.sessionId ?? session?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) fail(`host-${index === 0 ? "A" : "B"} did not return a session id`);
      sessions.push(sessionId);
      const catalogue = await host.request("model/list");
      if (catalogue === null || typeof catalogue !== "object") fail(`host-${index === 0 ? "A" : "B"} returned no model catalogue`);
      if (exerciseControl) {
        // This path is deliberately opt-in: it admits a real turn and
        // interrupts it immediately, proving the native control contract
        // without waiting for a model response or persisting user content.
        const turn = await host.request("turn/start", {
          commandId: uuidv7(),
          sessionId,
          input: [{ type: "text", text: "Native control smoke probe. Stop immediately." }],
        });
        const turnId = turn?.turnId;
        if (turn?.status !== "accepted" || typeof turnId !== "string" || turnId.length === 0) {
          fail(`host-${index === 0 ? "A" : "B"} did not accept the control probe`);
        }
        const interrupted = await host.request("turn/interrupt", {
          commandId: uuidv7(),
          sessionId,
          retract: false,
        });
        if (interrupted?.status !== "accepted" || interrupted?.turnId !== turnId) {
          fail(`host-${index === 0 ? "A" : "B"} did not acknowledge interruption of ${turnId}`);
        }
        controls.push({ host: String.fromCharCode(65 + index), turnId, status: "interrupted" });
      }
    }
    if (new Set(sessions).size !== sessions.length) fail("the two native hosts returned the same session id");
    process.stdout.write(`${JSON.stringify({
      schema: "muse-desktop.native-smoke.v1",
      hosts: sessions.map((sessionId, index) => ({ host: String.fromCharCode(65 + index), sessionId })),
      distinctWorkspaces: true,
      modelCatalogue: "available",
      turnsSent: exerciseControl ? controls.length : 0,
      ...(exerciseControl ? { controls } : {}),
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
