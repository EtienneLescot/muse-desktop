/**
 * US-9 automations/scheduled + review queue: pure schedule logic, cron
 * recurrence, due → captured review/run context, approve/discard,
 * target resolution, and persisted round-trips.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approveReview,
  buildSchedule,
  createSchedule,
  cronNextRun,
  cronNextRunInTimeZone,
  deleteSchedule,
  discardReview,
  dueSchedules,
  dueOccurrenceTimes,
  enqueueDue,
  enqueueRunNow,
  isScheduleDue,
  isValidTimeZone,
  loadReviewQueue,
  loadSchedules,
  parseCron,
  pendingReviews,
  resolveReviewTarget,
  scheduleOccurrenceKey,
  saveReviewQueue,
  saveSchedules,
  setScheduleEnabled,
  validateScheduleInput,
  type Schedule,
  type ScheduleInput,
} from "../src/lib/schedules.ts";

function fakeStorage(): void {
  const m = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

function onceInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "standup",
    instructions: "Summarize yesterday's commits.",
    trigger: { kind: "once", at: 2000 },
    threadReuse: { kind: "active" },
    ...overrides,
  };
}

function sched(list: Schedule[], input: ScheduleInput, now = 1000): Schedule[] {
  const next = createSchedule(list, input, now);
  assert.equal(next.length, list.length + 1);
  return next;
}

describe("US-9 schedule validation", () => {
  it("accepts a valid one-shot and a valid cron input", () => {
    assert.equal(validateScheduleInput(onceInput()), null);
    assert.equal(
      validateScheduleInput(
        onceInput({ trigger: { kind: "cron", cron: "*/15 9 * * 1-5" } }),
      ),
      null,
    );
  });

  it("rejects empty name / instructions", () => {
    assert.match(validateScheduleInput(onceInput({ name: "  " })) ?? "", /name/);
    assert.match(
      validateScheduleInput(onceInput({ instructions: "" })) ?? "",
      /instructions/,
    );
  });

  it("rejects a bad cron expression and a non-date one-shot", () => {
    assert.match(
      validateScheduleInput(onceInput({ trigger: { kind: "cron", cron: "not a cron" } })) ?? "",
      /cron/,
    );
    assert.match(
      validateScheduleInput(onceInput({ trigger: { kind: "cron", cron: "* * *" } })) ?? "",
      /cron/,
    );
    assert.match(
      validateScheduleInput(onceInput({ trigger: { kind: "once", at: NaN } })) ?? "",
      /date/,
    );
  });

  it("rejects a session target without a session id", () => {
    assert.match(
      validateScheduleInput(
        onceInput({ threadReuse: { kind: "session", sessionId: "" } }),
      ) ?? "",
      /thread/,
    );
  });
});

describe("US-9 schedule CRUD", () => {
  it("creates an enabled schedule and trims name/instructions", () => {
    const next = createSchedule([], onceInput({ name: "  n  " }), 1000);
    assert.equal(next.length, 1);
    assert.equal(next[0].name, "n");
    assert.equal(next[0].enabled, true);
    assert.equal(next[0].createdAt, 1000);
  });

  it("accepts IANA timezones and rejects unknown identifiers", () => {
    assert.equal(isValidTimeZone("Europe/Paris"), true);
    assert.equal(validateScheduleInput(onceInput({ timeZone: "UTC" })), null);
    assert.match(validateScheduleInput(onceInput({ timeZone: "Mars/Base" })) ?? "", /timezone/);
  });

  it("captures execution context at schedule creation and due time", () => {
    const list = sched([], onceInput({
      workspace: " C:/repo ",
      projectId: " project-1 ",
      model: "gpt-5.6",
      authorizationMode: "yolo",
      timeZone: "Europe/Paris",
    }), 1000);
    assert.equal(list[0].workspace, "C:/repo");
    assert.equal(list[0].projectId, "project-1");
    const due = enqueueDue(list, [], 2000);
    assert.equal(due.added[0].workspace, "C:/repo");
    assert.equal(due.added[0].model, "gpt-5.6");
    assert.equal(due.added[0].authorizationMode, "yolo");
    assert.equal(due.added[0].timeZone, "Europe/Paris");
  });

  it("refuses invalid input without growing the list", () => {
    const bad = createSchedule([], onceInput({ name: "" }), 1000);
    assert.deepEqual(bad, []);
  });

  it("enables/disables one schedule, unknown ids untouched", () => {
    let list = sched([], onceInput());
    list = setScheduleEnabled(list, list[0].id, false);
    assert.equal(list[0].enabled, false);
    const same = setScheduleEnabled(list, "nope", true);
    assert.deepEqual(same, list);
  });

  it("deletes one schedule, unknown ids untouched", () => {
    let list = sched([], onceInput());
    list = sched(list, onceInput({ name: "other" }));
    const id = list[0].id;
    assert.equal(deleteSchedule(list, "nope").length, 2);
    const next = deleteSchedule(list, id);
    assert.equal(next.length, 1);
    assert.equal(next[0].name, "other");
  });
});

