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
}

export const EMPTY_GIT_REVIEW: GitReviewState = {
  status: null,
  diff: null,
  loading: false,
  error: null,
};

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
