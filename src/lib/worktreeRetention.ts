/** M2-06: durable, conservative worktree retention policy. */
import type { WorktreeInspection, WorktreeRecord } from "./worktrees.ts";
import { readStorageJson, writeStorageJson } from "./storage.ts";

export const WORKTREE_RETENTION_KEY = "muse-desktop.worktree-retention.v1";
export const DEFAULT_RETENTION_DAYS = null;
export const MAX_RETENTION_DAYS = 3_650;

export interface WorktreeRetentionPolicy {
  /** null means keep until the user explicitly removes the checkout. */
  maxAgeDays: number | null;
}

export interface RetentionDecision {
  eligible: boolean;
  reason: string;
  ageDays: number | null;
}

function keyFor(repoRoot: string): string {
  return `${WORKTREE_RETENTION_KEY}.${encodeURIComponent(repoRoot.trim())}`;
}

function validPolicy(value: unknown): value is WorktreeRetentionPolicy {
  if (typeof value !== "object" || value === null) return false;
  const days = (value as Record<string, unknown>).maxAgeDays;
  return days === null || (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS);
}

export function normalizeRetentionDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) return null;
  return days;
}

export function loadWorktreeRetention(repoRoot: string): WorktreeRetentionPolicy {
  const parsed = readStorageJson<unknown>(keyFor(repoRoot), { maxAgeDays: DEFAULT_RETENTION_DAYS });
  return validPolicy(parsed) ? parsed : { maxAgeDays: DEFAULT_RETENTION_DAYS };
}

export function saveWorktreeRetention(repoRoot: string, policy: WorktreeRetentionPolicy): void {
  writeStorageJson(keyFor(repoRoot), { maxAgeDays: normalizeRetentionDays(policy.maxAgeDays) });
}

/**
 * Evaluate one record only from an explicit Git inspection. Missing or dirty
 * observations always stay protected; no filesystem probing happens here.
 */
export function retentionDecision(
  record: WorktreeRecord,
  inspection: WorktreeInspection | undefined,
  policy: WorktreeRetentionPolicy,
  now = Date.now(),
): RetentionDecision {
  if (policy.maxAgeDays === null) {
    return { eligible: false, ageDays: null, reason: "Automatic retention is off; remove explicitly when ready." };
  }
  if (inspection === undefined) {
    return { eligible: false, ageDays: null, reason: "Inspect this worktree before evaluating retention." };
  }
  if (!inspection.clean || inspection.conflicted) {
    return { eligible: false, ageDays: null, reason: "Protected: uncommitted or conflicted changes detected." };
  }
  const ageDays = Math.max(0, Math.floor((Math.max(now, record.createdAt) - record.createdAt) / 86_400_000));
  if (ageDays < policy.maxAgeDays) {
    return {
      eligible: false,
      ageDays,
      reason: `Retained for ${policy.maxAgeDays - ageDays} more day(s); the checkout is clean.`,
    };
  }
  return { eligible: true, ageDays, reason: `Eligible for cleanup after ${ageDays} day(s); removal still requires confirmation.` };
}
