#!/usr/bin/env node
/** M4-07 evidence: drive the REAL system ssh binary with the canonical argv
 *  (the construction src/lib/remoteSsh.ts held on 30/09) against a local
 *  discard port. A fast, bounded "connection refused" proves the transport
 *  drives the binary correctly — the failure is at the transport level,
 *  never at the argv level. Also measures the real binary path.
 *  The helpers below moved here on 06/10/2026 with the remote exec they
 *  served: the app's argv is now built by remote_ssh.rs alone. */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const SSH_CONNECT_TIMEOUT = 10;
const SSH_OUTPUT_LIMIT = 64 * 1024;
const HOST_CHARS = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;
const PATH_CHARS = /^[A-Za-z0-9 ._\\/:()-]+$/;

function cleanString(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  // Control characters can smuggle argument boundaries on some platforms.
  if (trimmed.length === 0 || trimmed.length > max || /[\0\r\n]/.test(trimmed)) return "";
  return trimmed;
}

/** "" when absent, `null` when present but refused. */
function optionalString(value, max) {
  if (typeof value !== "string" || value.trim() === "") return "";
  return cleanString(value, max) || null;
}

/** One target from untrusted input; `null` for anything argv could not carry. */
function validateSshTarget(input) {
  if (typeof input !== "object" || input === null) return null;
  const id = cleanString(input.id, 40);
  const label = cleanString(input.label, 60);
  const host = cleanString(input.host, 255);
  const user = optionalString(input.user, 64);
  const identityFile = optionalString(input.identityFile, 400);
  if (!id || !label || !host || !HOST_CHARS.test(host) || user === null || identityFile === null) return null;
  // A dash-leading user would make `user@host` an ssh option (`-E…` writes a log file).
  if (user && (!NAME_CHARS.test(user) || user.startsWith("-"))) return null;
  if (identityFile && !PATH_CHARS.test(identityFile)) return null;
  const port = input.port;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { id, label, host, port: port ?? 22, user, identityFile };
}

/** The binary, the validated target, and the command after a literal `--`. */
function buildSshArgv(sshPath, target, command) {
  if (!sshPath || !target || typeof command !== "string") return null;
  const cmd = command.trim();
  if (!cmd || cmd.length > 8_000 || /[\0]/.test(cmd)) return null;
  const argv = [sshPath];
  if (target.port !== 22) argv.push("-p", String(target.port));
  if (target.identityFile) argv.push("-i", target.identityFile);
  // Never prompt, never cache: a non-interactive control run either has the
  // agent's keys or fails bounded.
  argv.push("-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`);
  argv.push(target.user ? `${target.user}@${target.host}` : target.host);
  argv.push("--", cmd);
  return argv;
}

/** The one-line summary of a finished run, bounded like every other status. */
function describeSshResult(exitCode, timedOut, stdout, stderr) {
  if (timedOut) return `ssh did not answer within the timeout; no output kept beyond ${SSH_OUTPUT_LIMIT >> 10} KiB per stream.`;
  const tail = (stdout.trim() || stderr.trim()).split("\n").slice(-1)[0] ?? "";
  const where = exitCode === 0 ? "succeeded" : `exited ${exitCode ?? "?"}`;
  return `ssh ${where}. ${tail.slice(0, 200)}`;
}

const report = {
  schema: "muse-desktop.m4-07-ssh-transport.v1",
  date: new Date().toISOString().slice(0, 10),
  platform: `Windows 11 (26200), OpenSSH ${spawnSync("ssh", ["-V"], { encoding: "utf8" }).stderr?.trim() ?? "?"}`,
};

// 1. the canonical path: validate a real-shaped target, build the argv
const target = validateSshTarget({ id: "ssh-loopback", label: "loopback probe", host: "127.0.0.1", port: 9, user: "probe", identityFile: "" });
report.targetValidated = target !== null;
const argv = buildSshArgv("ssh", target, "echo remote-exec-ok");
report.argv = argv;
report.argvEndsWithSeparator = argv[argv.length - 2] === "--";

// 2. drive the real binary, bounded (timeout, no shell)
const started = Date.now();
const run = spawnSync(argv[0], argv.slice(1), {
  encoding: "utf8",
  timeout: 20_000,
  windowsHide: true,
  maxBuffer: SSH_OUTPUT_LIMIT * 2,
});
const elapsed = Date.now() - started;
report.realBinary = {
  file: spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Command ssh).Source"], { encoding: "utf8" }).stdout?.trim(),
  exitCode: run.status,
  signal: run.signal ?? null,
  elapsedMs: elapsed,
  stderrTail: (run.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300),
};
// A refused connection fails fast and names the transport, not the argv.
report.verdict = {
  binaryDriven: run.status !== null || run.signal !== null,
  fastBoundedFailure: elapsed < 15_000,
  transportLevelRefusal: /connection refused|refus[eé]e|timed out|permission denied/i.test(`${run.stderr}${run.stdout}`),
  argvNeverRejected: !/unknown option|bad usage|Usage:/i.test(`${run.stderr}${run.stdout}`),
};
report.summary = describeSshResult(run.status, run.signal === "SIGTERM", run.stdout ?? "", run.stderr ?? "");

mkdirSync("docs/evidence/2026-09-27-m4-closure", { recursive: true });
writeFileSync("docs/evidence/2026-09-27-m4-closure/m4-07-ssh-transport.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict), "|", report.realBinary.file, "|", report.summary.slice(0, 120));
process.exit(0);
