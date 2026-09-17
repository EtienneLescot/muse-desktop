/** Durable schedule run ledger (M3-06).
 *
 * A run is distinct from a review request: approval is an admission step,
 * while this record tracks the actual scheduled execution. The helpers are
 * pure and storage is best-effort under a dedicated namespaced key.
 */
import type { ScheduleAuthorizationMode, ThreadReuse } from "./schedules";

export type ScheduleRunStatus = "queued" | "running" | "completed" | "failed";

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
  occurrenceAt: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  status: ScheduleRunStatus;
  error?: string;
}

export const SCHEDULE_RUNS_KEY = "muse-desktop.schedule-runs.v1";
export const MAX_SCHEDULE_RUNS = 200;

function id(): string {
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createScheduleRun(
  input: Omit<ScheduleRun, "id" | "createdAt" | "status">,
  now: number,
): ScheduleRun {
  return { ...input, id: id(), createdAt: now, status: "queued" };
}

export function markRunStarted(
  runs: ScheduleRun[],
  idValue: string,
  now: number,
  sessionId?: string,
): ScheduleRun[] {
  return runs.map((run) => run.id === idValue
    ? { ...run, status: "running", startedAt: now, ...(sessionId ? { sessionId } : {}) }
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
    ? { ...run, status, finishedAt: now, ...(error ? { error } : {}) }
    : run);
}

export function appendRun(runs: ScheduleRun[], run: ScheduleRun): ScheduleRun[] {
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
    (row.status === "queued" || row.status === "running" || row.status === "completed" || row.status === "failed") &&
    (row.workspace === undefined || typeof row.workspace === "string") &&
    (row.projectId === undefined || typeof row.projectId === "string") &&
    (row.model === undefined || typeof row.model === "string") &&
    (row.authorizationMode === undefined || row.authorizationMode === "ask" || row.authorizationMode === "workspace" || row.authorizationMode === "yolo") &&
    (row.startedAt === undefined || typeof row.startedAt === "number") &&
    (row.finishedAt === undefined || typeof row.finishedAt === "number") &&
    (row.sessionId === undefined || typeof row.sessionId === "string") &&
    (row.error === undefined || typeof row.error === "string");
}

export function loadScheduleRuns(): ScheduleRun[] {
  try {
    const raw = localStorage.getItem(SCHEDULE_RUNS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validRun).slice(-MAX_SCHEDULE_RUNS) : [];
  } catch {
    return [];
  }
}

export function saveScheduleRuns(runs: ScheduleRun[]): void {
  try {
    localStorage.setItem(SCHEDULE_RUNS_KEY, JSON.stringify(runs.slice(-MAX_SCHEDULE_RUNS)));
  } catch {
    // Best effort, matching the other local registries.
  }
}

