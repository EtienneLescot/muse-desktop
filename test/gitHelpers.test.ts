import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGitTurnSnapshot,
  shortRepoName,
  statusCode,
  type GitStatusFile,
  type GitStatusSnapshot,
  type GitTurnSnapshot,
} from "../src/lib/git.ts";

function file(overrides: Partial<GitStatusFile> = {}): GitStatusFile {
  return {
    path: "src/app.ts",
    originalPath: null,
    indexStatus: "M",
    worktreeStatus: "M",
    changeType: "modified",
    staged: true,
    unstaged: true,
    untracked: false,
    conflicted: false,
    binary: false,
    ...overrides,
  };
}

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: "C:/work/app",
    branch: "main",
    head: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    fingerprint: "fp-1",
    remotes: [],
    files: [],
    observedAt: 1000,
    ...overrides,
  };
}

function turn(snap: GitStatusSnapshot): GitTurnSnapshot {
  return {
    clientMessageId: "client-1",
    turnId: "turn-1",
    capturedAt: 900,
    phase: "completed",
    status: snap,
  };
}

test("statusCode returns ?? for untracked files", () => {
  assert.equal(
    statusCode(file({ untracked: true, indexStatus: "?", worktreeStatus: "?" })),
    "??",
  );
});

test("statusCode keeps the two git columns clear", () => {
  assert.equal(statusCode(file({ indexStatus: "M", worktreeStatus: " " })), "M ");
  assert.equal(statusCode(file({ indexStatus: " ", worktreeStatus: "D" })), " D");
});

test("shortRepoName returns the last path segment", () => {
  assert.equal(shortRepoName("C:\\Users\\etien\\repos\\muse-desktop"), "muse-desktop");
  assert.equal(shortRepoName("/home/ava/repos/muse-desktop/"), "muse-desktop");
  assert.equal(shortRepoName("muse-desktop"), "muse-desktop");
});

test("compareGitTurnSnapshot reports no change for identical status", () => {
  const snap = status({ files: [file()] });
  const result = compareGitTurnSnapshot(turn(snap), status({ files: [file()] }));
  assert.equal(result.changed, false);
  assert.equal(result.headChanged, false);
  assert.equal(result.statusChanged, false);
  assert.deepEqual(result.changedPaths, []);
});

test("compareGitTurnSnapshot lists added and removed paths", () => {
  const before = status({ files: [file()] });
  const after = status({
    fingerprint: "fp-2",
    files: [file({ path: "src/other.ts", indexStatus: "A", worktreeStatus: " " })],
  });
  const result = compareGitTurnSnapshot(turn(before), after);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedPaths, ["src/app.ts", "src/other.ts"]);
});

test("compareGitTurnSnapshot flags head changes separately", () => {
  const before = status({ head: "abc123" });
  const result = compareGitTurnSnapshot(turn(before), status({ head: "def456" }));
  assert.equal(result.headChanged, true);
  assert.equal(result.changed, true);
});
