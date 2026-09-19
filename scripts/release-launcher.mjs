#!/usr/bin/env node

/**
 * Coordinate a local release swap around the running Muse process.
 *
 * The release transaction verifies and promotes the side-by-side slots. This
 * small launcher owns the lifecycle boundary that cannot be performed while
 * the desktop executable is still open: request a graceful exit, wait for the
 * PID to disappear, apply the staged release, then start the installed app
 * again. No command is passed through a shell and a failed start restores the
 * previous slot whenever the swap already completed.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { resolve, isAbsolute, win32 as windowsPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  applyStagedRelease,
  rollbackRelease,
} from "./release-update.mjs";

export const RELEASE_LAUNCH_SCHEMA = "muse-desktop.release-launch.v1";
export const RELEASE_INSTALLER_SCHEMA = "muse-desktop.release-installer.v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;

function positiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function checkedPid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  if (pid === process.pid) throw new Error("refusing to stop the release launcher itself");
  return pid;
}

function checkedExecutable(value, platform = process.platform) {
  const pathApi = platform === "win32" ? windowsPath : { resolve, isAbsolute };
  const path = pathApi.resolve(String(value ?? ""));
  if (!pathApi.isAbsolute(path)) throw new Error("executable must be an absolute path");
  return path;
}

async function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

async function defaultRequestStop(pid) {
  try {
    // SIGTERM is the portable graceful termination request. On Windows Node
    // maps it to TerminateProcess; the bounded wait below still prevents a
    // release swap while the process remains present.
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Wait until a process disappears, without ever force-killing it. */
export async function waitForProcessExit(
  pid,
  { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, isAlive = defaultIsAlive } = {},
) {
  const checked = checkedPid(pid);
  const timeout = positiveInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const poll = positiveInteger(pollMs, "pollMs", DEFAULT_POLL_MS);
  const deadline = Date.now() + timeout;
  while (await isAlive(checked)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`process ${checked} did not exit within ${timeout} ms`);
    await sleep(Math.min(poll, remaining));
  }
  return { pid: checked, exited: true };
}

/** Ask the running app to exit, then wait for the OS process to be gone. */
export async function stopAndWaitForProcess(
  pid,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    isAlive = defaultIsAlive,
    requestStop = defaultRequestStop,
  } = {},
) {
  const checked = checkedPid(pid);
  if (!(await isAlive(checked))) return { pid: checked, alreadyExited: true };
  await requestStop(checked);
  await waitForProcessExit(checked, { timeoutMs, pollMs, isAlive });
  return { pid: checked, alreadyExited: false };
}

/** Start the installed executable detached from the updater process. */
export async function launchInstalledApp(
  { executable, args = [], cwd, spawnProcess = spawn } = {},
) {
  const file = checkedExecutable(executable);
  await access(file, constants.X_OK).catch(() => {
    throw new Error(`installed executable is not accessible: ${file}`);
  });
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("launch args must be an array of strings");
  }
  const child = spawnProcess(file, args, {
    cwd: cwd ? resolve(cwd) : undefined,
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  if (typeof child?.unref === "function") child.unref();
  return { executable: file, pid: Number.isSafeInteger(child?.pid) ? child.pid : null };
}

/**
 * Build the platform installer invocation without passing a command through a
 * shell. NSIS executables receive their explicit arguments directly; MSI is
 * handed to Windows Installer through `msiexec /i`.
 */
export function buildInstallerInvocation(installerPath, args = [], platform = process.platform) {
  const file = checkedExecutable(installerPath, platform);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("installer args must be an array of strings");
  }
  const extension = file.toLowerCase().slice(file.lastIndexOf("."));
  if (extension === ".msi") {
    if (platform !== "win32") throw new Error("MSI installers require Windows");
    return { executable: "msiexec.exe", args: ["/i", file, ...args] };
  }
  if (extension === ".exe") return { executable: file, args: [...args] };
  throw new Error("installer must be an NSIS .exe or Windows .msi file");
}

