import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityAccessibleLabel,
  capabilityDescription,
  capabilityLabel,
  capabilityNextStep,
  type CapabilityStatus,
} from "../src/lib/capability.ts";

test("capability badges expose their state and reason to assistive tech", () => {
  assert.equal(
    capabilityAccessibleLabel("manual", "Run the prepared command when ready."),
    "Manual: Run the prepared command when ready. Next: Choose the input or run the prepared step yourself.",
  );
  assert.match(capabilityAccessibleLabel("unavailable"), /^Not connected:/);
});

describe("capability status vocabulary", () => {
  it("keeps the four product states distinct", () => {
    const statuses: CapabilityStatus[] = [
      "available",
      "local",
      "manual",
      "unavailable",
    ];
    assert.deepEqual(statuses.map(capabilityLabel), [
      "Available",
      "Local",
      "Manual",
      "Not connected",
    ]);
  });

  it("prefers a concrete reason while retaining a safe default", () => {
    assert.equal(
      capabilityDescription("unavailable", "Transport is not wired."),
      "Transport is not wired.",
    );
    assert.match(capabilityDescription("manual"), /manually/);
    assert.equal(capabilityDescription("local", "  "), "This capability runs locally and does not call a remote service.");
  });

  it("keeps the next action explicit for every capability state", () => {
    assert.match(capabilityNextStep("available"), /Use this capability/);
    assert.match(capabilityNextStep("local"), /locally/);
    assert.match(capabilityNextStep("manual"), /yourself/);
    assert.match(capabilityNextStep("unavailable"), /Connect/);
  });
});
