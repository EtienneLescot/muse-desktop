import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anchorMatchesDiff,
  createReviewAnchor,
  formatReviewComment,
  patchLinesForFile,
  type ReviewPatchLine,
} from "../src/lib/reviewComments.ts";
import type { GitDiffFile, GitDiffSnapshot, GitStatusSnapshot } from "../src/lib/git.ts";

const file: GitDiffFile = {
  path: "src/app.ts",
  oldPath: null,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: "@@ -4,2 +4,2 @@ function run()",
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
    },
  ],
};

const status: GitStatusSnapshot = {
  repoRoot: "/repo",
  branch: "main",
  head: "abc123",
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  observedAt: 1,
};

const diff: GitDiffSnapshot = {
  repoRoot: "/repo",
  scope: "unstaged",
  baseRef: null,
  patch:
    "diff --git a/src/app.ts b/src/app.ts\n" +
    "--- a/src/app.ts\n" +
    "+++ b/src/app.ts\n" +
    "@@ -4,2 +4,2 @@ function run()\n" +
    " keep\n-old\n+new\n",
  patchTruncated: false,
  files: [file],
  observedAt: 2,
};

describe("review diff comments", () => {
  it("keeps old/new coordinates for selectable rows", () => {
    const rows = patchLinesForFile(diff.patch, file);
    assert.deepEqual(
      rows.map((row) => [row.prefix, row.side, row.oldLine, row.newLine]),
      [
        [" ", "new", 4, 4],
        ["-", "old", 5, null],
        ["+", "new", null, 5],
      ],
    );
  });

  it("formats an explicit review context", () => {
    const row = patchLinesForFile(diff.patch, file)[1] as ReviewPatchLine;
    const anchor = createReviewAnchor(status, diff, file, row);
    assert.match(formatReviewComment(anchor, "Please keep this branch safe."), /Side: old line 5/);
    assert.match(formatReviewComment(anchor, "Please keep this branch safe."), /Please keep/);
  });

  it("rejects a moved or changed anchor", () => {
    const row = patchLinesForFile(diff.patch, file)[2] as ReviewPatchLine;
    const anchor = createReviewAnchor(status, diff, file, row);
    assert.equal(anchorMatchesDiff(anchor, status, diff), true);
    assert.equal(
      anchorMatchesDiff(anchor, { ...status, head: "different" }, diff),
      false,
    );
    assert.equal(
      anchorMatchesDiff(anchor, status, { ...diff, patch: "", files: [] }),
      false,
    );
  });
});
