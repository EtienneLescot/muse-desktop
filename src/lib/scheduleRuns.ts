/** Durable schedule run ledger (M3-06).
 *
 * A run is distinct from a review request: approval is an admission step,
 * while this record tracks the actual scheduled execution. The helpers are
 * pure and storage is best-effort under a dedicated namespaced key.
 */
import { isValidTimeZone, type ScheduleAuthorizationMode, type ThreadReuse } from "./schedules.ts";
import { readStorageJson, writeStorageJson } from "./storage.ts";
import type { ScheduleRunSummary } from "./runSummary.ts";

export type ScheduleRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
/**
 * A run that was still non-terminal when the renderer went away cannot be
 * replayed safely: the host may have accepted the turn just before the
 * durable row was flushed. Keep this marker until the user explicitly
 * reconciles the run.
 */
export type ScheduleRunRecovery = "after-restart";

export const SCHEDULE_RUN_RECOVERY_ERROR =
  "The app restarted before the host confirmed this run. Verify the target conversation before retrying.";

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
  timeZone?: string;
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
  /** Bounded extractive facts captured with the result, never a model claim. */
  resultSummary?: ScheduleRunSummary;
  /** Inbox unread marker, independent of the business status. */
  unread?: boolean;
  /** Archived rows stay durable but are hidden from the default inbox view. */
  archived?: boolean;
  /** Set on a non-terminal row recovered after an app restart. */
  recovery?: ScheduleRunRecovery;
  recoveryDetectedAt?: number;
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
        ...(status === "completed" || status === "failed"
          ? { recovery: undefined, recoveryDetectedAt: undefined }
          : {}),
        ...(error ? { error } : {}),
      }
    : run);
}

/** Mark a run complete when the host emits a successful turn-stopped event. */
export function completeRun(
  runs: ScheduleRun[],
  idValue: string,
  now: number,
  resultPreview?: string,
  resultSummary?: ScheduleRunSummary,
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
        ...(resultSummary ? { resultSummary } : {}),
      }
    : run);
}

export interface ScheduledTurnOutcome {
  status: "completed" | "failed";
  /** Bounded, redacted engine detail when the host rejected the turn. */
  error?: string;
  retryable?: boolean;
  resultPreview?: string;
  resultSummary?: ScheduleRunSummary;
}

/**
 * Settle every scheduled run currently attached to a session when its host
 * emits a terminal turn event. A failed engine turn may enter the same bounded
 * retry queue as an admission failure; ambiguous outcomes remain failed.
 */
export function settleRunsForSession(
  runs: ScheduleRun[],
  sessionId: string,
  outcome: ScheduledTurnOutcome,
  now: number,
): ScheduleRun[] {
  let next = runs;
  for (const run of runs) {
    if (run.sessionId !== sessionId || run.status !== "running") continue;
    if (outcome.status === "completed") {
      next = completeRun(next, run.id, now, outcome.resultPreview, outcome.resultSummary);
      continue;
    }
    const reason = outcome.error?.trim() || "scheduled turn failed";
    const failed = settleRun(next, run.id, "failed", now, reason);
    next = outcome.retryable && isRetryableScheduleError(reason)
      ? queueRunRetry(failed, run.id, now, reason)
      : failed;
  }
  return next;
}

export function markRunRead(runs: ScheduleRun[], idValue: string): ScheduleRun[] {
  return runs.map((run) => run.id === idValue ? { ...run, unread: false } : run);
}

export function archiveRun(runs: ScheduleRun[], idValue: string): ScheduleRun[] {
  return runs.map((run) => run.id === idValue ? { ...run, archived: true } : run);
}

export function restoreRun(runs: ScheduleRun[], idValue: string): ScheduleRun[] {
  return runs.map((run) => run.id === idValue ? { ...run, archived: false } : run);
}

