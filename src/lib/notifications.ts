import type { ScheduleRun } from "./scheduleRuns";

export type MuseNotificationKind = "run-completed" | "run-failed";

export interface MuseNotification {
  id: string;
  kind: MuseNotificationKind;
  dedupeKey: string;
  title: string;
  body: string;
  createdAt: number;
  runId?: string;
  sessionId?: string;
  unread?: boolean;
}

export const NOTIFICATIONS_KEY = "muse-desktop.notifications.v1";
export const MAX_NOTIFICATIONS = 200;

function makeId(): string {
  return `notification-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function buildRunNotification(run: ScheduleRun, now = run.finishedAt ?? Date.now()): MuseNotification | null {
  if (run.status !== "completed" && run.status !== "failed") return null;
  const kind: MuseNotificationKind = run.status === "completed" ? "run-completed" : "run-failed";
  const title = run.status === "completed" ? `Automation completed: ${run.scheduleName}` : `Automation failed: ${run.scheduleName}`;
  const body = run.status === "completed"
    ? (run.resultPreview ?? "The scheduled conversation finished.")
    : (run.error ?? "The scheduled conversation could not be dispatched.");
  return {
    id: makeId(),
    kind,
    dedupeKey: `${run.id}:${kind}:${run.finishedAt ?? now}`,
    title,
    body: body.slice(0, 320),
    createdAt: now,
    ...(run.id ? { runId: run.id } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    unread: true,
  };
}

export function appendNotification(
  notifications: MuseNotification[],
  notification: MuseNotification,
): MuseNotification[] {
  if (notifications.some((item) => item.dedupeKey === notification.dedupeKey)) return notifications;
  return [...notifications, notification].slice(-MAX_NOTIFICATIONS);
}

export function markNotificationRead(
  notifications: MuseNotification[],
  id: string,
): MuseNotification[] {
  return notifications.map((item) => item.id === id ? { ...item, unread: false } : item);
}

export function unreadNotificationCount(notifications: MuseNotification[]): number {
  return notifications.filter((item) => item.unread === true).length;
}

function validNotification(value: unknown): value is MuseNotification {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0 &&
    (row.kind === "run-completed" || row.kind === "run-failed") &&
    typeof row.dedupeKey === "string" && row.dedupeKey.length > 0 &&
    typeof row.title === "string" && typeof row.body === "string" &&
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
    (row.runId === undefined || typeof row.runId === "string") &&
    (row.sessionId === undefined || typeof row.sessionId === "string") &&
    (row.unread === undefined || typeof row.unread === "boolean");
}

export function loadNotifications(): MuseNotification[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validNotification).slice(-MAX_NOTIFICATIONS) : [];
  } catch {
    return [];
  }
}

export function saveNotifications(notifications: MuseNotification[]): void {
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications.slice(-MAX_NOTIFICATIONS)));
  } catch {
    // Best effort under quota/privacy mode, like the other local registries.
  }
}

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export function notificationPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.requestPermission();
}

export function deliverDesktopNotification(notification: MuseNotification): boolean {
  if (notificationPermission() !== "granted") return false;
  try {
    new window.Notification(notification.title, { body: notification.body });
    return true;
  } catch {
    return false;
  }
}
