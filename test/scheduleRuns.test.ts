/** Durable scheduled-run ledger: bounded transitions and persistence. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendRun,
  createScheduleRun,
  loadScheduleRuns,
  markRunStarted,
  MAX_SCHEDULE_RUNS,
  saveScheduleRuns,
  settleRun,
  type ScheduleRun,
} from "../src/lib/scheduleRuns.ts";

function fakeStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
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

  it("keeps only the newest capped runs", () => {
    const first = run();
    const many = Array.from({ length: MAX_SCHEDULE_RUNS + 4 }, (_, index) =>
      ({ ...first, id: `run-${index}`, createdAt: index }));
    const capped = appendRun([], many[0]);
    const result = many.slice(1).reduce(appendRun, capped);
    assert.equal(result.length, MAX_SCHEDULE_RUNS);
    assert.equal(result[0].id, "run-4");
    assert.equal(result.at(-1)?.id, `run-${MAX_SCHEDULE_RUNS + 3}`);
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
});
