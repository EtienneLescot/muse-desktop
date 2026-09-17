import type {
  GitDiffFile,
  GitDiffHunk,
  GitDiffScope,
  GitDiffSnapshot,
  GitStatusSnapshot,
} from "./git";

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