describe("US-9 cron", () => {
  it("parses steps, ranges, lists and Sunday-as-7", () => {
    assert.notEqual(parseCron("*/15 9 * * 1-5"), null);
    assert.notEqual(parseCron("0 0 1 1 7"), null);
    assert.equal(parseCron("61 * * * *"), null);
    assert.equal(parseCron("* * *"), null);
  });

  it("computes the next daily 9:00 run", () => {
    // 2026-01-05 is a Monday. From 08:00 local -> same day 09:00.
    const from = new Date(2026, 0, 5, 8, 0, 0).getTime();
    const next = cronNextRun("0 9 * * *", from);
    assert.notEqual(next, null);
    const d = new Date(next as number);
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getDate(), 5);
    // From 10:00 -> next day 09:00.
    const late = new Date(2026, 0, 5, 10, 0, 0).getTime();
    const d2 = new Date(cronNextRun("0 9 * * *", late) as number);
    assert.equal(d2.getDate(), 6);
  });

  it("returns null for invalid expressions", () => {
    assert.equal(cronNextRun("bogus", 1000), null);
  });

  it("resolves recurring wall-clock time in an explicit timezone", () => {
    const from = Date.UTC(2026, 0, 5, 8, 0, 0);
    const next = cronNextRunInTimeZone("0 9 * * *", from, "America/New_York");
    assert.equal(next, Date.UTC(2026, 0, 5, 14, 0, 0));
  });

  it("skips a DST gap and preserves the second fall-back occurrence", () => {
    const spring = cronNextRunInTimeZone("30 2 * * *", Date.UTC(2026, 2, 8, 6), "America/New_York");
    assert.equal(spring, Date.UTC(2026, 2, 9, 6, 30));
    const fall = cronNextRunInTimeZone("30 1 * * *", Date.UTC(2026, 10, 1, 6), "America/New_York");
    assert.equal(fall, Date.UTC(2026, 10, 1, 6, 30));
  });
});

describe("US-9 due → captured review/run context", () => {
  it("a past one-shot is due once, then never again", () => {
    let list = sched([], onceInput(), 1000);
    assert.equal(isScheduleDue(list[0], 2000), true);
    const r1 = enqueueDue(list, [], 2000);
    assert.equal(r1.added.length, 1);
    assert.equal(r1.queue.length, 1);
    assert.equal(r1.queue[0].status, "pending");
    assert.equal(r1.queue[0].instructions, "Summarize yesterday's commits.");
    // Pure enqueue: the caller decides whether the entry waits or dispatches.
    assert.equal(isScheduleDue(r1.schedules[0], 2000), false);
    const r2 = enqueueDue(r1.schedules, r1.queue, 9999);
    assert.equal(r2.added.length, 0);
    assert.equal(r2.queue.length, 1);
  });

  it("a future one-shot is not due early", () => {
    const list = sched([], onceInput(), 1000);
    assert.equal(isScheduleDue(list[0], 1999), false);
    assert.deepEqual(dueSchedules(list, 1999), []);
  });

  it("a disabled schedule is never due", () => {
    let list = sched([], onceInput(), 1000);
    list = setScheduleEnabled(list, list[0].id, false);
    assert.equal(isScheduleDue(list[0], 5000), false);
    const r = enqueueDue(list, [], 5000);
    assert.equal(r.added.length, 0);
  });

  it("a cron schedule enqueues per occurrence, not per tick", () => {
    const at9 = new Date(2026, 0, 5, 8, 0, 0).getTime();
    let list = sched(
      [],
      onceInput({ trigger: { kind: "cron", cron: "0 9 * * *" } }),
      at9,
    );
    const nine = new Date(2026, 0, 5, 9, 0, 0).getTime();
    assert.equal(isScheduleDue(list[0], nine), true);
    const r1 = enqueueDue(list, [], nine);
    assert.equal(r1.added.length, 1);
    // Same tick again: no duplicate.
    const r2 = enqueueDue(r1.schedules, r1.queue, nine + 30_000);
    assert.equal(r2.added.length, 0);
    // Next day 9:00: due again.
    const nextDay = new Date(2026, 0, 6, 9, 0, 0).getTime();
    assert.equal(isScheduleDue(r2.schedules[0], nextDay), true);
  });

  it("uses the latest missed occurrence or skips the backlog explicitly", () => {
    const start = new Date(2026, 0, 5, 8, 0, 0).getTime();
    const wake = new Date(2026, 0, 5, 12, 30, 0).getTime();
    const latest = sched([], onceInput({
      trigger: { kind: "cron", cron: "0 * * * *" },
      missedPolicy: "latest",
    }), start);
    assert.equal(dueOccurrenceTimes(latest[0], wake).length, 4);
    const latestResult = enqueueDue(latest, [], wake);
    assert.equal(latestResult.added.length, 1);
    assert.equal(latestResult.added[0].occurrenceAt, new Date(2026, 0, 5, 12, 0, 0).getTime());
    assert.equal(latestResult.added[0].occurrenceKey, scheduleOccurrenceKey(latest[0].id, latestResult.added[0].occurrenceAt as number));

    const skip = sched([], onceInput({
      trigger: { kind: "cron", cron: "0 * * * *" },
      missedPolicy: "skip",
    }), start);
    const skipResult = enqueueDue(skip, [], wake);
    assert.equal(skipResult.added.length, 0);
    assert.equal(skipResult.schedules[0].lastFiredAt, new Date(2026, 0, 5, 12, 0, 0).getTime());
    const next = enqueueDue(skipResult.schedules, [], new Date(2026, 0, 5, 13, 0, 0).getTime());
    assert.equal(next.added.length, 1);
  });

  it("run-now enqueues even a disabled schedule and advances it", () => {
    let list = sched([], onceInput(), 1000);
    list = setScheduleEnabled(list, list[0].id, false);
    const r = enqueueRunNow(list, [], list[0].id, 1500);
    assert.notEqual(r, null);
    assert.equal((r as { added: { scheduleName: string } }).added.scheduleName, "standup");
    // The past one-shot must not also fire on the next timer tick.
    assert.equal(isScheduleDue((r as { schedules: Schedule[] }).schedules[0], 5000), false);
    assert.equal(enqueueRunNow(list, [], "unknown", 1500), null);
  });
});

