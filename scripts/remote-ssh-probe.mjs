#!/usr/bin/env node
/** M4-07 evidence: drive the REAL system ssh binary with the canonical argv
 *  (the exact construction remote_ssh.rs / remoteSsh.ts build) against a
 *  local discard port. A fast, bounded "connection refused" proves the
 *  transport drives the binary correctly — the failure is at the transport
 *  level, never at the argv level. Also measures the real binary path. */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildSshArgv, validateSshTarget, describeSshResult, SSH_OUTPUT_LIMIT } from "../src/lib/remoteSsh.ts";

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

// 2. drive the real binary, bounded like remote_ssh_exec (timeout, no shell)
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
