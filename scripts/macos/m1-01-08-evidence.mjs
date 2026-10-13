/**
 * Evidence writer shared by the macOS M1 proofs of group 3
 * (m1-01-04-git-review.mjs, m1-07-files.mjs, m1-08-attachments.mjs): one
 * JSON per ticket in the format of docs/evidence/2026-10-05-roadmap-closure,
 * with the machine, the build, the exact engine and the isolation read at
 * run time, paths redacted.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactor } from "../cdp-harness.mjs";
import { DEFAULT_ENGINE } from "./test-instance.mjs";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function platform() {
  const sw = (key) => execFileSync("sw_vers", [`-${key}`], { encoding: "utf8" }).trim();
  return `${sw("productName")} ${sw("productVersion")} (${sw("buildVersion")}), ${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()}, Apple Silicon; debug build with the embedded frontend, isolated test mode (ADR 0003, macOS amendment), WKWebView driven through the test bridge (src-tauri/src/test_bridge.rs)`;
}

/**
 * Writes `<dir>/<file>` for each ticket entry and returns the redacted docs.
 * entries: [{ file, ticket, method, windowsReference, checks, verdicts, limits }]
 */
export function writeEvidence({ dir, exe, base, record, harness, entries, commit = "08b291d" }) {
  const redact = redactor([[realpathSync(base), "<tmp>"], [base, "<tmp>"], [homedir(), "~"]]);
  const common = {
    date: record.date,
    commit,
    build: { exe: exe.replace(homedir(), "~"), exeSha256: sha256(exe) },
    platform: platform(),
    engine: record.engine,
    engineBinary: DEFAULT_ENGINE.replace(homedir(), "~"),
    engineSha256: sha256(DEFAULT_ENGINE),
    liveTurns: record.liveTurns,
    harness,
    isolation: { ...record.isolation, stop: record.stop, consoleErrors: record.consoleErrors, processesDuringRun: record.processes ?? null },
  };
  const docs = [];
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const doc = redact({
      schema: "muse-desktop.macos-ticket-proof.v1",
      ticket: entry.ticket,
      ...common,
      method: entry.method,
      windowsReference: entry.windowsReference,
      checks: entry.checks,
      verdicts: entry.verdicts,
      limits: entry.limits,
      ...(entry.previousRun ? { previousRun: entry.previousRun } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    });
    writeFileSync(join(dir, entry.file), `${JSON.stringify(doc, null, 2)}\n`);
    docs.push(doc);
  }
  return docs;
}
