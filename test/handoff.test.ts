import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeHandoffResult,
  formatHandoffContext,
  handoffQuestion,
  type HandoffPreview,
} from "../src/lib/handoff.ts";

const preview: HandoffPreview = {
  source: "\\\\?\\C:\\repo",
  target: "\\\\?\\C:\\repo\\.muse\\worktrees\\task-one",
  tracked: 2,
  untracked: 1,
  ignored: 3,
  conflicts: [],
  snapshot: null,
  sameSession: true,
};

describe("M2-05 handoff wording", () => {
  it("blocks a move that would conflict and names the files", () => {
    const question = handoffQuestion({ ...preview, conflicts: ["src/a.ts", "b.txt"] }, "Local");
    assert.equal(question.blocked, true);
    assert.match(question.text, /Nothing was moved: 2 files would conflict in Local \(src\/a\.ts, b\.txt\)/);
  });

  it("asks with the counts, the ignored files left behind and what the conversation does", () => {
    const same = handoffQuestion(preview, "a new worktree");
    assert.equal(same.blocked, false);
    assert.match(same.text, /2 changed files/);
    assert.match(same.text, /1 untracked file\b/);
    assert.match(same.text, /3 ignored items left where they are/);
    assert.match(same.text, /The conversation moves with them/);
    const old = handoffQuestion({ ...preview, sameSession: false }, "a new worktree");
    assert.match(old.text, /cannot move a conversation: a new one opens there/);
  });

  it("records the move without claiming an old host moved the conversation", () => {
    const moved = describeHandoffResult({ ...preview, snapshot: "refs/muse/handoff/1" });
    assert.match(moved, /to C:\\repo\\\.muse\\worktrees\\task-one/);
    assert.match(moved, /now runs there/);
    assert.match(moved, /refs\/muse\/handoff\/1/);
    const stayed = describeHandoffResult({ ...preview, sameSession: false });
    assert.match(stayed, /This conversation stays here/);
    assert.doesNotMatch(stayed, /now runs there/);
  });

  it("opens a new conversation with a bounded note and only user and Muse lines", () => {
    const context = formatHandoffContext({ ...preview, sameSession: false }, [
      { role: "system", text: "internal protocol payload must stay local" },
      { role: "user", text: "Please inspect the release pipeline." },
      { role: "assistant", text: "I found the installer manifest and will verify it." },
      ...Array.from({ length: 40 }, () => ({ role: "user", text: "x".repeat(400) })),
    ]);
    assert.match(context, /previous conversation was not moved/);
    assert.match(context, /From: C:\\repo\n/);
    assert.doesNotMatch(context, /internal protocol payload/);
    assert.ok(context.length <= 4_000);
  });
});
