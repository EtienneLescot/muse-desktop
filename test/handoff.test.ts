import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeHandoffResult,
  describeWorkspaceFallback,
  formatHandoffContext,
  handoffQuestion,
  userShellBlocked,
  type HandoffPreview,
} from "../src/lib/handoff.ts";

const preview: HandoffPreview = {
  source: "\\\\?\\C:\\repo",
  target: "\\\\?\\C:\\repo\\.muse\\worktrees\\task-one",
  tracked: 2,
  untracked: 1,
  ignored: 3,
  partlyStaged: [],
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
    assert.match(same.text, /all the uncommitted work in this folder/);
    assert.match(same.text, /2 changed files/);
    assert.match(same.text, /1 untracked file\b/);
    assert.match(same.text, /3 ignored items left where they are/);
    assert.match(same.text, /The conversation moves with them/);
    const old = handoffQuestion({ ...preview, sameSession: false }, "a new worktree");
    assert.match(old.text, /cannot move a conversation: a new one opens there/);
  });

  it("names the files whose staged version will not move", () => {
    assert.doesNotMatch(handoffQuestion(preview, "Local").text, /after staging/);
    const question = handoffQuestion({ ...preview, partlyStaged: ["src/a.ts"] }, "Local");
    assert.equal(question.blocked, false);
    assert.match(question.text, /1 file changed again after staging \(src\/a\.ts\): the file moves as it is now; the staged version stays only in the snapshot/);
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

  it("reports the files as moved when only the conversation could not follow", () => {
    const text = describeHandoffResult({ ...preview, sameSession: false, sessionError: "conversation metadata is unavailable" });
    assert.match(text, /^Moved 2 changed files/);
    assert.match(text, /could not follow: conversation metadata is unavailable/);
    assert.match(text, /new conversation there/);
  });

  it("turns Run in Muse off only while the conversation is away from its host's folder", () => {
    const host = "\\\\?\\C:\\repo";
    const moved = userShellBlocked({ workspace: "\\\\?\\C:\\repo\\.muse\\worktrees\\x", host_workspace: host });
    assert.match(moved ?? "", /runs it in C:\\repo, the folder this conversation moved from/);
    assert.equal(userShellBlocked({ workspace: "C:\\repo\\", host_workspace: host }), null);
    assert.equal(userShellBlocked({ workspace: "C:\\repo" }), null);
  });

  it("says why a resumed conversation came back to its first folder", () => {
    const text = describeWorkspaceFallback(
      "\\\\?\\C:\\repo\\.muse\\worktrees\\gone",
      "\\\\?\\C:\\repo",
      "cannot resolve the folder",
    );
    assert.match(text, /runs in C:\\repo again: C:\\repo\\\.muse\\worktrees\\gone could not be used \(cannot resolve the folder\)/);
  });
});
