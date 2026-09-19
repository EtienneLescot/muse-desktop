import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusLogText } from "../src/lib/statusLog.ts";

describe("user-facing lifecycle status copy", () => {
  it("keeps only actionable lifecycle events", () => {
    assert.equal(
      statusLogText("host_exited", '{"code":1}'),
      "Muse stopped because the host process ended. Reconnect to continue.",
    );
    assert.equal(statusLogText("turn/retryScheduled"), "Muse scheduled this turn for another attempt.");
    assert.equal(statusLogText("turn/unqueued"), "Queued turn removed.");
  });

  it("drops protocol housekeeping and unknown payloads", () => {
    assert.equal(statusLogText("started", '{"turnId":"secret"}'), null);
    assert.equal(statusLogText("running", "thinking"), null);
    assert.equal(statusLogText("stopped", '{"terminal":"stopped"}'), null);
    assert.equal(statusLogText("future/hostStatus", '{"internal":"value"}'), null);
  });

  it("uses calm recovery copy for malformed input prompts", () => {
    assert.equal(
      statusLogText("input_requested", "input requested (unparseable)"),
      "Muse requested input, but the prompt could not be read. Reconnect and try again.",
    );
  });
});
