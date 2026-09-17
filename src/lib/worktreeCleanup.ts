/** Durable, explicit recovery intents for interrupted worktree cleanup. */
import { readStorageJson, writeStorageJson } from "./storage.ts";

export const WORKTREE_CLEANUP_KEY = "muse-desktop.worktree-cleanup.v1";
export const MAX_CLEANUP_INTENTS = 100;
export const MAX_CLEANUP_ERROR_CHARS = 500;

export interface WorktreeCleanupIntent {
  repoRoot: string;
  path: string;
  branch: string;
  requestedAt: number;
  attempts: number;
  status: "pending" | "failed";
  error?: string;
}

function isIntent(value: unknown): value is WorktreeCleanupIntent {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.repoRoot === "string" && row.repoRoot.trim().length > 0 &&
    typeof row.path === "string" && row.path.trim().length > 0 &&
    typeof row.branch === "string" && row.branch.trim().length > 0 &&
    typeof row.requestedAt === "number" && Number.isFinite(row.requestedAt) &&
    typeof row.attempts === "number" && Number.isFinite(row.attempts) && row.attempts >= 0 &&
    (row.status === "pending" || row.status === "failed") &&
    (row.error === undefined || typeof row.error === "string")
  );
}

function key(intent: Pick<WorktreeCleanupIntent, "repoRoot" | "path">): string {
  return `${intent.repoRoot.toLowerCase()}\u0000${intent.path.toLowerCase()}`;
}

function boundedError(error: string): string {
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_CLEANUP_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_CLEANUP_ERROR_CHARS - 1)}…`
    : oneLine;
}

export function loadWorktreeCleanupIntents(): WorktreeCleanupIntent[] {
  const raw = readStorageJson<unknown>(WORKTREE_CLEANUP_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isIntent).slice(-MAX_CLEANUP_INTENTS).map((intent) => ({
    ...intent,
    attempts: Math.min(1000, Math.max(0, Math.floor(intent.attempts))),
    ...(intent.error ? { error: boundedError(intent.error) } : {}),
  }));
}

export function saveWorktreeCleanupIntents(intents: readonly WorktreeCleanupIntent[]): void {
  writeStorageJson(WORKTREE_CLEANUP_KEY, intents.slice(-MAX_CLEANUP_INTENTS));
}

export function requestWorktreeCleanup(
  intents: readonly WorktreeCleanupIntent[],
  record: Pick<WorktreeCleanupIntent, "repoRoot" | "path" | "branch">,
  now: number = Date.now(),
): WorktreeCleanupIntent[] {
  const next: WorktreeCleanupIntent = {
    repoRoot: record.repoRoot.trim(),
    path: record.path.trim(),
    branch: record.branch.trim(),
    requestedAt: Number.isFinite(now) ? now : Date.now(),
    attempts: (intents.find((item) => key(item) === key(record))?.attempts ?? 0) + 1,
    status: "pending",
  };
  return [...intents.filter((item) => key(item) !== key(record)), next].slice(-MAX_CLEANUP_INTENTS);
}

export function markWorktreeCleanupFailed(
  intents: readonly WorktreeCleanupIntent[],
  record: Pick<WorktreeCleanupIntent, "repoRoot" | "path" | "branch">,
  error: string,
): WorktreeCleanupIntent[] {
  const existing = intents.find((item) => key(item) === key(record));
  const next: WorktreeCleanupIntent = {
    repoRoot: record.repoRoot.trim(),
    path: record.path.trim(),
    branch: record.branch.trim(),
    requestedAt: existing?.requestedAt ?? Date.now(),
    attempts: existing?.attempts ?? 1,
    status: "failed",
    error: boundedError(error),
  };
  return [...intents.filter((item) => key(item) !== key(record)), next].slice(-MAX_CLEANUP_INTENTS);
}

export function clearWorktreeCleanup(
  intents: readonly WorktreeCleanupIntent[],
  record: Pick<WorktreeCleanupIntent, "repoRoot" | "path">,
): WorktreeCleanupIntent[] {
  return intents.filter((item) => key(item) !== key(record));
}
