/** M3-09 scheduled-run notifications: durable, deduplicated and readable. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendNotification,
  buildRunNotification,
  loadNotifications,
  markNotificationRead,
  saveNotifications,
  unreadNotificationCount,
  type MuseNotification,
} from "../src/lib/notifications.ts";
import { createScheduleRun, settleRun, type ScheduleRun } from "../src/lib/scheduleRuns.ts";

function fakeStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
  };
}

function run(status: ScheduleRun["status"] = "completed"): ScheduleRun {
  const created = createScheduleRun({
    scheduleId: "schedule-1",
    scheduleName: "Daily review",
    instructions: "Summarize the latest changes.",
    threadReuse: { kind: "new" },
    sessionId: "session-1",
    occurrenceAt: 1000,
    occurrenceKey: "schedule-1:1000",
  }, 1000);
  return settleRun([created], created.id, status, 2000, status === "failed" ? "host unavailable" : undefined)[0];
}

describe("M3-09 notification records", () => {
  it("builds a completion or failure notification with a stable dedupe key", () => {
    const completed = run("completed");
    const notification = buildRunNotification(completed, 3000);
    assert.ok(notification);
    assert.equal(notification?.kind, "run-completed");
    assert.equal(notification?.sessionId, "session-1");
    assert.equal(notification?.dedupeKey, `${completed.id}:run-completed:2000`);
    assert.equal(buildRunNotification({ ...completed, status: "running" }), null);
  });

  it("deduplicates records and keeps unread count independent from runs", () => {
    const notification = buildRunNotification(run(), 3000) as MuseNotification;
    const same = { ...notification, id: "another-id" };
    const appended = appendNotification(appendNotification([], notification), same);
    assert.equal(appended.length, 1);
    assert.equal(unreadNotificationCount(appended), 1);
    const read = markNotificationRead(appended, notification.id);
    assert.equal(unreadNotificationCount(read), 0);
  });

  it("round-trips valid records and drops malformed local storage entries", () => {
    fakeStorage();
    const notification = buildRunNotification(run("failed"), 3000) as MuseNotification;
    saveNotifications([notification]);
    assert.deepEqual(loadNotifications(), [notification]);
    localStorage.setItem("muse-desktop.notifications.v1", JSON.stringify([
      notification,
      { ...notification, id: "bad", kind: "other" },
      { nope: true },
    ]));
    assert.deepEqual(loadNotifications(), [notification]);
  });
});
