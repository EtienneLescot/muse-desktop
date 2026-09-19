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
  /** Explicit facts from the run result; never inferred by the notification layer. */
  issues?: string[];
  nextSteps?: string[];
  unread?: boolean;
}

export const NOTIFICATIONS_KEY = "muse-desktop.notifications.v1";
export const NOTIFICATION_PREFERENCES_KEY = "muse-desktop.notifications.preferences.v1";
export const MAX_NOTIFICATIONS = 200;
export const NOTIFICATION_ACTION_EVENT = "muse-desktop:notification-action";
const NOTIFICATION_ACTION_TYPE = "muse-open-conversation";
const MAX_NOTIFICATION_ISSUES = 6;
const MAX_NOTIFICATION_NEXT_STEPS = 4;
const MAX_NOTIFICATION_FACT_CHARS = 220;

export interface NotificationActionPayload extends Record<string, unknown> {
  notificationId?: string;
  sessionId?: string;
  runId?: string;
}

export type NotificationRoute =
  | { kind: "task"; sessionId: string }
  | { kind: "automations"; runId: string }
  | null;

/** Resolve a notification click through the current session/run SSOT. */
export function resolveNotificationRoute(
  payload: NotificationActionPayload,
  sessionIds: readonly string[],
  runIds: readonly string[],
): NotificationRoute {
  if (payload.sessionId && sessionIds.includes(payload.sessionId)) {
    return { kind: "task", sessionId: payload.sessionId };
  }
  if (payload.runId && runIds.includes(payload.runId)) {
    return { kind: "automations", runId: payload.runId };
  }
  return null;
}

let actionTypeSetup: Promise<boolean> | null = null;

export function notificationActionPayload(notification: MuseNotification): NotificationActionPayload {
  return {
    notificationId: notification.id,
    ...(notification.sessionId ? { sessionId: notification.sessionId } : {}),
    ...(notification.runId ? { runId: notification.runId } : {}),
  };
}

function emitNotificationAction(payload: NotificationActionPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NotificationActionPayload>(NOTIFICATION_ACTION_EVENT, {
    detail: payload,
  }));
}

/** Register the native action type once; sending still degrades to a plain
 * toast when an older Tauri notification plugin does not support actions. */
async function ensureNativeActionType(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (actionTypeSetup !== null) return actionTypeSetup;
  actionTypeSetup = import("@tauri-apps/plugin-notification")
    .then(async ({ registerActionTypes }) => {
      await registerActionTypes([{
        id: NOTIFICATION_ACTION_TYPE,
        actions: [{ id: "open", title: "Open conversation", foreground: true }],
      }]);
      return true;
    })
    .catch(() => false);
  return actionTypeSetup;
}

/** Subscribe to native notification clicks and route only validated ids. */
export async function subscribeNotificationActions(
  onOpen: (payload: NotificationActionPayload) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const ready = await ensureNativeActionType();
  if (!ready) return () => {};
  try {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    const listener = await onAction((notification) => {
      const extra = notification.extra;
      if (!extra || typeof extra !== "object") return;
      const payload: NotificationActionPayload = {
        ...(typeof extra.notificationId === "string" ? { notificationId: extra.notificationId } : {}),
        ...(typeof extra.sessionId === "string" ? { sessionId: extra.sessionId } : {}),
        ...(typeof extra.runId === "string" ? { runId: extra.runId } : {}),
      };
      if (payload.sessionId || payload.runId) onOpen(payload);
    });
    return () => listener.unregister();
  } catch {
    return () => {};
  }
}

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
  const issues = normalizeNotificationFacts(run.resultSummary?.issues, MAX_NOTIFICATION_ISSUES, /^(?:issues?|warnings?|blockers?|risks?|failures?|errors?|limitations?)\s*[:\-]\s*/i);
  const nextSteps = normalizeNotificationFacts(run.resultSummary?.nextSteps, MAX_NOTIFICATION_NEXT_STEPS, /^(?:next steps?|todo|to-do|follow[- ]?up|remaining|recommended)\s*[:\-]\s*/i);
  return {
    id: makeId(),
    kind,
    dedupeKey: `${run.id}:${kind}:${run.finishedAt ?? now}`,
    title,
    body: body.slice(0, 320),
    createdAt: now,
    ...(run.id ? { runId: run.id } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
    unread: true,
  };
}

