/** Durable scheduled-run ledger: bounded transitions and persistence. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendRun,
  archiveRun,
  cancelRun,
  completeRun,
  createScheduleRun,
  isRetryableScheduleError,
  loadScheduleRuns,
  markRunStarted,
  markRunRead,
  restoreRun,
  retryRunNow,
  MAX_RUN_ATTEMPTS,
  queueRunRetry,
  retryDelayMs,
  MAX_SCHEDULE_RUNS,
  saveScheduleRuns,
  settleRun,
  type ScheduleRun,
} from "../src/lib/scheduleRuns.ts";
import {
  releaseSchedulerLease,
  renewSchedulerLease,
  SCHEDULER_LEASE_KEY,
  tryAcquireSchedulerLease,
} from "../src/lib/schedulerLease.ts";

function fakeStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); },
  };
}

function run(now = 1000): ScheduleRun {
  return createScheduleRun({
    scheduleId: "schedule-1",
    scheduleName: "Daily review",
    instructions: "Summarize the latest changes.",
    threadReuse: { kind: "new" },
    workspace: "C:/repo",
    projectId: "project-1",
    model: "gpt-5.6",
    authorizationMode: "yolo",
    occurrenceAt: now,
    occurrenceKey: `schedule-1:${now}`,
  }, now);
}

describe("M3-06 schedule run ledger", () => {
  it("creates a queued run and records running/completed transitions", () => {
    const initial = run();
    assert.equal(initial.status, "queued");
    const started = markRunStarted([initial], initial.id, 2000, "session-1");
    assert.equal(started[0].status, "running");
    assert.equal(started[0].startedAt, 2000);
    assert.equal(started[0].sessionId, "session-1");
    const settled = settleRun(started, initial.id, "completed", 3000);
    assert.equal(settled[0].status, "completed");
    assert.equal(settled[0].finishedAt, 3000);
    assert.equal(settled[0].error, undefined);
  });

  it("records a bounded failure without mutating unrelated runs", () => {
    const first = run();
    const second = run(1100);
    const failed = settleRun([first, second], first.id, "failed", 2200, "workspace mismatch");
    assert.equal(failed[0].status, "failed");
    assert.equal(failed[0].error, "workspace mismatch");
    assert.equal(failed[1].status, "queued");
    assert.deepEqual(markRunStarted(failed, "missing", 2500), failed);
  });

  it("captures a result preview and keeps unread separate from status", () => {
    const initial = run();
    const running = markRunStarted([initial], initial.id, 2000, "session-1");
    const completed = completeRun(running, initial.id, 3000, "  Finished the review.  ");
    assert.equal(completed[0].status, "completed");
    assert.equal(completed[0].resultPreview, "  Finished the review.  ");
    assert.equal(completed[0].unread, true);
    const read = markRunRead(completed, initial.id);
    assert.equal(read[0].unread, false);
  });

  it("queues bounded exponential retries and cancels a pending retry", () => {
    const initial = run();
    const failed = settleRun(markRunStarted([initial], initial.id, 2000), initial.id, "failed", 2100, "host unavailable");
    const retried = queueRunRetry(failed, initial.id, 2200, "host unavailable");
    assert.equal(retried[0].status, "queued");
    assert.equal(retried[0].attempt, 2);
    assert.equal(retried[0].nextRetryAt, 2200 + retryDelayMs(1));
    assert.equal(isRetryableScheduleError("host unavailable"), true);
    assert.equal(isRetryableScheduleError("send_input timed out; outcome ambiguous"), false);
    const cancelled = cancelRun(retried, initial.id, 3000);
    assert.equal(cancelled[0].status, "cancelled");
    assert.equal(cancelled[0].finishedAt, 3000);
    let exhausted: ScheduleRun = { ...initial, status: "failed", attempt: MAX_RUN_ATTEMPTS };
    exhausted = queueRunRetry([exhausted], exhausted.id, 4000)[0];
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.nextRetryAt, undefined);
  });

  it("keeps only the newest capped runs", () => {
    const first = run();
    const many = Array.from({ length: MAX_SCHEDULE_RUNS + 4 }, (_, index) =>
      ({ ...first, id: `run-${index}`, createdAt: index, occurrenceAt: index, occurrenceKey: `schedule-1:${index}` }));
    const capped = appendRun([], many[0]);
    const result = many.slice(1).reduce(appendRun, capped);
    assert.equal(result.length, MAX_SCHEDULE_RUNS);
    assert.equal(result[0].id, "run-4");
    assert.equal(result.at(-1)?.id, `run-${MAX_SCHEDULE_RUNS + 3}`);
    assert.equal(appendRun(result, { ...result[0] }), result);
  });

  it("round-trips valid runs and drops malformed local storage entries", () => {
    fakeStorage();
    const valid = run();
    saveScheduleRuns([valid, { ...valid, id: "run-2", status: "failed", error: "x" }]);
    assert.deepEqual(loadScheduleRuns(), [valid, { ...valid, id: "run-2", status: "failed", error: "x" }]);
    localStorage.setItem("muse-desktop.schedule-runs.v1", JSON.stringify([
      valid,
      { ...valid, id: "bad", threadReuse: { kind: "session", sessionId: "" } },
      { nope: true },
    ]));
    assert.deepEqual(loadScheduleRuns(), [valid]);
  });

  it("archives, restores and promotes a retry without changing its identity", () => {
    const initial = run();
    const archived = archiveRun([initial], initial.id);
    assert.equal(archived[0].archived, true);
    const restored = restoreRun(archived, initial.id);
    assert.equal(restored[0].archived, false);
    const failed = settleRun(markRunStarted([restored[0]], initial.id, 2000), initial.id, "failed", 2100, "workspace unavailable");
    const retried = retryRunNow(failed, initial.id, 2200)[0];
    assert.equal(retried.id, initial.id);
    assert.equal(retried.status, "queued");
    assert.equal(retried.nextRetryAt, 2200);
    assert.equal(retried.finishedAt, undefined);
    const exhausted = retryRunNow([{ ...failed[0], attempt: MAX_RUN_ATTEMPTS }], initial.id, 2300)[0];
    assert.equal(exhausted.status, "failed");
  });
});

describe("M3-07 scheduler lease", () => {
  it("allows one live owner, renews it, and lets another owner recover after expiry", () => {
    fakeStorage();
    assert.equal(tryAcquireSchedulerLease("window-a", 1000), true);
    assert.equal(tryAcquireSchedulerLease("window-b", 1001), false);
    assert.equal(renewSchedulerLease("window-a", 2000), true);
    assert.equal(tryAcquireSchedulerLease("window-b", 32_001), true);
    assert.equal(renewSchedulerLease("window-a", 32_002), false);
    releaseSchedulerLease("window-b");
    assert.equal(localStorage.getItem(SCHEDULER_LEASE_KEY), null);
  });

  it("fails closed for blank owners and malformed stored leases", () => {
    fakeStorage();
    assert.equal(tryAcquireSchedulerLease("", 1000), false);
    localStorage.setItem(SCHEDULER_LEASE_KEY, JSON.stringify({ ownerId: "a", expiresAt: "later" }));
    assert.equal(tryAcquireSchedulerLease("b", 1000), true);
  });
});
