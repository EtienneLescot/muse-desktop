import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextSchedulerWakeAt } from "../src/lib/schedulerWakeup.ts";
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
  });
});