/** Promote a failed run or a delayed retry to the front of the local queue. */
export function retryRunNow(runs: ScheduleRun[], idValue: string, now = Date.now()): ScheduleRun[] {
  return runs.map((run) => {
    if (run.id !== idValue) return run;
    const attempt = run.attempt ?? 1;
    const retryable = run.status === "failed" || (run.status === "queued" && run.nextRetryAt !== undefined);
    if (!retryable || attempt >= MAX_RUN_ATTEMPTS) return run;
    return {
      ...run,
      status: "queued",
      nextRetryAt: now,
      finishedAt: undefined,
      unread: false,
      archived: false,
      error: undefined,
    };
  });
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

/**
 * Mark a recovered in-flight row as failed after the user has checked the
 * target conversation. This is deliberately a separate gesture from retry:
 * it makes the ambiguous host outcome visible and only then enables the
 * existing bounded manual retry path.
 */
export function markRecoveredRunFailed(
  runs: ScheduleRun[],
  idValue: string,
  now = Date.now(),
): ScheduleRun[] {
  const target = runs.find((run) => run.id === idValue);
  if (!target?.recovery) return runs;
  return settleRun(runs, idValue, "failed", now, SCHEDULE_RUN_RECOVERY_ERROR);
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
    (row.timeZone === undefined || (typeof row.timeZone === "string" && isValidTimeZone(row.timeZone))) &&
    (row.occurrenceKey === undefined || typeof row.occurrenceKey === "string") &&
    (row.startedAt === undefined || typeof row.startedAt === "number") &&
    (row.finishedAt === undefined || typeof row.finishedAt === "number") &&
    (row.sessionId === undefined || typeof row.sessionId === "string") &&
    (row.attempt === undefined || (typeof row.attempt === "number" && Number.isInteger(row.attempt) && row.attempt >= 1 && row.attempt <= MAX_RUN_ATTEMPTS)) &&
    (row.nextRetryAt === undefined || typeof row.nextRetryAt === "number") &&
    (row.resultPreview === undefined || typeof row.resultPreview === "string") &&
    (row.resultSummary === undefined || validRunSummary(row.resultSummary)) &&
    (row.unread === undefined || typeof row.unread === "boolean") &&
    (row.archived === undefined || typeof row.archived === "boolean") &&
    (row.recovery === undefined || row.recovery === "after-restart") &&
    (row.recoveryDetectedAt === undefined || typeof row.recoveryDetectedAt === "number") &&
    (row.error === undefined || typeof row.error === "string");
}

function validRunSummary(value: unknown): value is ScheduleRunSummary {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.headline === "string" && row.headline.length <= 300 &&
    typeof row.totalItems === "number" && Number.isInteger(row.totalItems) && row.totalItems >= 0 &&
    typeof row.assistantMessages === "number" && Number.isInteger(row.assistantMessages) && row.assistantMessages >= 0 &&
    typeof row.toolEvents === "number" && Number.isInteger(row.toolEvents) && row.toolEvents >= 0 &&
    Array.isArray(row.filesMentioned) && row.filesMentioned.every((item) => typeof item === "string" && item.length <= 200) && row.filesMentioned.length <= 12 &&
    Array.isArray(row.decisions) && row.decisions.every((item) => typeof item === "string" && item.length <= 200) && row.decisions.length <= 12 &&
    (row.nextSteps === undefined || (Array.isArray(row.nextSteps) && row.nextSteps.every((item) => typeof item === "string" && item.length <= 200) && row.nextSteps.length <= 4));
}

/** Parse a persisted ledger without trusting renderer or native storage. */
export function normalizeScheduleRuns(raw: unknown): ScheduleRun[] {
  return Array.isArray(raw) ? raw.filter(validRun).slice(-MAX_SCHEDULE_RUNS) : [];
}

export function loadScheduleRuns(): ScheduleRun[] {
  return normalizeScheduleRuns(readStorageJson<unknown>(SCHEDULE_RUNS_KEY, []));
}

function runLifecycleTimestamp(run: ScheduleRun): number {
  return Math.max(
    run.createdAt,
    run.startedAt ?? 0,
    run.finishedAt ?? 0,
    run.recoveryDetectedAt ?? 0,
    run.nextRetryAt ?? 0,
  );
}

function runOccurrenceKey(run: ScheduleRun): string {
  return run.occurrenceKey ?? `${run.scheduleId}:${run.occurrenceAt}`;
}

function isTerminalRun(run: ScheduleRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

function shouldPreferRun(candidate: ScheduleRun, existing: ScheduleRun): boolean {
  const candidateAttempt = candidate.attempt ?? 1;
  const existingAttempt = existing.attempt ?? 1;
  if (candidateAttempt !== existingAttempt) return candidateAttempt > existingAttempt;
  // A local recovery marker is a safety hold, not evidence that the host
  // regressed. Preserve a terminal snapshot from the native mirror over that
  // marker even when the recovery timestamp is newer.
  const candidateTerminal = isTerminalRun(candidate) && candidate.recovery === undefined;
  const existingTerminal = isTerminalRun(existing) && existing.recovery === undefined;
  if (candidateTerminal !== existingTerminal) return candidateTerminal;
  if (candidate.recovery !== undefined && existing.recovery === undefined) return false;
  if (candidate.recovery === undefined && existing.recovery !== undefined) return true;
  return runLifecycleTimestamp(candidate) >= runLifecycleTimestamp(existing);
}

/**
 * Merge the webview and native ledgers after a relaunch. Both stores can be
 * ahead of the other when a renderer disappears during a write, so rows are
 * deduplicated by occurrence and the newest lifecycle snapshot wins. This
 * keeps the hook's state as the single source of truth while avoiding silent
 * loss during migration from localStorage to the native ledger.
 */
export function mergeScheduleRuns(...ledgers: ScheduleRun[][]): ScheduleRun[] {
  const merged = new Map<string, ScheduleRun>();
  for (const ledger of ledgers) {
    for (const run of normalizeScheduleRuns(ledger)) {
      const key = runOccurrenceKey(run);
      const existing = merged.get(key);
      if (!existing || shouldPreferRun(run, existing)) {
        merged.set(key, run);
      }
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_SCHEDULE_RUNS);
}

/**
 * Reconcile rows once at renderer boot. Known delayed retries remain safe to
 * run automatically; rows without a terminal result or retry deadline are
 * held for an explicit user decision instead of being replayed blindly.
 */
export function recoverScheduleRuns(runs: ScheduleRun[], now = Date.now()): ScheduleRun[] {
  return runs.map((run) => {
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    if (run.recovery || (run.status === "queued" && run.nextRetryAt !== undefined)) return run;
    return {
      ...run,
      recovery: "after-restart",
      recoveryDetectedAt: now,
      unread: true,
    };
  });
}

export function saveScheduleRuns(runs: ScheduleRun[]): void {
  writeStorageJson(SCHEDULE_RUNS_KEY, runs.slice(-MAX_SCHEDULE_RUNS));
}
