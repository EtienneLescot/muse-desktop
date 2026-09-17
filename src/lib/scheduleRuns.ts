/** Durable schedule run ledger (M3-06).
 *
 * A run is distinct from a review request: approval is an admission step,
 * while this record tracks the actual scheduled execution. The helpers are
 * pure and storage is best-effort under a dedicated namespaced key.
 */
import type { ScheduleAuthorizationMode, ThreadReuse } from "./schedules";
import { readStorageJson, writeStorageJson } from "./storage.ts";

export type ScheduleRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const MAX_RUN_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 15_000;

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  instructions: string;
  threadReuse: ThreadReuse;
  workspace?: string;
  projectId?: string;
  model?: string;
  authorizationMode?: ScheduleAuthorizationMode;
  missedPolicy?: "skip" | "latest";
  occurrenceAt: number;
  /** Stable schedule + occurrence key; legacy rows may omit it. */
  occurrenceKey?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  /** One-based dispatch attempt; legacy rows default to one. */
  attempt?: number;
  /** Retry is not eligible before this timestamp. */
  nextRetryAt?: number;
  /** Result excerpt captured when the host turn finishes. */
  resultPreview?: string;
  /** Inbox unread marker, independent of the business status. */
  unread?: boolean;
  status: ScheduleRunStatus;
  error?: string;
}

export const SCHEDULE_RUNS_KEY = "muse-desktop.schedule-runs.v1";
export const MAX_SCHEDULE_RUNS = 200;

function id(): string {
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createScheduleRun(
  input: Omit<ScheduleRun, "id" | "createdAt" | "status" | "attempt">,
  now: number,
): ScheduleRun {
  return { ...input, id: id(), createdAt: now, attempt: 1, status: "queued" };
}

export function markRunStarted(
  runs: ScheduleRun[],
  idValue: string,
  now: number,
  sessionId?: string,
): ScheduleRun[] {
  return runs.map((run) => run.id === idValue
    ? { ...run, status: "running", startedAt: now, nextRetryAt: undefined, ...(sessionId ? { sessionId } : {}) }
    : run);
}

export function settleRun(
  runs: ScheduleRun[],
  idValue: string,
  status: "completed" | "failed",
  now: number,
  error?: string,
): ScheduleRun[] {
  return runs.map((run) => run.id === idValue
    ? {
        ...run,
        status,
        finishedAt: now,
        ...(status === "completed" || status === "failed" ? { unread: true } : {}),
        ...(status === "completed" ? { error: undefined, nextRetryAt: undefined } : {}),
        ...(error ? { error } : {}),
      }
    : run);
}

/** Mark a run complete when the host emits a turn-stopped event. */
export function completeRun(
  runs: ScheduleRun[],
  idValue: string,
  now: number,
  resultPreview?: string,
): ScheduleRun[] {
  return runs.map((run) => run.id === idValue
    ? {
        ...run,
        status: "completed",
        finishedAt: now,
        unread: true,
        error: undefined,
        nextRetryAt: undefined,
        ...(resultPreview ? { resultPreview } : {}),
      }
    : run);
}

export function markRunRead(runs: ScheduleRun[], idValue: string): ScheduleRun[] {
  return runs.map((run) => run.id === idValue ? { ...run, unread: false } : run);
}

/** Exponential backoff, bounded so a local timer remains predictable. */
export function retryDelayMs(attempt: number): number {
  const safe = Math.max(1, Math.floor(attempt));
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** (safe - 1)), 5 * 60_000);
}

/** Errors whose outcome may be ambiguous must never be retried automatically. */
export function isRetryableScheduleError(message: string): boolean {
  return !/(ambiguous|timed?\s*out|already delivered|already in progress|cannot be verified)/i.test(message);
}

/** Move a failed run to a bounded retry, preserving its occurrence key. */
export function queueRunRetry(
  runs: ScheduleRun[],
  idValue: string,
  now: number,
  error?: string,
): ScheduleRun[] {
  return runs.map((run) => {
    if (run.id !== idValue || run.status !== "failed") return run;
    const attempt = run.attempt ?? 1;
    if (attempt >= MAX_RUN_ATTEMPTS) return run;
    return {
      ...run,
      status: "queued",
      attempt: attempt + 1,
      nextRetryAt: now + retryDelayMs(attempt),
      finishedAt: undefined,
      unread: false,
      ...(error ? { error } : {}),
    };
  });
}

/** Cancellation applies to queued retries; an in-flight host turn is not killed here. */
export function cancelRun(runs: ScheduleRun[], idValue: string, now = Date.now()): ScheduleRun[] {
  return runs.map((run) => run.id === idValue && run.status === "queued"
    ? { ...run, status: "cancelled", finishedAt: now, nextRetryAt: undefined }
    : run);
}

export function appendRun(runs: ScheduleRun[], run: ScheduleRun): ScheduleRun[] {
  const key = run.occurrenceKey ?? `${run.scheduleId}:${run.occurrenceAt}`;
  if (runs.some((row) => (row.occurrenceKey ?? `${row.scheduleId}:${row.occurrenceAt}`) === key)) return runs;
  return [...runs, run].slice(-MAX_SCHEDULE_RUNS);
}

function validReuse(value: unknown): value is ThreadReuse {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.kind === "active" || row.kind === "new" ||
    (row.kind === "session" && typeof row.sessionId === "string" && row.sessionId.length > 0);
}

function validRun(value: unknown): value is ScheduleRun {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0 &&
    typeof row.scheduleId === "string" && row.scheduleId.length > 0 &&
    typeof row.scheduleName === "string" && typeof row.instructions === "string" &&
    validReuse(row.threadReuse) && typeof row.occurrenceAt === "number" &&
    typeof row.createdAt === "number" &&
    (row.status === "queued" || row.status === "running" || row.status === "completed" || row.status === "failed" || row.status === "cancelled") &&
    (row.workspace === undefined || typeof row.workspace === "string") &&
    (row.projectId === undefined || typeof row.projectId === "string") &&
    (row.model === undefined || typeof row.model === "string") &&
    (row.authorizationMode === undefined || row.authorizationMode === "ask" || row.authorizationMode === "workspace" || row.authorizationMode === "yolo") &&
    (row.missedPolicy === undefined || row.missedPolicy === "skip" || row.missedPolicy === "latest") &&
    (row.occurrenceKey === undefined || typeof row.occurrenceKey === "string") &&
    (row.startedAt === undefined || typeof row.startedAt === "number") &&
    (row.finishedAt === undefined || typeof row.finishedAt === "number") &&
    (row.sessionId === undefined || typeof row.sessionId === "string") &&
    (row.attempt === undefined || (typeof row.attempt === "number" && Number.isInteger(row.attempt) && row.attempt >= 1 && row.attempt <= MAX_RUN_ATTEMPTS)) &&
    (row.nextRetryAt === undefined || typeof row.nextRetryAt === "number") &&
    (row.resultPreview === undefined || typeof row.resultPreview === "string") &&
    (row.unread === undefined || typeof row.unread === "boolean") &&
    (row.error === undefined || typeof row.error === "string");
}

export function loadScheduleRuns(): ScheduleRun[] {
  const parsed = readStorageJson<unknown>(SCHEDULE_RUNS_KEY, []);
  return Array.isArray(parsed) ? parsed.filter(validRun).slice(-MAX_SCHEDULE_RUNS) : [];
}

export function saveScheduleRuns(runs: ScheduleRun[]): void {
  writeStorageJson(SCHEDULE_RUNS_KEY, runs.slice(-MAX_SCHEDULE_RUNS));
}