describe("US-9 review queue approve/discard", () => {
  it("approves and discards pending entries, settling is final", () => {
    let list = sched([], onceInput(), 1000);
    const r = enqueueDue(list, [], 2000);
    list = r.schedules;
    const id = r.added[0].id;
    assert.equal(pendingReviews(r.queue).length, 1);
    const ok = approveReview(r.queue, id);
    assert.notEqual(ok, null);
    assert.equal((ok as { item: { status: string } }).item.status, "approved");
    assert.deepEqual(pendingReviews((ok as { queue: [] }).queue), []);
    // Already settled: null, queue untouched.
    assert.equal(approveReview((ok as { queue: [] }).queue, id), null);
    assert.equal(discardReview((ok as { queue: [] }).queue, id), null);
    assert.equal(approveReview(r.queue, "unknown"), null);
  });

  it("discards a pending entry", () => {
    const r = enqueueDue(sched([], onceInput(), 1000), [], 2000);
    const done = discardReview(r.queue, r.added[0].id);
    assert.equal((done as { item: { status: string } }).item.status, "discarded");
    assert.deepEqual(pendingReviews((done as { queue: [] }).queue), []);
  });

  it("approve carries the exact instructions for the later sendInput", () => {
    const r = enqueueDue(sched([], onceInput(), 1000), [], 2000);
    const ok = approveReview(r.queue, r.added[0].id);
    assert.equal(
      (ok as { item: { instructions: string } }).item.instructions,
      "Summarize yesterday's commits.",
    );
  });
});

describe("US-9 review target resolution", () => {
  it("resolves active / new / recorded session ids", () => {
    assert.equal(
      resolveReviewTarget({ kind: "active" }, "a", ["a", "b"]),
      "a",
    );
    assert.equal(resolveReviewTarget({ kind: "active" }, null, ["b"]), "b");
    assert.equal(resolveReviewTarget({ kind: "active" }, null, []), "new");
    assert.equal(resolveReviewTarget({ kind: "new" }, "a", ["a"]), "new");
    assert.equal(
      resolveReviewTarget({ kind: "session", sessionId: "b" }, "a", ["a", "b"]),
      "b",
    );
    assert.equal(
      resolveReviewTarget({ kind: "session", sessionId: "gone" }, "a", ["a"]),
      null,
    );
  });
});

describe("US-9 persistence round-trip", () => {
  it("saves and reloads schedules and review entries", () => {
    fakeStorage();
    const list = sched([], onceInput(), 1000);
    saveSchedules(list);
    const back = loadSchedules();
    assert.equal(back.length, 1);
    assert.equal(back[0].name, "standup");
    const r = enqueueDue(list, [], 2000);
    saveReviewQueue(r.queue);
    const qback = loadReviewQueue();
    assert.equal(qback.length, 1);
    assert.equal(qback[0].status, "pending");
  });

  it("drops corrupt entries and starts empty without storage", () => {
    fakeStorage();
    saveSchedules([buildSchedule(onceInput(), 1000)]);
    (globalThis as Record<string, unknown>).localStorage = undefined;
    assert.deepEqual(loadSchedules(), []);
    assert.deepEqual(loadReviewQueue(), []);
  });
});
