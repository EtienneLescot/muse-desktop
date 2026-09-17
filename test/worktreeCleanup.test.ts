import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearWorktreeCleanup,
  markWorktreeCleanupFailed,
  requestWorktreeCleanup,
} from "../src/lib/worktreeCleanup.ts";

const record = { repoRoot: "C:/repo", path: "C:/repo/.muse/worktrees/a", branch: "task-a" };

describe("worktree cleanup recovery", () => {
  it("records an explicit pending intent and increments attempts on retry", () => {
    const first = requestWorktreeCleanup([], record, 100);
    assert.deepEqual(first[0], { ...record, requestedAt: 100, attempts: 1, status: "pending" });
    const second = requestWorktreeCleanup(first, record, 200);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.attempts, 2);
    assert.equal(second[0]?.requestedAt, 200);
  });

  it("keeps a bounded failure visible until a successful retry clears it", () => {
    const failed = markWorktreeCleanupFailed(
      requestWorktreeCleanup([], record, 100),
      record,
      "dirty worktree\nwith details",
    );
    assert.equal(failed[0]?.status, "failed");
    assert.equal(failed[0]?.error, "dirty worktree with details");
    assert.equal(clearWorktreeCleanup(failed, record).length, 0);
  });
});
