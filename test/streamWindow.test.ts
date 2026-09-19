import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initialStreamWindowStart,
  maxStreamWindowStart,
  nextStreamWindowStart,
  prependStreamWindowStart,
  shouldWindowStream,
  streamWindowPadding,
  streamWindowEnd,
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

  it("keeps every loaded page bounded to one DOM window", () => {
    assert.equal(streamWindowEnd(2000, 1840), 2000);
    assert.equal(streamWindowEnd(2000, 1720), 1880);
    assert.equal(streamWindowEnd(2000, 0), STREAM_WINDOW_SIZE);
    assert.equal(streamWindowEnd(80, 0), 80);
    assert.equal(streamWindowEnd(0, 10), 0);
  });

  it("keeps the scrollbar proportional to the full transcript", () => {
    assert.deepEqual(streamWindowPadding(2000, 1840, 2000), {
      top: 1840 * 96,
      bottom: 0,
    });
    assert.deepEqual(streamWindowPadding(2000, 100, 260, 80), {
      top: 8000,
      bottom: 139200,
    });
  });

  it("uses measured entry heights without changing the fallback contract", () => {
    assert.deepEqual(streamWindowPadding(8, 2, 5, 80, { 0: 120, 4: 140, 7: 40 }), {
      top: 200,
      bottom: 2 * 80 + 40,
    });
  });

  it("ignores non-positive measured heights", () => {
    assert.deepEqual(streamWindowPadding(4, 1, 3, 80, { 0: 0, 3: Number.NaN }), {
      top: 80,
      bottom: 80,
    });
  });

  it("clamps invalid padding inputs to a safe layout", () => {
    assert.deepEqual(streamWindowPadding(-1, 10, 2, 0), { top: 0, bottom: 0 });
    assert.deepEqual(streamWindowPadding(20, -4, 500, Number.NaN), {
      top: 0,
      bottom: 0,
    });
  });
});