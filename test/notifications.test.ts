/** M3-09 scheduled-run notifications: durable, deduplicated and readable. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendNotification,
  buildApprovalNotification,
  buildInputNotification,
  buildRunNotification,
  filterNotifications,
  loadNotifications,
  loadNotificationPreferences,
  mergeNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationActionPayload,
  resolveNotificationRoute,
  NOTIFICATION_PREFERENCES_KEY,
  saveNotifications,
  saveNotificationPreferences,
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

  it("filters unread rows newest first without mutating the inbox", () => {
    const older = buildRunNotification(run(), 3000) as MuseNotification;
    const newer = { ...buildInputNotification({ sessionId: "session-1", inputId: "input-1" }, 4000), unread: false };
    const rows = [older, newer];
    assert.deepEqual(filterNotifications(rows, "all").map((item) => item.id), [newer.id, older.id]);
    assert.deepEqual(filterNotifications(rows, "unread").map((item) => item.id), [older.id]);
    assert.deepEqual(rows.map((item) => item.id), [older.id, newer.id]);
  });

  it("marks the entire inbox as read without changing its order", () => {
    const first = buildRunNotification(run(), 3000) as MuseNotification;
    const second = buildInputNotification({ sessionId: "session-1", inputId: "input-1" }, 4000);
    const rows = [first, { ...second, unread: false }];
    const read = markAllNotificationsRead(rows);
    assert.deepEqual(read.map((item) => item.id), rows.map((item) => item.id));
    assert.equal(unreadNotificationCount(read), 0);
    assert.equal(read[1]?.body, second.body);
  });

  it("creates one attention notification per approval or input request", () => {
    const approval = buildApprovalNotification({
      sessionId: "session-1",
      requestId: "approval-1",
      toolName: "bash",
      summary: "List the project files",
    }, 4000);
    const input = buildInputNotification({
      sessionId: "session-1",
      inputId: "input-1",
      toolName: "setup",
      questionCount: 2,
    }, 5000);
    assert.equal(approval.kind, "approval-needed");
    assert.equal(approval.dedupeKey, "approval:session-1:approval-1");
    assert.match(approval.body, /bash/);
    assert.equal(input.kind, "input-needed");
    assert.equal(input.dedupeKey, "input:session-1:input-1");
    assert.match(input.body, /2 questions/);
  });

  it("keeps native action payloads limited to routing ids", () => {
    const notification = buildRunNotification(run(), 3000) as MuseNotification;
    assert.deepEqual(notificationActionPayload(notification), {
      notificationId: notification.id,
      sessionId: "session-1",
      runId: notification.runId,
    });
  });

  it("routes validated clicks to the session first, then the automation inbox", () => {
    assert.deepEqual(
      resolveNotificationRoute(
        { sessionId: "session-1", runId: "run-1" },
        ["session-1"],
        ["run-1"],
      ),
      { kind: "task", sessionId: "session-1" },
    );
    assert.deepEqual(
      resolveNotificationRoute({ sessionId: "missing", runId: "run-1" }, [], ["run-1"]),
      { kind: "automations", runId: "run-1" },
    );
    assert.equal(resolveNotificationRoute({ sessionId: "missing", runId: "unknown" }, [], []), null);
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

  it("merges native and web inbox copies by dedupe key", () => {
    const original = buildRunNotification(run(), 3000) as MuseNotification;
    const newer = { ...original, id: "newer", body: "Updated", createdAt: 4000, unread: false };
    const other = buildInputNotification({ sessionId: "session-1", inputId: "input-1" }, 3500);
    assert.deepEqual(mergeNotifications([original, other], [newer]), [other, newer]);
  });

  it("persists the desktop mute preference defensively", () => {
    fakeStorage();
    assert.deepEqual(loadNotificationPreferences(), { desktopMuted: false });
    saveNotificationPreferences({ desktopMuted: true });
    assert.deepEqual(loadNotificationPreferences(), { desktopMuted: true });
    localStorage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify({ desktopMuted: "yes" }));
    assert.deepEqual(loadNotificationPreferences(), { desktopMuted: false });
  });
});
