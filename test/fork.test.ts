import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forkFailureMessage } from "../src/lib/fork.ts";

describe("server fork failure guidance", () => {
  it("turns an unavailable anchor into a recoverable action", () => {
    assert.equal(
      forkFailureMessage(new Error("MSP error -32004: cutPoint.lastTurnId was not found")),
      "That turn is no longer available on the host. Use Fork conversation in the header to branch from the latest completed turn.",
    );
  });

  it("preserves unrelated host errors", () => {
    assert.equal(forkFailureMessage(new Error("workspace is offline")), "Fork failed: workspace is offline");
  });

  it("normalizes non-Error failures without throwing", () => {
    assert.equal(forkFailureMessage("stale fork boundary"), "That turn is no longer available on the host. Use Fork conversation in the header to branch from the latest completed turn.");
  });
});
