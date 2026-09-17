/**
 * Parse the host's durable `session/branchChanged` observation.
 *
 * Branch facts are host-owned. The renderer keeps only the bounded display
 * value and never infers a branch from the selected workspace or local Git
 * review state. Unknown additive fields are intentionally ignored.
 */
export interface BranchObservation {
  branch: string | null;
  vcs: string | null;
  workspaceRoot: string | null;
}

export function parseBranchObservation(payload: unknown): BranchObservation | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const rawBranch = row.branch;
  if (rawBranch !== undefined && rawBranch !== null && typeof rawBranch !== "string") return null;
  const branch = typeof rawBranch === "string" && rawBranch.trim().length > 0
    ? rawBranch.trim()
    : null;
  const rawVcs = row.vcs;
  if (rawVcs !== undefined && rawVcs !== null && typeof rawVcs !== "string") return null;
  const vcs = typeof rawVcs === "string" && rawVcs.trim().length > 0 ? rawVcs.trim() : null;
  const rawRoot = row.workspaceRoot ?? row.workspace_root;
  if (rawRoot !== undefined && rawRoot !== null && typeof rawRoot !== "string") return null;
  const workspaceRoot = typeof rawRoot === "string" && rawRoot.trim().length > 0
    ? rawRoot.trim()
    : null;
  return { branch, vcs, workspaceRoot };
}
