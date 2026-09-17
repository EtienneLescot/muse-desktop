import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHandoffPlan } from "../src/lib/handoff.ts";

const base = {
  direction: "local-to-worktree" as const,
  sourceWorkspace: "C:/repo",
  sourceBranch: "main",
  sourceChangedFiles: 0,
  sourceConflictedFiles: 0,
  targetPath: "C:/repo/.muse/worktrees/task-one",
  targetBranch: "task-one",
  targetExists: true,
};

describe("M2-05 handoff planner", () => {
  it("keeps an unobserved target cautious and ready for review", () => {
    const plan = buildHandoffPlan(base);
    assert.equal(plan.ready, true);
    assert.equal(plan.checks.find((item) => item.id === "target-status")?.status, "warn");
    assert.equal(plan.direction, "local-to-worktree");
    assert.equal(plan.steps.length, 4);
  });

  it("blocks missing targets and source conflicts", () => {
    const plan = buildHandoffPlan({
      ...base,
      targetExists: false,
      sourceConflictedFiles: 2,
    });
    assert.equal(plan.ready, false);
    assert.equal(plan.checks.filter((item) => item.status === "blocked").length, 2);
  });

  it("blocks a dirty or already-used target", () => {
    const plan = buildHandoffPlan({
      ...base,
      targetDirty: true,
      targetBranchInUse: true,
    });
    assert.equal(plan.ready, false);
    assert.match(
      plan.checks.find((item) => item.id === "target-status")?.detail ?? "",
      /uncommitted/,
    );
    assert.match(
      plan.checks.find((item) => item.id === "branch-lock")?.detail ?? "",
      /already checked out/,
    );
  });

  it("warns when source changes need an explicit snapshot", () => {
    const plan = buildHandoffPlan({ ...base, sourceChangedFiles: 3 });
    assert.equal(plan.ready, true);
    assert.equal(plan.checks.find((item) => item.id === "source-dirty")?.status, "warn");
  });
});
