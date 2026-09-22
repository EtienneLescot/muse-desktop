/**
 * M2-05 handoff planning. The planner is deliberately pure and read-only:
 * the MSP host is scoped to one workspace, so no switch is implied until all
 * preconditions have been inspected and a later transfer command exists.
 */

export type HandoffDirection = "local-to-worktree" | "worktree-to-local";
export type HandoffCheckStatus = "pass" | "warn" | "blocked";

export interface HandoffInput {
  direction: HandoffDirection;
  sourceWorkspace: string;
  sourceBranch: string | null;
  sourceChangedFiles: number;
  sourceConflictedFiles: number;
  sourceStatusObserved?: boolean;
  targetPath: string;
  targetBranch: string;
  targetExists: boolean;
  targetDirty?: boolean;
  /** Optional read-only inspection signal; undefined means not refreshed. */
  targetIgnoredFiles?: number;
  targetBranchInUse?: boolean;
}

export interface HandoffCheck {
  id: string;
  label: string;
  status: HandoffCheckStatus;
  detail: string;
}

export interface HandoffPlan {
  direction: HandoffDirection;
  ready: boolean;
  checks: HandoffCheck[];
  steps: string[];
  /** The read-only inputs captured when the plan was prepared. */
  snapshot: HandoffSnapshot;
  /** Local timestamp used to explain when a plan should be refreshed. */
  createdAt: number;
}

/** Minimal transcript shape used for a bounded local context excerpt. */
export interface HandoffTranscriptEntry {
  role: string;
  text: string;
}

/** Stable, non-secret inputs used to decide whether a plan is still current. */
export interface HandoffSnapshot {
  direction: HandoffDirection;
  sourceWorkspace: string;
  sourceBranch: string | null;
  sourceChangedFiles: number;
  sourceConflictedFiles: number;
  sourceStatusObserved: boolean | undefined;
  targetPath: string;
  targetBranch: string;
  targetExists: boolean;
  targetDirty: boolean | undefined;
  targetIgnoredFiles: number | undefined;
  targetBranchInUse: boolean | undefined;
}

const MAX_HANDOFF_CONTEXT = 4_000;
const MAX_HANDOFF_ENTRIES = 8;

function contextValue(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized || fallback;
}

function transcriptExcerpt(entries: readonly HandoffTranscriptEntry[]): string[] {
  return entries
    .filter((entry) => {
      const role = entry.role.trim().toLowerCase();
      // System/protocol rows are local bookkeeping and should never be copied
      // into a handoff prompt as if they were user intent.
      return (role === "user" || role === "assistant") && entry.text.trim().length > 0;
    })
    .slice(-MAX_HANDOFF_ENTRIES)
    .map((entry) => {
      const role = entry.role.trim().toLowerCase() === "user" ? "You" : "Muse";
      const text = contextValue(entry.text, "");
      return `${role}: ${text}`;
    });
}

function check(
  id: string,
  label: string,
  status: HandoffCheckStatus,
  detail: string,
): HandoffCheck {
  return { id, label, status, detail };
}

/** Build a reviewable handoff plan without changing files or sessions. */
export function buildHandoffPlan(input: HandoffInput): HandoffPlan {
  const checks: HandoffCheck[] = [];
  const sourceWorkspace = input.sourceWorkspace.trim();
  const targetPath = input.targetPath.trim();
  const targetBranch = input.targetBranch.trim();

  checks.push(
    input.sourceStatusObserved === false
      ? check("source-status", "Source status", "warn", "Refresh the source worktree status before transfer.")
      : check("source-status", "Source status", "pass", "Source Git status is available."),
  );
  checks.push(
    sourceWorkspace.length > 0
      ? check("source", "Source workspace", "pass", sourceWorkspace)
      : check("source", "Source workspace", "blocked", "No source workspace is selected."),
  );
  checks.push(
    input.targetExists && targetPath.length > 0
      ? check("target", "Target worktree", "pass", targetPath)
      : check(
          "target",
          "Target worktree",
          "blocked",
          "Create and resolve the managed worktree before handoff.",
        ),
  );
  checks.push(
    input.sourceConflictedFiles === 0
      ? check("source-conflicts", "Source conflicts", "pass", "No conflicted files detected.")
      : check(
          "source-conflicts",
          "Source conflicts",
          "blocked",
          `${input.sourceConflictedFiles} conflicted file(s) must be resolved first.`,
        ),
  );
  checks.push(
    input.sourceChangedFiles === 0
      ? check("source-dirty", "Source changes", "pass", "Source worktree is clean.")
      : check(
          "source-dirty",
          "Source changes",
          "warn",
          `${input.sourceChangedFiles} changed file(s) need an explicit snapshot or commit.`,
        ),
  );
  checks.push(
    input.targetDirty === undefined
      ? check("target-status", "Target status", "warn", "Refresh the target worktree status before transfer.")
      : input.targetDirty
        ? check("target-status", "Target status", "blocked", "Target worktree has uncommitted changes.")
        : check("target-status", "Target status", "pass", "Target worktree is clean."),
  );
  checks.push(
    input.targetIgnoredFiles === undefined
      ? check("target-ignored", "Ignored files", "warn", "Inspect the target worktree before transferring generated artifacts.")
      : input.targetIgnoredFiles > 0
        ? check(
            "target-ignored",
            "Ignored files",
            "warn",
            `${input.targetIgnoredFiles} ignored file(s) need an explicit review before transfer.`,
          )
        : check("target-ignored", "Ignored files", "pass", "No ignored files detected."),
  );
  checks.push(
    input.targetBranchInUse === undefined
      ? check("branch-lock", "Branch availability", "warn", "Confirm the target branch is not checked out elsewhere.")
      : input.targetBranchInUse
        ? check("branch-lock", "Branch availability", "blocked", "Target branch is already checked out elsewhere.")
        : check("branch-lock", "Branch availability", "pass", targetBranch || "Target branch available."),
  );

  const ready = checks.every((item) => item.status !== "blocked");
  const steps = [
    "Refresh source and target Git status, then confirm the checks above.",
    "Snapshot or commit source changes before transferring context.",
    "Stop the active turn and keep the current conversation context attached.",
    input.direction === "local-to-worktree"
      ? "Start the conversation against the worktree after the transfer command is available."
      : "Start the conversation against Local after the transfer command is available.",
  ];
  return {
    direction: input.direction,
    ready,
    checks,
    steps,
    snapshot: {
      direction: input.direction,
      sourceWorkspace,
      sourceBranch: input.sourceBranch,
      sourceChangedFiles: input.sourceChangedFiles,
      sourceConflictedFiles: input.sourceConflictedFiles,
      sourceStatusObserved: input.sourceStatusObserved,
      targetPath,
      targetBranch,
      targetExists: input.targetExists,
      targetDirty: input.targetDirty,
      targetIgnoredFiles: input.targetIgnoredFiles,
      targetBranchInUse: input.targetBranchInUse,
    },
    createdAt: Date.now(),
  };
}

