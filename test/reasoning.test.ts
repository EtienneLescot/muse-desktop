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
  it("keeps the host order and a stable default", () => {
    assert.deepEqual(REASONING_EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
    assert.equal(DEFAULT_REASONING_EFFORT, "high");
  });

  it("accepts only host-supported values and repairs persisted drift", () => {
    assert.equal(isReasoningEffort("xhigh"), true);
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
