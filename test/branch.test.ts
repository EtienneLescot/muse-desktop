import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBranchObservation } from "../src/lib/branch.ts";

describe("session/branchChanged observations", () => {
  it("keeps the host branch, vcs and workspace root", () => {
    assert.deepEqual(
      parseBranchObservation({
        branch: " feature/m1-user-shell ",
        vcs: "git",
        workspaceRoot: " C:\\repo ",
        viewCursor: "opaque",
      }),
      { branch: "feature/m1-user-shell", vcs: "git", workspaceRoot: "C:\\repo" },
    );
  });

  it("represents detached HEAD and missing optional metadata safely", () => {
    assert.deepEqual(parseBranchObservation({ branch: null }), {
      branch: null,
      vcs: null,
      workspaceRoot: null,
    });
    assert.deepEqual(parseBranchObservation({ branch: "   ", vcs: "   " }), {
      branch: null,
      vcs: null,
      workspaceRoot: null,
    });
  });

  it("accepts the compatibility snake_case workspace key", () => {
    assert.deepEqual(parseBranchObservation({ branch: "main", workspace_root: "/repo" }), {
      branch: "main",
      vcs: null,
      workspaceRoot: "/repo",
    });
  });

  it("fails closed for malformed scalar fields", () => {
    assert.equal(parseBranchObservation(null), null);
    assert.equal(parseBranchObservation({ branch: 42 }), null);
    assert.equal(parseBranchObservation({ vcs: {} }), null);
    assert.equal(parseBranchObservation({ workspaceRoot: [] }), null);
  });
});
