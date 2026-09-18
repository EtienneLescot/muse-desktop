/** Read-only Git review contracts shared by the hook and Review panel. */

export type GitDiffScope = "unstaged" | "staged" | "branch";

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitStatusFile {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  changeType: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  binary: boolean;
}

export interface GitStatusSnapshot {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  fingerprint: string;
  remotes: GitRemote[];
  files: GitStatusFile[];
  observedAt: number;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface GitDiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
}

export interface GitDiffSnapshot {
  repoRoot: string;
  scope: GitDiffScope;
  baseRef: string | null;
  patch: string;
  patchTruncated: boolean;
  files: GitDiffFile[];
  observedAt: number;
}

export interface GitReviewState {
  status: GitStatusSnapshot | null;
  diff: GitDiffSnapshot | null;
  loading: boolean;
  error: string | null;
}

/**
 * Explicit repository observation captured immediately before a logical turn
 * is admitted. The snapshot is metadata only; it never guesses a diff from
 * assistant text and remains useful when the host does not expose turn files.
 */
export type GitTurnPhase = "captured" | "running" | "queued" | "completed" | "failed";

export interface GitTurnSnapshot {
  clientMessageId: string;
  turnId: string | null;
  capturedAt: number;
  phase: GitTurnPhase;
  status: GitStatusSnapshot;
}

export interface GitTurnComparison {
  changed: boolean;
  headChanged: boolean;
  statusChanged: boolean;
  changedPaths: string[];
}

/** Exact observation sent with a mutating Review action. */
export interface GitMutationExpectation {
  head: string | null;
  statusFingerprint: string;
  /** Null when the displayed patch was bounded and cannot be compared safely. */
  patch: string | null;
}

export interface GitCommitResult {
  hash: string;
  branch: string | null;
  subject: string;
}

export interface GitPushResult {
  remote: string;
  branch: string;
  head: string;
}

export interface GitPrResult {
  url: string;
  base: string;
  head: string;
  existing: boolean;
}

export const EMPTY_GIT_REVIEW: GitReviewState = {
  status: null,
  diff: null,
  loading: false,
  error: null,
};

/** Compare a captured turn baseline with a fresh status observation. */
export function compareGitTurnSnapshot(
  snapshot: GitTurnSnapshot,
  current: GitStatusSnapshot,
): GitTurnComparison {
  const before = new Map(
    snapshot.status.files.map((file) => [
      `${file.path}\u0000${file.originalPath ?? ""}`,
      JSON.stringify(file),
    ]),
  );
  const after = new Map(
    current.files.map((file) => [
      `${file.path}\u0000${file.originalPath ?? ""}`,
      JSON.stringify(file),
    ]),
  );
  const changedPaths = new Set<string>();
  for (const [key, value] of before) {
    if (after.get(key) !== value) changedPaths.add(key.split("\u0000", 1)[0]);
  }
  for (const [key, value] of after) {
    if (before.get(key) !== value) changedPaths.add(key.split("\u0000", 1)[0]);
  }
  const headChanged = snapshot.status.head !== current.head;
  const statusChanged = snapshot.status.fingerprint !== current.fingerprint;
  return {
    changed: headChanged || statusChanged,
    headChanged,
    statusChanged,
    changedPaths: Array.from(changedPaths).sort((a, b) => a.localeCompare(b)),
  };
}

/** A compact status label for a file row, keeping the two Git columns clear. */
export function statusCode(file: GitStatusFile): string {
  if (file.untracked) return "??";
  return `${file.indexStatus}${file.worktreeStatus}`;
}

/** Avoid exposing a full absolute path in the compact file-list subtitle. */
export function shortRepoName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}
