import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSchedulerWakeupQueue,
  nextSchedulerWakeAt,
  type SchedulerWakeupStatus,
} from "../src/lib/schedulerWakeup.ts";
import type { Schedule } from "../src/lib/schedules.ts";

function once(id: string, at: number, enabled = true): Schedule {
  return {
    id,
    name: id,
    instructions: "run",
    trigger: { kind: "once", at },
    threadReuse: { kind: "new" },
    enabled,
    createdAt: 1_000,
    timeZone: "UTC",
    missedPolicy: "latest",
    authorizationMode: "ask",
  };
}

describe("scheduler wake-up planning", () => {
  it("selects the earliest enabled future occurrence", () => {
    assert.equal(nextSchedulerWakeAt([once("late", 30_000), once("early", 12_000)], 10_000), 12_000);
  });

  it("ignores disabled schedules and returns null when none remain", () => {
    assert.equal(nextSchedulerWakeAt([once("off", 12_000, false)], 10_000), null);
  });

  it("moves an already-due occurrence to a bounded wake retry", () => {
    assert.equal(nextSchedulerWakeAt([once("due", 9_000)], 10_000), 70_000);
    assert.equal(nextSchedulerWakeAt([once("boundary", 11_001)], 10_000), 11_001);
    assert.equal(nextSchedulerWakeAt([once("near", 10_500)], 10_000), 70_000);
  });

  it("rejects a non-finite scheduler clock without scheduling a wake-up", () => {
    assert.equal(nextSchedulerWakeAt([once("future", 20_000)], Number.NaN), null);
    assert.equal(nextSchedulerWakeAt([once("future", 20_000)], Number.POSITIVE_INFINITY), null);
  });

  it("serializes native updates and coalesces pending changes", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: Array<number | null> = [];
    const status = (wakeAt: number | null): SchedulerWakeupStatus => ({
      schema: "muse-desktop.scheduler-wakeup.v1",
      supported: true,
      installed: wakeAt !== null,
      wakeAt,
      message: "ok",
    });
    const queue = createSchedulerWakeupQueue(async (wakeAt) => {
      calls.push(wakeAt);
      if (calls.length === 1) await firstFinished;
      return status(wakeAt);
    });
    const first = queue(10_000);
    const second = queue(20_000);
    const third = queue(30_000);
    releaseFirst();
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(calls, [10_000, 30_000]);
    assert.equal(results[0].wakeAt, 10_000);
    assert.equal(results[1].wakeAt, 30_000);
    assert.equal(results[2].wakeAt, 30_000);
  });
});