/** Start an installer handoff after the running app has exited. */
export async function launchInstaller(
  { installerPath, args = [], spawnProcess = spawn, platform = process.platform } = {},
) {
  const invocation = buildInstallerInvocation(installerPath, args, platform);
  if (platform === "win32" && invocation.executable !== "msiexec.exe") {
    await access(installerPath, constants.X_OK).catch(() => {
      throw new Error(`installer is not accessible: ${installerPath}`);
    });
  } else if (invocation.executable !== "msiexec.exe") {
    await access(invocation.executable, constants.X_OK).catch(() => {
      throw new Error(`installer is not accessible: ${installerPath}`);
    });
  }
  const child = spawnProcess(invocation.executable, invocation.args, {
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  if (typeof child?.unref === "function") child.unref();
  return {
    installerPath: platform === "win32" ? windowsPath.resolve(installerPath) : resolve(installerPath),
    executable: invocation.executable,
    args: invocation.args,
    pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
  };
}

/** Stop Muse, then hand control to a verified Windows installer. */
export async function runInstallerHandoff({
  pid,
  installerPath,
  args = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  isAlive = defaultIsAlive,
  requestStop = defaultRequestStop,
  launch = launchInstaller,
} = {}) {
  if (typeof installerPath !== "string" || installerPath.trim().length === 0) {
    throw new Error("installerPath is required");
  }
  const stop = pid === undefined || pid === null
    ? { pid: null, alreadyExited: true }
    : await stopAndWaitForProcess(pid, { timeoutMs, pollMs, isAlive, requestStop });
  const launched = await launch({ installerPath, args });
  return {
    schema: RELEASE_INSTALLER_SCHEMA,
    stopped: stop,
    installer: launched,
  };
}

/**
 * Stop, swap and restart a release. The caller must explicitly permit a
 * stopped app with `pid: undefined` when it is running this out of band.
 */
export async function runReleaseLauncher({
  pid,
  stagedPath,
  slotsRoot,
  executable,
  args = [],
  cwd,
  publicKey,
  requireSignature = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  isAlive = defaultIsAlive,
  requestStop = defaultRequestStop,
  apply = applyStagedRelease,
  rollback = rollbackRelease,
  launch = launchInstalledApp,
} = {}) {
  if (typeof stagedPath !== "string" || stagedPath.trim().length === 0) {
    throw new Error("stagedPath is required");
  }
  if (typeof slotsRoot !== "string" || slotsRoot.trim().length === 0) {
    throw new Error("slotsRoot is required");
  }
  const stop = pid === undefined || pid === null
    ? { pid: null, alreadyExited: true }
    : await stopAndWaitForProcess(pid, { timeoutMs, pollMs, isAlive, requestStop });
  let applied = false;
  let result;
  try {
    result = await apply({ stagedPath, slotsRoot, publicKey, requireSignature });
    applied = true;
    const launched = await launch({ executable, args, cwd });
    return {
      schema: RELEASE_LAUNCH_SCHEMA,
      stopped: stop,
      release: result,
      launched,
      rollback: null,
    };
  } catch (error) {
    if (applied) {
      try {
        await rollback({ slotsRoot, publicKey, requireSignature });
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${message}`);
      }
    }
    throw error;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(name) {
  const value = argument(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function repeatedArgument(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

async function cli() {
  const command = process.argv[2];
  if (command === "installer") {
    const pid = argument("--pid");
    if (pid === undefined && !process.argv.includes("--allow-stopped")) {
      throw new Error("--pid is required unless --allow-stopped is provided");
    }
    const result = await runInstallerHandoff({
      pid: pid === undefined ? undefined : checkedPid(pid),
      installerPath: requireArgument("--installer"),
      args: repeatedArgument("--arg"),
      timeoutMs: argument("--timeout-ms"),
      pollMs: argument("--poll-ms"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command !== "run") {
    throw new Error("usage: release-launcher.mjs run --staged DIR --slots-root DIR --executable FILE [--pid PID] [--arg VALUE] … | installer --installer FILE [--pid PID]");
  }
  const pid = argument("--pid");
  if (pid === undefined && !process.argv.includes("--allow-stopped")) {
    throw new Error("--pid is required unless --allow-stopped is provided");
  }
  const publicKeyPath = argument("--public-key");
  const publicKey = publicKeyPath
    ? await import("node:fs/promises").then(({ readFile }) => readFile(publicKeyPath, "utf8"))
    : undefined;
  const result = await runReleaseLauncher({
    pid: pid === undefined ? undefined : checkedPid(pid),
    stagedPath: requireArgument("--staged"),
    slotsRoot: requireArgument("--slots-root"),
    executable: requireArgument("--executable"),
    args: repeatedArgument("--arg"),
    cwd: argument("--cwd"),
    publicKey,
    requireSignature: process.argv.includes("--require-signature"),
    timeoutMs: argument("--timeout-ms"),
    pollMs: argument("--poll-ms"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
