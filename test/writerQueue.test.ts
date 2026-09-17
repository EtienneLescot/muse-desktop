import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWriterPath,
  parseWriterPaths,
  planWriterQueue,
} from "../src/lib/writerQueue.ts";

describe("writer target paths", () => {
  it("normalizes separators and rejects escapes or absolute paths", () => {
    assert.equal(normalizeWriterPath(" ./Src\\App.tsx "), "src/app.tsx");
    assert.equal(normalizeWriterPath("../secrets.env"), null);
    assert.equal(normalizeWriterPath("C:/outside.ts"), null);
    assert.equal(normalizeWriterPath("C:relative.ts"), null);
  });

  it("parses bounded unique paths and reports invalid entries", () => {
    const parsed = parseWriterPaths("src/App.tsx, src/app.tsx; ../bad");
    assert.deepEqual(parsed.paths, ["src/app.tsx"]);
    assert.deepEqual(parsed.invalid, ["../bad"]);
  });
});

describe("writer queue planning", () => {
  it("blocks overlapping files instead of assigning lanes", () => {
    const plan = planWriterQueue(
      [
        { agent: "one", worktreePath: "a", hasWorktree: true, targetPaths: ["src/app.tsx"] },
        { agent: "two", worktreePath: "b", hasWorktree: true, targetPaths: ["src/App.tsx"] },
      ],
      4,
    );
    assert.equal(plan.conflicts, 2);
    assert.equal(plan.rows[0]?.status, "conflict");
    assert.deepEqual(plan.rows[0]?.conflictsWith, ["two"]);
    assert.equal(plan.rows[1]?.status, "conflict");
  });

  it("requires a worktree and declared files, then queues FIFO beyond lanes", () => {
    const plan = planWriterQueue(
      [
        { agent: "missing", worktreePath: "m", hasWorktree: false, targetPaths: ["a"] },
        { agent: "no-files", worktreePath: "n", hasWorktree: true, targetPaths: [] },
        { agent: "one", worktreePath: "1", hasWorktree: true, targetPaths: ["a"] },
        { agent: "two", worktreePath: "2", hasWorktree: true, targetPaths: ["b"] },
        { agent: "three", worktreePath: "3", hasWorktree: true, targetPaths: ["c"] },
      ],
      2,
    );
    assert.equal(plan.blocked, 1);
    assert.equal(plan.needsPaths, 1);
    assert.equal(plan.ready, 2);
    assert.equal(plan.queued, 1);
    assert.equal(plan.rows[4]?.queuePosition, 1);
  });
});
