import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forkFailureMessage, inheritedForkLog } from "../src/lib/fork.ts";

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

describe("fork transcript inheritance", () => {
  const log = [
    { id: "a", ts: 1, role: "user" as const, text: "one", turnId: "t1" },
    { id: "b", ts: 2, role: "assistant" as const, text: "one", turnId: "t1" },
    { id: "c", ts: 3, role: "user" as const, text: "two", turnId: "t2" },
    { id: "d", ts: 4, role: "assistant" as const, text: "two", turnId: "t2", open: true },
    { id: "e", ts: 5, role: "user" as const, text: "three", turnId: "t3" },
  ];

  it("stops at the anchor turn the host branched on", () => {
    assert.deepEqual(inheritedForkLog(log, "t1").map((e) => e.id), ["a", "b"]);
  });

  it("keeps the whole anchor turn, dropping only open items", () => {
    assert.deepEqual(inheritedForkLog(log, "t2").map((e) => e.id), ["a", "b", "c"]);
  });

  it("keeps the completed log when no anchor is given", () => {
    assert.deepEqual(inheritedForkLog(log).map((e) => e.id), ["a", "b", "c", "e"]);
  });

  it("keeps the completed log when the anchor is unknown", () => {
    assert.deepEqual(inheritedForkLog(log, "t9").map((e) => e.id), ["a", "b", "c", "e"]);
  });
});
