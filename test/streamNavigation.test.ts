import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { streamNavigationTarget, streamScrollBehavior } from "../src/lib/streamNavigation.ts";

describe("conversation keyboard navigation", () => {
  it("jumps to the first and last scroll positions", () => {
    assert.equal(streamNavigationTarget("Home", 800, 420, 2400), 0);
    assert.equal(streamNavigationTarget("End", 800, 420, 2400), 2400);
  });

  it("moves by a readable page and clamps at both ends", () => {
    assert.equal(streamNavigationTarget("PageDown", 800, 100, 2400), 780);
    assert.equal(streamNavigationTarget("PageUp", 800, 100, 2400), 0);
    assert.equal(streamNavigationTarget("PageDown", 800, 2300, 2400), 2400);
  });

  it("rejects unrelated keys and invalid positions safely", () => {
    assert.equal(streamNavigationTarget("ArrowDown", 800, 100, 2400), null);
    assert.equal(streamNavigationTarget("PageDown", Number.NaN, Number.NaN, Number.NaN), 0);
  });

  it("does not animate a jump when the user asked for reduced motion", () => {
    assert.equal(streamScrollBehavior(true), "auto");
    assert.equal(streamScrollBehavior(false), "smooth");
  });
});
