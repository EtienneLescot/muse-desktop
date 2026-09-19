import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRetentionDays,
  retentionDecision,
  MAX_RETENTION_DAYS,
} from "../src/lib/worktreeRetention.ts";
import type { WorktreeInspection, WorktreeRecord } from "../src/lib/worktrees.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function record(createdAt: number): WorktreeRecord {
  return {
    repoRoot: "C:\\repo",
    path: "C:\\repo\\.muse\\worktrees\\feature",
    branch: "feature",
    base: "main",
    createdAt,
  };
}

function cleanInspection(overrides: Partial<WorktreeInspection> = {}): WorktreeInspection {
  return {
    repoRoot: "C:\\repo",
    path: "C:\\repo\\.muse\\worktrees\\feature",
    branch: "feature",
    head: "abc123",
    clean: true,
    conflicted: false,
    fileCount: 3,
    observedAt: NOW,
    ...overrides,
  };
}

test("retentionDecision keeps everything when automatic retention is off", () => {
  const decision = retentionDecision(
    record(NOW - 365 * DAY),
    cleanInspection(),
    { maxAgeDays: null },
    NOW,
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.ageDays, null);
});

test("retentionDecision protects worktrees without an inspection", () => {
  const decision = retentionDecision(
    record(NOW - 365 * DAY),
    undefined,
    { maxAgeDays: 30 },
    NOW,
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /inspect/i);
});

test("retentionDecision protects dirty or conflicted checkouts", () => {
  for (const inspection of [
    cleanInspection({ clean: false }),
    cleanInspection({ conflicted: true }),
  ]) {
    const decision = retentionDecision(
      record(NOW - 365 * DAY),
      inspection,
      { maxAgeDays: 30 },
      NOW,
    );
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, /protected/i);
  }
});

test("retentionDecision protects active operations, shared branches, and attached sessions", () => {
  const cases: Array<[string, WorktreeInspection]> = [
    ["active signals", cleanInspection({ activeSignals: ["MERGE_HEAD"] })],
    ["branch elsewhere", cleanInspection({ branchReferencedElsewhere: true })],
    ["one session", cleanInspection({ attachedSessionCount: 1 })],
    ["many sessions", cleanInspection({ attachedSessionCount: 3 })],
  ];
  for (const [name, inspection] of cases) {
    const decision = retentionDecision(
      record(NOW - 365 * DAY),
      inspection,
      { maxAgeDays: 30 },
      NOW,
    );
    assert.equal(decision.eligible, false, name);
    assert.match(decision.reason, /protected/i, name);
  }
  const single = retentionDecision(
    record(NOW - 365 * DAY),
    cleanInspection({ attachedSessionCount: 1 }),
    { maxAgeDays: 30 },
    NOW,
  );
  assert.match(single.reason, /1 Muse conversation is still attached/);
});

test("retentionDecision retains young clean checkouts and reports remaining days", () => {
  const decision = retentionDecision(
    record(NOW - 10 * DAY),
    cleanInspection(),
    { maxAgeDays: 30 },
    NOW,
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.ageDays, 10);
  assert.match(decision.reason, /20 more day/);
});

test("retentionDecision marks old clean checkouts eligible without deleting", () => {
  const decision = retentionDecision(
    record(NOW - 45 * DAY - 12 * 3_600_000),
    cleanInspection(),
    { maxAgeDays: 30 },
    NOW,
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.ageDays, 45);
  assert.match(decision.reason, /requires confirmation/);
});

test("retentionDecision clamps future timestamps to zero days", () => {
  const decision = retentionDecision(
    record(NOW + DAY),
    cleanInspection(),
    { maxAgeDays: 30 },
    NOW,
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.ageDays, 0);
});

test("normalizeRetentionDays accepts bounded integers and rejects everything else", () => {
  assert.equal(normalizeRetentionDays(null), null);
  assert.equal(normalizeRetentionDays(undefined), null);
  assert.equal(normalizeRetentionDays(""), null);
  assert.equal(normalizeRetentionDays(30), 30);
  assert.equal(normalizeRetentionDays("30"), 30);
  assert.equal(normalizeRetentionDays(MAX_RETENTION_DAYS), MAX_RETENTION_DAYS);
  assert.equal(normalizeRetentionDays(0), null);
  assert.equal(normalizeRetentionDays(-5), null);
  assert.equal(normalizeRetentionDays(2.5), null);
  assert.equal(normalizeRetentionDays("soon"), null);
  assert.equal(normalizeRetentionDays(Number.NaN), null);
  assert.equal(normalizeRetentionDays(MAX_RETENTION_DAYS + 1), null);
});