function normalizeNotificationFacts(value: readonly string[] | undefined, limit: number, prefix?: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().replace(prefix ?? /^/, "").trim();
    if (text.length === 0) continue;
    const bounded = text.length > MAX_NOTIFICATION_FACT_CHARS
      ? `${text.slice(0, MAX_NOTIFICATION_FACT_CHARS)}…`
      : text;
    if (!facts.includes(bounded)) facts.push(bounded);
    if (facts.length >= limit) break;
  }
  return facts;
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

/** Mark every notification as read while preserving ordering and provenance. */
export function markAllNotificationsRead(
  notifications: MuseNotification[],
): MuseNotification[] {
  return notifications.map((item) => item.unread === true ? { ...item, unread: false } : item);
}

export function unreadNotificationCount(notifications: MuseNotification[]): number {
  return notifications.filter((item) => item.unread === true).length;
}

export type NotificationFilter = "all" | "unread";

/** Select inbox rows for the UI without mutating the durable ledger. */
export function filterNotifications(
  notifications: readonly MuseNotification[],
  filter: NotificationFilter = "all",
): MuseNotification[] {
  return notifications
    .filter((item) => filter === "all" || item.unread === true)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
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
    (row.issues === undefined || (Array.isArray(row.issues) && row.issues.every((item) => typeof item === "string"))) &&
    (row.nextSteps === undefined || (Array.isArray(row.nextSteps) && row.nextSteps.every((item) => typeof item === "string"))) &&
    (row.unread === undefined || typeof row.unread === "boolean");
}

/** Parse a persisted inbox without trusting webview or native JSON. */
export function normalizeNotifications(raw: unknown): MuseNotification[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(validNotification).map((item) => ({
    ...item,
    ...(item.issues ? { issues: normalizeNotificationFacts(item.issues, MAX_NOTIFICATION_ISSUES, /^(?:issues?|warnings?|blockers?|risks?|failures?|errors?|limitations?)\s*[:\-]\s*/i) } : {}),
    ...(item.nextSteps ? { nextSteps: normalizeNotificationFacts(item.nextSteps, MAX_NOTIFICATION_NEXT_STEPS, /^(?:next steps?|todo|to-do|follow[- ]?up|remaining|recommended)\s*[:\-]\s*/i) } : {}),
  })).slice(-MAX_NOTIFICATIONS);
}

export function loadNotifications(): MuseNotification[] {
  return normalizeNotifications(readStorageJson<unknown>(NOTIFICATIONS_KEY, []));
}

export function saveNotifications(notifications: MuseNotification[]): void {
  writeStorageJson(NOTIFICATIONS_KEY, notifications.slice(-MAX_NOTIFICATIONS));
}

/** Merge webview/native inbox copies by dedupe key, keeping the newest row. */
export function mergeNotifications(...ledgers: MuseNotification[][]): MuseNotification[] {
  const merged = new Map<string, MuseNotification>();
  for (const ledger of ledgers) {
    for (const item of normalizeNotifications(ledger)) {
      const existing = merged.get(item.dedupeKey);
      if (!existing || item.createdAt >= existing.createdAt) merged.set(item.dedupeKey, item);
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_NOTIFICATIONS);
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
        const actionReady = await ensureNativeActionType();
        sendNotification({
          title: notification.title,
          body: notification.body,
          ...(actionReady
            ? {
                actionTypeId: NOTIFICATION_ACTION_TYPE,
                extra: notificationActionPayload(notification),
                autoCancel: true,
              }
            : {}),
        });
        return true;
      }
    } catch {
      // Keep the in-app inbox authoritative when native notifications fail.
    }
  }
  if (notificationPermission() !== "granted") return false;
  try {
    const toast = new window.Notification(notification.title, { body: notification.body });
    // The webview fallback has no native action type, but it can still route
    // the same bounded payload through the app event bus.
    toast.onclick = () => {
      emitNotificationAction(notificationActionPayload(notification));
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
