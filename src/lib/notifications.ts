import type { ScheduleRun } from "./scheduleRuns";
import { readStorageJson, writeStorageJson } from "./storage.ts";
import { isTauriRuntime } from "./env.ts";

export type MuseNotificationKind = "run-completed" | "run-failed" | "approval-needed" | "input-needed";

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
export const NOTIFICATION_PREFERENCES_KEY = "muse-desktop.notifications.preferences.v1";
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

export interface ApprovalNotificationInput {
  sessionId: string;
  requestId: string;
  toolName?: string;
  summary?: string;
}

export function buildApprovalNotification(
  input: ApprovalNotificationInput,
  now = Date.now(),
): MuseNotification {
  const tool = input.toolName?.trim() || "an action";
  const summary = input.summary?.trim();
  return {
    id: makeId(),
    kind: "approval-needed",
    dedupeKey: `approval:${input.sessionId}:${input.requestId}`,
    title: "Approval needed",
    body: summary ? `${tool}: ${summary}`.slice(0, 320) : `Muse is waiting for approval to continue ${tool}.`,
    createdAt: now,
    sessionId: input.sessionId,
    unread: true,
  };
}

export interface InputNotificationInput {
  sessionId: string;
  inputId: string;
  toolName?: string;
  questionCount?: number;
}

export function buildInputNotification(
  input: InputNotificationInput,
  now = Date.now(),
): MuseNotification {
  const tool = input.toolName?.trim() || "Muse";
  const count = input.questionCount === 1 ? "one question" : `${Math.max(1, input.questionCount ?? 0)} questions`;
  return {
    id: makeId(),
    kind: "input-needed",
    dedupeKey: `input:${input.sessionId}:${input.inputId}`,
    title: "Muse needs your input",
    body: `${tool} is waiting for ${count} before continuing.`,
    createdAt: now,
    sessionId: input.sessionId,
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
    (row.kind === "run-completed" || row.kind === "run-failed" || row.kind === "approval-needed" || row.kind === "input-needed") &&
    typeof row.dedupeKey === "string" && row.dedupeKey.length > 0 &&
    typeof row.title === "string" && typeof row.body === "string" &&
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
    (row.runId === undefined || typeof row.runId === "string") &&
    (row.sessionId === undefined || typeof row.sessionId === "string") &&
    (row.unread === undefined || typeof row.unread === "boolean");
}

export function loadNotifications(): MuseNotification[] {
  const parsed = readStorageJson<unknown>(NOTIFICATIONS_KEY, []);
  return Array.isArray(parsed) ? parsed.filter(validNotification).slice(-MAX_NOTIFICATIONS) : [];
}

export function saveNotifications(notifications: MuseNotification[]): void {
  writeStorageJson(NOTIFICATIONS_KEY, notifications.slice(-MAX_NOTIFICATIONS));
}

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export interface NotificationPreferences {
  /** Keep the in-app inbox active while suppressing OS toasts. */
  desktopMuted: boolean;
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { desktopMuted: false };

function validNotificationPreferences(value: unknown): value is NotificationPreferences {
  return typeof value === "object" && value !== null &&
    typeof (value as Record<string, unknown>).desktopMuted === "boolean";
}

export function loadNotificationPreferences(): NotificationPreferences {
  const parsed = readStorageJson<unknown>(NOTIFICATION_PREFERENCES_KEY, DEFAULT_NOTIFICATION_PREFERENCES);
  return validNotificationPreferences(parsed) ? parsed : { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

export function saveNotificationPreferences(preferences: NotificationPreferences): void {
  writeStorageJson(NOTIFICATION_PREFERENCES_KEY, { desktopMuted: preferences.desktopMuted === true });
}

export function notificationPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (isTauriRuntime()) {
    try {
      const { requestPermission } = await import("@tauri-apps/plugin-notification");
      return await requestPermission();
    } catch {
      // Fall back to the webview permission API when the plugin is unavailable.
    }
  }
  return window.Notification.requestPermission();
}

export async function deliverDesktopNotification(notification: MuseNotification): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
      if (await isPermissionGranted()) {
        sendNotification({ title: notification.title, body: notification.body });
        return true;
      }
    } catch {
      // Keep the in-app inbox authoritative when native notifications fail.
    }
  }
  if (notificationPermission() !== "granted") return false;
  try {
    const toast = new window.Notification(notification.title, { body: notification.body });
    // The webview notification API has no routing contract. A click still
    // returns the user to the running Muse window; the in-app inbox then
    // provides the session-specific "Open conversation" action.
    toast.onclick = () => {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => {
          const appWindow = getCurrentWindow();
          return Promise.allSettled([appWindow.unminimize(), appWindow.setFocus()]);
        })
        .catch(() => {
          window.focus?.();
        });
    };
    return true;
  } catch {
    return false;
  }
}
