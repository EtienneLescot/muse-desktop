import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHandoffPlan, formatHandoffContext, isHandoffPlanStale } from "../src/lib/handoff.ts";

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

  it("keeps ignored target artifacts visible without blocking the plan", () => {
    const plan = buildHandoffPlan({ ...base, targetIgnoredFiles: 2 });
    assert.equal(plan.ready, true);
    assert.equal(plan.checks.find((item) => item.id === "target-ignored")?.status, "warn");
    assert.match(
      plan.checks.find((item) => item.id === "target-ignored")?.detail ?? "",
      /2 ignored/,
    );
  });

  it("keeps the reverse direction explicit in the transfer steps", () => {
    const plan = buildHandoffPlan({
      ...base,
      direction: "worktree-to-local",
      sourceWorkspace: base.targetPath,
      sourceBranch: base.targetBranch,
      targetPath: base.sourceWorkspace,
      targetBranch: base.sourceBranch,
    });
    assert.equal(plan.direction, "worktree-to-local");
    assert.match(plan.steps.at(-1) ?? "", /Local/);
    assert.equal(plan.snapshot.direction, "worktree-to-local");
  });

  it("captures the inspected target state and detects a changed source", () => {
    const plan = buildHandoffPlan({
      ...base,
      targetDirty: false,
      targetIgnoredFiles: 1,
      targetBranchInUse: false,
    });
    assert.equal(plan.snapshot.targetDirty, false);
    assert.equal(plan.snapshot.targetIgnoredFiles, 1);
    assert.equal(plan.snapshot.targetBranchInUse, false);
    assert.equal(isHandoffPlanStale(plan, {
      ...base,
      targetDirty: false,
      targetIgnoredFiles: 1,
      targetBranchInUse: false,
    }), false);
    assert.equal(isHandoffPlanStale(plan, {
      ...base,
      sourceChangedFiles: 1,
      targetDirty: false,
      targetIgnoredFiles: 1,
      targetBranchInUse: false,
    }), true);
  });

  it("formats a bounded, explicit context note without claiming a host transfer", () => {
    const context = formatHandoffContext(buildHandoffPlan(base));
    assert.match(context, /locally reviewed context note/);
    assert.match(context, /Local → Worktree/);
    assert.match(context, /C:\/repo/);
    assert.ok(context.length <= 4_000);
  });

  it("includes only a bounded user and Muse excerpt in the handoff note", () => {
    const context = formatHandoffContext(buildHandoffPlan(base), [
      { role: "system", text: "internal protocol payload must stay local" },
      { role: "user", text: "Please inspect the release pipeline." },
      { role: "assistant", text: "I found the installer manifest and will verify it." },
    ]);
    assert.match(context, /Conversation context \(local excerpt/);
    assert.match(context, /You: Please inspect the release pipeline\./);
    assert.match(context, /Muse: I found the installer manifest/);
    assert.doesNotMatch(context, /internal protocol payload/);
  });

  it("treats a newly observed target as a stale plan", () => {
    const plan = buildHandoffPlan(base);
    assert.equal(isHandoffPlanStale(plan, { ...base, targetDirty: false }), true);
  });
});
