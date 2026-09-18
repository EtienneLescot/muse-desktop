import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScheduleRunSummary } from "../src/lib/runSummary.ts";

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
});
