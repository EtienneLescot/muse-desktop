import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostExitNotices, statusLogText } from "../src/lib/statusLog.ts";

describe("user-facing lifecycle status copy", () => {
  it("keeps only actionable lifecycle events", () => {
    assert.equal(
      statusLogText("host_exited", '{"code":1}'),
      "Muse stopped because the host process ended. Reconnect to continue.",
    );
    assert.equal(statusLogText("turn/retryScheduled"), "Muse scheduled this turn for another attempt.");
    assert.equal(statusLogText("turn/unqueued"), "Queued turn removed.");
    // M0-05: the engine aborts an open approval when the app closes.
    assert.match(statusLogText("approval_cancelled_by_restart") ?? "", /^Approval cancelled: .*did not run\.$/);
  });

  it("drops protocol housekeeping and unknown payloads", () => {
    assert.equal(statusLogText("started", '{"turnId":"secret"}'), null);
    assert.equal(statusLogText("running", "thinking"), null);
    assert.equal(statusLogText("stopped", '{"terminal":"stopped"}'), null);
    assert.equal(statusLogText("future/hostStatus", '{"internal":"value"}'), null);
  });

  it("M0-05: says which cards an exited host cancelled, for its own session only", () => {
    const approvals = [{ session_id: "a" }, { session_id: "b" }, { session_id: "b" }];
    const inputs = [{ session_id: "b" }];
    const approval = "Approval cancelled: Muse stopped before you answered, so the action did not run.";
    const input = "Input cancelled: Muse stopped before you answered.";
    assert.deepEqual(hostExitNotices("a", approvals, inputs), [approval]);
    // Two open approvals in one session: one notice per kind, not per card.
    assert.deepEqual(hostExitNotices("b", approvals, inputs), [approval, input]);
    assert.deepEqual(hostExitNotices("b", [], inputs), [input]);
    assert.deepEqual(hostExitNotices("c", approvals, inputs), []);
  });

  it("uses calm recovery copy for malformed input prompts", () => {
    assert.equal(
      statusLogText("input_requested", "input requested (unparseable)"),
      "Muse requested input, but the prompt could not be read. Reconnect and try again.",
    );
  });
});
