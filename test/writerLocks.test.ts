import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireWriterLock,
  listWriterLocks,
  releaseWriterLock,
  releaseWriterLocksForWorkspace,
} from "../src/lib/writerLocks.ts";

describe("writer leases", () => {
  it("refuses overlapping files in the same workspace", () => {
    const first = acquireWriterLock("C:/repo", "writer-a", ["src/app.ts"], 10);
    assert.ok(first.lock);
    const second = acquireWriterLock("c:\\repo\\", "writer-b", ["src"], 11);
    assert.equal(second.lock, null);
    assert.deepEqual(second.conflicts.map((item) => item.agent), ["writer-a"]);
    releaseWriterLock(first.lock.token);
  });

  it("keeps workspaces isolated and normalizes duplicate targets", () => {
    const first = acquireWriterLock("C:/repo-a", "writer-a", ["./README.md", "README.md"], 20);
    const second = acquireWriterLock("C:/repo-b", "writer-b", ["README.md"], 21);
    assert.ok(first.lock);
    assert.ok(second.lock);
    assert.deepEqual(first.lock.targetPaths, ["readme.md"]);
    assert.equal(listWriterLocks("C:/repo-a").length, 1);
    releaseWriterLocksForWorkspace("C:/repo-a");
    releaseWriterLock(second.lock.token);
    assert.equal(listWriterLocks().length, 0);
  });

  it("releases leases idempotently", () => {
    const result = acquireWriterLock("repo", "writer", ["a.txt"], 30);
    assert.ok(result.lock);
    assert.equal(releaseWriterLock(result.lock.token), true);
    assert.equal(releaseWriterLock(result.lock.token), false);
  });
});
