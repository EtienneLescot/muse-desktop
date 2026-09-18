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
  return { direction: input.direction, ready, checks, steps };
}
