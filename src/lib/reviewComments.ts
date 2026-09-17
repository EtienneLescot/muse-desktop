import type {
  GitDiffFile,
  GitDiffHunk,
  GitDiffScope,
  GitDiffSnapshot,
  GitStatusSnapshot,
} from "./git";
import { readStorageJson, writeStorageJson } from "./storage.ts";

export type ReviewSide = "old" | "new";

export interface ReviewPatchLine {
  key: string;
  prefix: " " | "+" | "-";
  text: string;
  side: ReviewSide;
  oldLine: number | null;
  newLine: number | null;
  hunk: string;
}

export interface ReviewAnchor {
  repoRoot: string;
  revision: string;
  scope: GitDiffScope;
  baseRef: string | null;
  path: string;
  oldPath: string | null;
  side: ReviewSide;
  line: number;
  hunk: string;
}

export type ReviewCommentStatus = "draft" | "ready" | "sent" | "stale";

export interface ReviewComment {
  id: string;
  anchor: ReviewAnchor;
  body: string;
  status: ReviewCommentStatus;
  createdAt: number;
  updatedAt: number;
}

/** Keep review notes useful without allowing a blocked webview to grow storage forever. */
export const REVIEW_COMMENT_LIMIT = 40;
export const REVIEW_COMMENT_BODY_LIMIT = 8_000;
const REVIEW_COMMENT_KEY_PREFIX = "muse-desktop.review-comments.v1.";
let nextCommentSequence = 0;

function reviewCommentKey(sessionId: string): string {
  return `${REVIEW_COMMENT_KEY_PREFIX}${encodeURIComponent(sessionId).slice(0, 180)}`;
}

function validAnchor(value: unknown): value is ReviewAnchor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.repoRoot === "string" &&
    typeof candidate.revision === "string" &&
    (candidate.scope === "unstaged" || candidate.scope === "staged" || candidate.scope === "branch") &&
    (candidate.baseRef === null || typeof candidate.baseRef === "string") &&
    typeof candidate.path === "string" &&
    (candidate.oldPath === null || typeof candidate.oldPath === "string") &&
    (candidate.side === "old" || candidate.side === "new") &&
    Number.isInteger(candidate.line) &&
    typeof candidate.hunk === "string"
  );
}

function validComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    validAnchor(candidate.anchor) &&
    typeof candidate.body === "string" &&
    candidate.body.length <= REVIEW_COMMENT_BODY_LIMIT &&
    (candidate.status === "draft" || candidate.status === "ready" || candidate.status === "sent" || candidate.status === "stale") &&
    Number.isFinite(candidate.createdAt) &&
    Number.isFinite(candidate.updatedAt)
  );
}

function anchorKey(anchor: ReviewAnchor): string {
  return [
    anchor.repoRoot,
    anchor.revision,
    anchor.scope,
    anchor.baseRef ?? "",
    anchor.path,
    anchor.oldPath ?? "",
    anchor.side,
    String(anchor.line),
    anchor.hunk,
  ].join("\u001f");
}

/** Stable identity for queue de-duplication and UI selection. */
export function sameReviewAnchor(left: ReviewAnchor, right: ReviewAnchor): boolean {
  return anchorKey(left) === anchorKey(right);
}

function newCommentId(now: number): string {
  nextCommentSequence = (nextCommentSequence + 1) % 10_000;
  return `review-${now.toString(36)}-${nextCommentSequence.toString(36)}`;
}