/**
 * A plan is review-only evidence. If a new inspection changes any captured
 * input, it must be prepared again before a future transfer command can use
 * it. The comparison is deliberately explicit so a missing observation never
 * becomes an accidental match.
 */
export function isHandoffPlanStale(
  plan: HandoffPlan,
  input: HandoffInput,
): boolean {
  const snapshot = plan.snapshot;
  const sourceWorkspace = input.sourceWorkspace.trim();
  const targetPath = input.targetPath.trim();
  const targetBranch = input.targetBranch.trim();
  return (
    snapshot.direction !== input.direction ||
    snapshot.sourceWorkspace !== sourceWorkspace ||
    snapshot.sourceBranch !== input.sourceBranch ||
    snapshot.sourceChangedFiles !== input.sourceChangedFiles ||
    snapshot.sourceConflictedFiles !== input.sourceConflictedFiles ||
    snapshot.sourceStatusObserved !== input.sourceStatusObserved ||
    snapshot.targetPath !== targetPath ||
    snapshot.targetBranch !== targetBranch ||
    snapshot.targetExists !== input.targetExists ||
    snapshot.targetDirty !== input.targetDirty ||
    snapshot.targetIgnoredFiles !== input.targetIgnoredFiles ||
    snapshot.targetBranchInUse !== input.targetBranchInUse
  );
}

/**
 * Format a reviewable handoff as editable composer context. This is a local
 * context handoff only; it never claims that the MSP host moved a session.
 */
export function formatHandoffContext(
  plan: HandoffPlan,
  entries: readonly HandoffTranscriptEntry[] = [],
): string {
  const direction = plan.direction === "local-to-worktree"
    ? "Local → Worktree"
    : "Worktree → Local";
  const lines = [
    "## Muse handoff context",
    "This is a locally reviewed context note. The host session was not transferred automatically.",
    `Direction: ${direction}`,
    `Source: ${contextValue(plan.snapshot.sourceWorkspace, "unknown workspace")} (${contextValue(plan.snapshot.sourceBranch, "no branch")})`,
    `Target: ${contextValue(plan.snapshot.targetPath, "unknown target")} (${contextValue(plan.snapshot.targetBranch, "no branch")})`,
    "Checks:",
    ...plan.checks.map((item) => `- [${item.status}] ${contextValue(item.label, "check")}: ${contextValue(item.detail, "no detail")}`),
    "Review the working tree and confirm the intended transfer before making changes.",
  ];
  const excerpt = transcriptExcerpt(entries);
  if (excerpt.length > 0) {
    lines.push(
      "",
      "Conversation context (local excerpt; verify against the target workspace):",
      ...excerpt,
    );
  }
  const result = lines.join("\n");
  return result.length <= MAX_HANDOFF_CONTEXT
    ? result
    : `${result.slice(0, MAX_HANDOFF_CONTEXT - 1)}…`;
}

/**
 * The note a worktree continuation opens with.
 *
 * Deliberately not `formatHandoffContext`: that one describes a *plan* with
 * checks, and a one-gesture move has no plan. What it must not do is borrow the
 * plan's authority. So it states the three facts a person needs — this is a new
 * conversation, the old one did not move, and where the copy is — and nothing
 * else. Sending it is the user's decision; it lands in the composer.
 */
export function formatWorktreeContinuationNote(
  sourceWorkspace: string,
  targetPath: string,
  targetBranch: string,
): string {
  return [
    "## Continued in a worktree",
    "This is a new conversation in a copy of the project. The previous conversation was not moved or emptied; it is still where it was.",
    `Copy: ${contextValue(targetPath, "unknown path")} (${contextValue(targetBranch, "no branch")})`,
    `Original: ${contextValue(sourceWorkspace, "unknown workspace")}`,
    "Continue the work here, and check the copy before changing anything.",
  ].join("\n");
}