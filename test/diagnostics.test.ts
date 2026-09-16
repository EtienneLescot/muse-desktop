import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiagnosticsSnapshot, diagnosticsJson, redactDiagnostic } from "../src/lib/diagnostics.ts";

const input = {
  workspace: "C:/private/project",
  sessionCount: 2,
  runningSessionCount: 1,
  connectedSessionCount: 1,
  pendingApprovalCount: 1,
  pendingInputCount: 0,
  pendingSendCount: 1,
  scheduleCount: 3,
  scheduleRunCount: 4,
  eventCount: 12,
  backendMissing: false,
  error: "Bearer abc123 token=secret-value",
};

describe("M0-07 diagnostics", () => {
  it("exports bounded counts without workspace or conversation text", () => {
    const snapshot = buildDiagnosticsSnapshot(input, new Date("2026-09-16T12:00:00.000Z"), "Win32", "Muse test");
    assert.equal(snapshot.schema, "muse-desktop.diagnostics.v1");
    assert.equal(snapshot.workspaceConfigured, true);
    assert.equal(snapshot.backend, "local");
    assert.equal(snapshot.counts.sessionCount, 2);
    assert.equal(snapshot.lastError, "Bearer [redacted] token=[redacted]");
    assert.equal(JSON.stringify(snapshot).includes("C:/private/project"), false);
  });

  it("fails closed on invalid counts and bounds secrets/error text", () => {
    const snapshot = buildDiagnosticsSnapshot({ ...input, sessionCount: -4, eventCount: Number.NaN, backendMissing: true }, new Date("2026-09-16T12:00:00.000Z"));
    assert.equal(snapshot.counts.sessionCount, 0);
    assert.equal(snapshot.counts.eventCount, 0);
    assert.equal(snapshot.backend, "web-preview");
    assert.equal(redactDiagnostic("password: 'hidden'"), "password: [redacted]");
    assert.ok((diagnosticsJson(input).match(/\n/g) ?? []).length > 3);
  });
});
