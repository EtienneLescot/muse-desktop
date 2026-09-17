import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initialStreamWindowStart,
  maxStreamWindowStart,
  nextStreamWindowStart,
  prependStreamWindowStart,
  shouldWindowStream,
  STREAM_WINDOW_SIZE,
} from "../src/lib/streamWindow.ts";

describe("bounded transcript window", () => {
  it("keeps short conversations fully rendered", () => {
    assert.equal(shouldWindowStream(600), false);
    assert.equal(maxStreamWindowStart(600), 440);
    assert.equal(initialStreamWindowStart(600), 0);
  });

  it("opens long conversations at the newest window", () => {
    assert.equal(shouldWindowStream(2000), true);
    assert.equal(initialStreamWindowStart(2000), 2000 - STREAM_WINDOW_SIZE);
    assert.equal(initialStreamWindowStart(2000, 12), 12);
    assert.equal(initialStreamWindowStart(2000, 9000), 1840);
  });

  it("follows the tail but preserves an older reader anchor", () => {
    assert.equal(nextStreamWindowStart(1840, 2000, 2010), 1850);
    assert.equal(nextStreamWindowStart(1200, 2000, 2010), 1200);
    assert.equal(nextStreamWindowStart(1200, 2000, 100), 0);
  });

  it("loads older pages without leaving a negative start", () => {
    assert.equal(prependStreamWindowStart(1840), 1720);
    assert.equal(prependStreamWindowStart(40), 0);
    assert.equal(prependStreamWindowStart(40, 15), 25);
  });
});
