import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSchedules } from "../src/lib/scheduleLedger.ts";
import type { Schedule } from "../src/lib/schedules.ts";

function schedule(id: string, patch: Partial<Schedule> = {}): Schedule {
  return {
    id,
    name: id,
    instructions: "run",
    trigger: { kind: "once", at: 100 },
    threadReuse: { kind: "new" },
    enabled: true,
    createdAt: 100,
    ...patch,
  };
}

describe("native schedule ledger merge", () => {
  it("adds schedules found only in the native mirror", () => {
    const merged = mergeSchedules([schedule("local")], [schedule("native")]);
    assert.deepEqual(merged.map((item) => item.id), ["local", "native"]);
  });

  it("uses a native schedule only when its occurrence cursor is newer", () => {
    const local = schedule("one", { enabled: false, lastFiredAt: 100 });
    const native = schedule("one", { enabled: true, lastFiredAt: 200 });
    assert.equal(mergeSchedules([local], [native])[0]?.enabled, true);
    const older = schedule("one", { enabled: true, lastFiredAt: 50 });
    assert.equal(mergeSchedules([local], [older])[0]?.enabled, false);
  });

  it("drops malformed native rows through the shared schedule validator", () => {
    const merged = mergeSchedules([schedule("local")], [{ id: "broken" } as Schedule]);
    assert.deepEqual(merged.map((item) => item.id), ["local"]);
  });
});