/** Read the session-scoped review queue through the defensive storage facade. */
export function loadReviewComments(sessionId: string): ReviewComment[] {
  if (!sessionId.trim()) return [];
  const raw = readStorageJson<unknown>(reviewCommentKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(validComment)
    .map((comment) => ({
      ...comment,
      body: comment.body.slice(0, REVIEW_COMMENT_BODY_LIMIT),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, REVIEW_COMMENT_LIMIT);
}

/** Persist a bounded queue. A failed write leaves the previous snapshot intact. */
export function saveReviewComments(sessionId: string, comments: ReviewComment[]): boolean {
  if (!sessionId.trim()) return false;
  const bounded = comments
    .filter(validComment)
    .map((comment) => ({
      ...comment,
      body: comment.body.trim().slice(0, REVIEW_COMMENT_BODY_LIMIT),
    }))
    .filter((comment) => comment.body.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, REVIEW_COMMENT_LIMIT);
  return writeStorageJson(reviewCommentKey(sessionId), bounded);
}

/** Add or update a comment on the same anchored line without creating duplicates. */
export function upsertReviewComment(
  comments: ReviewComment[],
  anchor: ReviewAnchor,
  body: string,
  now = Date.now(),
): ReviewComment[] {
  const trimmed = body.trim().slice(0, REVIEW_COMMENT_BODY_LIMIT);
  if (!trimmed) return comments;
  const key = anchorKey(anchor);
  const existing = comments.find((comment) => anchorKey(comment.anchor) === key && comment.status !== "sent");
  const next = existing
    ? comments.map((comment) =>
        comment.id === existing.id
          ? { ...comment, anchor, body: trimmed, status: "ready" as const, updatedAt: now }
          : comment,
      )
    : [
        ...comments,
        {
          id: newCommentId(now),
          anchor,
          body: trimmed,
          status: "ready" as const,
          createdAt: now,
          updatedAt: now,
        },
      ];
  return next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, REVIEW_COMMENT_LIMIT);
}

export function updateReviewComment(
  comments: ReviewComment[],
  id: string,
  patch: Partial<Pick<ReviewComment, "body" | "status">>,
  now = Date.now(),
): ReviewComment[] {
  return comments
    .map((comment) =>
      comment.id === id
        ? {
            ...comment,
            ...(patch.body === undefined ? {} : { body: patch.body.trim().slice(0, REVIEW_COMMENT_BODY_LIMIT) }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            updatedAt: now,
          }
        : comment,
    )
    .filter((comment) => comment.body.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function removeReviewComment(comments: ReviewComment[], id: string): ReviewComment[] {
  return comments.filter((comment) => comment.id !== id);
}

/** Mark only actionable notes stale when the fresh repository snapshot no longer contains their anchor. */
export function reconcileReviewComments(
  comments: ReviewComment[],
  status: GitStatusSnapshot | null,
  diff: GitDiffSnapshot | null,
): ReviewComment[] {
  if (!status || !diff) return comments;
  return comments.map((comment) => {
    if (comment.status === "sent") return comment;
    const fresh = anchorMatchesDiff(comment.anchor, status, diff);
    const statusNext: ReviewCommentStatus = fresh
      ? comment.status === "stale" ? "ready" : comment.status
      : "stale";
    return statusNext === comment.status ? comment : { ...comment, status: statusNext, updatedAt: Date.now() };
  });
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkRange(hunk: GitDiffHunk, side: ReviewSide): [number, number] {
  return side === "old"
    ? [hunk.oldStart, hunk.oldStart + Math.max(hunk.oldLines, 1) - 1]
    : [hunk.newStart, hunk.newStart + Math.max(hunk.newLines, 1) - 1];
}

function fileHeaderMatches(line: string, file: GitDiffFile): boolean {
  const target = ` b/${file.path}`;
  return line.endsWith(target) || line.endsWith(` b/"${file.path}"`);
}

/**
 * Turn one file section of a unified patch into selectable source rows. The
 * parser keeps old/new coordinates separate, so a comment on a deletion is
 * anchored to the old side while context/additions use the new side.
 */
export function patchLinesForFile(
  patch: string,
  file: GitDiffFile,
): ReviewPatchLine[] {
  const rows: ReviewPatchLine[] = [];
  let active = false;
  let oldLine = 0;
  let newLine = 0;
  let hunk = "";
  let rowIndex = 0;

  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      active = fileHeaderMatches(line, file);
      continue;
    }
    if (!active) continue;
    const match = HUNK_RE.exec(line);
    if (match) {
      hunk = line;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      continue;
    }
    if (hunk === "" || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const prefix = line[0] as " " | "+" | "-";
    if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
    const old = prefix === "+" ? null : oldLine;
    const next = prefix === "-" ? null : newLine;
    const side: ReviewSide = prefix === "-" ? "old" : "new";
    rows.push({
      key: `${file.path}:${rowIndex++}:${side}:${old ?? next ?? 0}`,
      prefix,
      text: line.slice(1),
      side,
      oldLine: old,
      newLine: next,
      hunk,
    });
    if (prefix !== "+") oldLine += 1;
    if (prefix !== "-") newLine += 1;
  }
  return rows;
}

export function createReviewAnchor(
  status: GitStatusSnapshot,
  diff: GitDiffSnapshot,
  file: GitDiffFile,
  row: ReviewPatchLine,
): ReviewAnchor {
  return {
    repoRoot: status.repoRoot,
    revision: status.head ?? "",
    scope: diff.scope,
    baseRef: diff.baseRef,
    path: file.path,
    oldPath: file.oldPath,
    side: row.side,
    line: row.side === "old" ? row.oldLine ?? 0 : row.newLine ?? 0,
    hunk: row.hunk,
  };
}

/** Return true only if the exact file/hunk/side/line still exists. */
export function anchorMatchesDiff(
  anchor: ReviewAnchor,
  status: GitStatusSnapshot,
  diff: GitDiffSnapshot,
): boolean {
  if (anchor.repoRoot !== status.repoRoot || anchor.revision !== (status.head ?? "")) {
    return false;
  }
  if (
    anchor.scope !== diff.scope ||
    anchor.baseRef !== diff.baseRef ||
    anchor.repoRoot !== diff.repoRoot
  ) {
    return false;
  }
  const file = diff.files.find((candidate) => candidate.path === anchor.path);
  if (!file) return false;
  return file.hunks.some((hunk) => {
    if (hunk.header !== anchor.hunk) return false;
    const [start, end] = hunkRange(hunk, anchor.side);
    return anchor.line >= start && anchor.line <= end;
  });
}

/** Convert an anchor into explicit context that can safely enter a turn. */
export function formatReviewComment(anchor: ReviewAnchor, body: string): string {
  const trimmed = body.trim();
  return [
    "Review comment on the current Git diff:",
    `Repository: ${anchor.repoRoot}`,
    `Revision: ${anchor.revision || "unknown"}`,
    `Scope: ${anchor.scope}${anchor.baseRef ? ` (base ${anchor.baseRef})` : ""}`,
    `File: ${anchor.path}${anchor.oldPath ? ` (renamed from ${anchor.oldPath})` : ""}`,
    `Side: ${anchor.side} line ${anchor.line}`,
    `Hunk: ${anchor.hunk}`,
    "",
    trimmed,
  ].join("\n");
}
