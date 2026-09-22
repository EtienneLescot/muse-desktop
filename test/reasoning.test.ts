import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  REASONING_EFFORT_CHOICES,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortChoices,
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

  it("offers the CLI persistent tiers (Muse Spark), never the wire-only `none`", () => {
    // The selector shows what Muse Spark saves as a level: the CLI's seven
    // persistent Meta tiers. `none` stays in the wire vocabulary above (the
    // host accepts it) but the CLI never persists it as a level, so it is not
    // a choice.
    assert.deepEqual(REASONING_EFFORT_CHOICES, [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    assert.ok(!REASONING_EFFORT_CHOICES.includes("none"));
    assert.equal(REASONING_EFFORT_CHOICES.length, REASONING_EFFORTS.length - 1);
  });

  it("keeps a legacy `none` selection visible without offering it afresh", () => {
    // Dropping it from the list must not silently rewrite a level already
    // saved by an earlier build: it stays listed as the first option.
    assert.deepEqual(reasoningEffortChoices("none"), ["none", ...REASONING_EFFORT_CHOICES]);
    assert.deepEqual(reasoningEffortChoices("high"), REASONING_EFFORT_CHOICES);
    assert.deepEqual(reasoningEffortChoices(undefined), REASONING_EFFORT_CHOICES);
  });

  it("names the tiers as the CLI spells them", () => {
    assert.equal(reasoningEffortLabel("xhigh"), "Xhigh");
    assert.equal(reasoningEffortLabel("ultra"), "Ultra");
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
