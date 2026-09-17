import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anchorMatchesDiff,
  createReviewAnchor,
  formatReviewComment,
  loadReviewComments,
  patchLinesForFile,
  reconcileReviewComments,
  removeReviewComment,
  saveReviewComments,
  type ReviewPatchLine,
  updateReviewComment,
  upsertReviewComment,
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
  fingerprint: "status-1",
  remotes: [],
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

function fakeStorage() {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  return values;
}

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

  it("deduplicates an anchored draft and persists it per session", () => {
    fakeStorage();
    const row = patchLinesForFile(diff.patch, file)[2] as ReviewPatchLine;
    const anchor = createReviewAnchor(status, diff, file, row);
    let comments = upsertReviewComment([], anchor, "First wording", 10);
    comments = upsertReviewComment(comments, anchor, "Refined wording", 20);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.body, "Refined wording");
    assert.equal(saveReviewComments("session-a", comments), true);
    assert.equal(loadReviewComments("session-a")[0]?.body, "Refined wording");
    assert.deepEqual(loadReviewComments("session-b"), []);
  });

  it("marks only unsent notes stale and can triage them", () => {
    const row = patchLinesForFile(diff.patch, file)[2] as ReviewPatchLine;
    const anchor = createReviewAnchor(status, diff, file, row);
    const sent = { ...upsertReviewComment([], anchor, "Already sent", 10)[0], status: "sent" as const };
    const ready = upsertReviewComment([sent], { ...anchor, line: 99 }, "Needs refresh", 20)[0];
    assert.ok(ready);
    const reconciled = reconcileReviewComments([sent, ready], status, diff);
    assert.equal(reconciled.find((comment) => comment.id === sent.id)?.status, "sent");
    assert.equal(reconciled.find((comment) => comment.id === ready?.id)?.status, "stale");
    const updated = updateReviewComment(reconciled, ready.id, { status: "ready" }, 30);
    assert.equal(updated.find((comment) => comment.id === ready.id)?.status, "ready");
    assert.equal(removeReviewComment(updated, sent.id).some((comment) => comment.id === sent.id), false);
  });
});
