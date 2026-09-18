import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { compareGitTurnSnapshot, type GitStatusSnapshot, type GitTurnSnapshot } from "../src/lib/git.ts";
import { dropGitTurnSnapshot, loadGitTurnSnapshot, saveGitTurnSnapshot } from "../src/lib/persist.ts";

function fakeStorage() {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  };
}

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

describe("turn comparison", () => {
  it("stays clean when the status fingerprint is unchanged", () => {
    assert.deepEqual(compareGitTurnSnapshot(snapshot(status()), status()), {
      changed: false,
      headChanged: false,
      statusChanged: false,
      changedPaths: [],
    });
  });

  it("lists added, removed and updated files without trusting text", () => {
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

  it("keeps head-only changes explicit even when no file row changed", () => {
    const result = compareGitTurnSnapshot(
      snapshot(status({ head: "old", fingerprint: "old" })),
      status({ head: "new", fingerprint: "new" }),
    );
    assert.equal(result.changed, true);
    assert.equal(result.headChanged, true);
    assert.deepEqual(result.changedPaths, []);
  });

  it("round-trips the latest snapshot through the namespaced store", () => {
    fakeStorage();
    const row = snapshot(status({ fingerprint: "persisted" }));
    saveGitTurnSnapshot("session-1", row);
    assert.deepEqual(loadGitTurnSnapshot("session-1"), row);
    dropGitTurnSnapshot("session-1");
    assert.equal(loadGitTurnSnapshot("session-1"), null);
  });
});

describe("turn snapshot persistence", () => {
  beforeEach(() => fakeStorage());

  it("rejects malformed snapshots without throwing", () => {
    const storage = (globalThis as Record<string, unknown>).localStorage as { setItem: (key: string, value: string) => void };
    storage.setItem("muse-desktop.git-turn.v1.session-1", JSON.stringify({ phase: "running" }));
    assert.equal(loadGitTurnSnapshot("session-1"), null);
  });
});
