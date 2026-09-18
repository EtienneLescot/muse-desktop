import assert from "node:assert/strict";
import test from "node:test";
import { compareGitTurnSnapshot, type GitStatusSnapshot, type GitTurnSnapshot } from "../src/lib/git.ts";

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: "C:/repo",
    branch: "main",
    head: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    fingerprint: "same",
    remotes: [],
    files: [],
    observedAt: 100,
    ...overrides,
  };
}

function snapshot(before: GitStatusSnapshot): GitTurnSnapshot {
  return {
    clientMessageId: "client-1",
    turnId: "turn-1",
    capturedAt: 100,
    phase: "completed",
    status: before,
  };
}

test("turn comparison stays clean when the status fingerprint is unchanged", () => {
  assert.deepEqual(compareGitTurnSnapshot(snapshot(status()), status()), {
    changed: false,
    headChanged: false,
    statusChanged: false,
    changedPaths: [],
  });
});

test("turn comparison lists added, removed and updated files without trusting text", () => {
  const before = status({
    fingerprint: "before",
    files: [{
      path: "src/old.ts",
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: "M",
      changeType: "modified",
      staged: false,
      unstaged: true,
      untracked: false,
      conflicted: false,
      binary: false,
    }],
  });
  const after = status({
    fingerprint: "after",
    files: [{
      path: "src/new.ts",
      originalPath: null,
      indexStatus: "?",
      worktreeStatus: "?",
      changeType: "untracked",
      staged: false,
      unstaged: false,
      untracked: true,
      conflicted: false,
      binary: false,
    }],
  });
  assert.deepEqual(compareGitTurnSnapshot(snapshot(before), after), {
    changed: true,
    headChanged: false,
    statusChanged: true,
    changedPaths: ["src/new.ts", "src/old.ts"],
  });
});

test("head-only changes remain explicit even when no file row changed", () => {
  const result = compareGitTurnSnapshot(
    snapshot(status({ head: "old", fingerprint: "old" })),
    status({ head: "new", fingerprint: "new" }),
  );
  assert.equal(result.changed, true);
  assert.equal(result.headChanged, true);
  assert.deepEqual(result.changedPaths, []);
});
