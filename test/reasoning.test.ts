import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortDescription,
  reasoningEffortLabel,
} from "../src/lib/reasoning.ts";

describe("reasoning effort settings", () => {
  it("keeps the wire vocabulary and its order", () => {
    // Pinned against `$defs.ReasoningEffort` of the exported MSP schema (and
    // against `muse --help`). The previous list omitted `max`, which the host
    // accepts and announces, so this assertion is what would have caught it.
    assert.deepEqual(REASONING_EFFORTS, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    assert.equal(DEFAULT_REASONING_EFFORT, "high");
  });

  it("does not present ultra as a deeper level than max", () => {
    // The CLI documents ultra as `max` reasoning on the wire plus proactive
    // workflow guidance, so its copy must not claim a greater depth.
    const ultra = reasoningEffortDescription("ultra").toLowerCase();
    assert.ok(ultra.includes("max"));
    assert.ok(!ultra.includes("maximum reasoning depth"));
    assert.equal(reasoningEffortDescription("max"), "Deepest reasoning depth on the wire");
  });

  it("accepts only host-supported values and repairs persisted drift", () => {
    assert.equal(isReasoningEffort("xhigh"), true);
    assert.equal(isReasoningEffort("max"), true);
    assert.equal(isReasoningEffort("maximum"), false);
    assert.equal(normalizeReasoningEffort("medium"), "medium");
    assert.equal(normalizeReasoningEffort("stale"), DEFAULT_REASONING_EFFORT);
    assert.equal(normalizeReasoningEffort(undefined, "low"), "low");
  });

  it("provides readable labels and descriptions for every option", () => {
    for (const effort of REASONING_EFFORTS) {
      assert.ok(reasoningEffortLabel(effort).length > 0);
      assert.ok(reasoningEffortDescription(effort).length > 0);
    }
  });
});
