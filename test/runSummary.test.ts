import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScheduleRunSummary, mergeScheduleRunSummary } from "../src/lib/runSummary.ts";

describe("scheduled run result summaries", () => {
  it("extracts a bounded headline, counts, files and outcomes", () => {
    const summary = buildScheduleRunSummary("session-1", [
      { id: "u", role: "user", text: "Review src/App.tsx" },
      { id: "t", role: "tool", text: "Approval completed" },
      { id: "a", role: "assistant", text: "Decision: keep the compact navigation.\nThe patch is ready." },
    ]);
    assert.equal(summary.totalItems, 3);
    assert.equal(summary.assistantMessages, 1);
    assert.equal(summary.toolEvents, 1);
    assert.deepEqual(summary.filesMentioned, ["src/App.tsx"]);
    assert.match(summary.headline, /Decision: keep/);
    assert.equal(summary.decisions.length, 2);
  });

  it("falls back to a useful completion headline without an assistant message", () => {
    const summary = buildScheduleRunSummary("session-2", [
      { id: "t", role: "tool", text: "Tool completed" },
    ]);
    assert.equal(summary.headline, "Tool completed");
    assert.equal(summary.assistantMessages, 0);
  });

  it("keeps only explicit next-step lines as bounded facts", () => {
    const summary = buildScheduleRunSummary("session-3", [
      { id: "a", role: "assistant", text: "Next steps: run the migration.\nTodo: review the generated diff.\nThis sentence should not become a task." },
      { id: "a2", role: "assistant", text: "Follow-up: ask the team to verify the deploy." },
    ]);
    assert.deepEqual(summary.nextSteps, [
      "run the migration.",
      "review the generated diff.",
      "ask the team to verify the deploy.",
    ]);
  });

  it("keeps explicit issues separate from decisions and next steps", () => {
    const summary = buildScheduleRunSummary("session-4", [
      {
        id: "a",
        role: "assistant",
        text: "Issue: the migration is blocked by a missing table.\nWarning: retry after the service starts.\nNext steps: apply the migration.",
      },
      {
        id: "a2",
        role: "assistant",
        text: "This sentence mentions an error but is not an issue label.",
      },
      {
        id: "failure",
        role: "system",
        text: "Muse could not complete this turn.",
        engineError: { kind: "provider", message: "rate limit reached" },
      },
    ]);
    assert.deepEqual(summary.issues, [
      "the migration is blocked by a missing table.",
      "retry after the service starts.",
      "provider: rate limit reached",
    ]);
    assert.deepEqual(summary.nextSteps, ["apply the migration."]);
  });

  it("merges host facts without replacing the local recap", () => {
    const summary = buildScheduleRunSummary("session-5", [
      { id: "a", role: "assistant", text: "Decision: keep the current plan." },
    ]);
    const merged = mergeScheduleRunSummary(summary, {
      issues: ["host reported a partial result"],
      nextSteps: ["Confirm the deployment"],
    });
    assert.match(merged.headline, /Decision: keep/);
    assert.deepEqual(merged.issues, ["host reported a partial result"]);
    assert.deepEqual(merged.nextSteps, ["Confirm the deployment"]);
  });
});
