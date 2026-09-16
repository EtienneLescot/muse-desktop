import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_STALE_AFTER_MS,
  classifyStreamHealth,
  formatElapsed,
  streamHealthLabel,
} from "../src/lib/streamHealth.ts";

describe("stream health", () => {
  const base = {
    running: true,
    lastEventAt: 10_000,
    pendingApprovals: 0,
    pendingInputs: 0,
    now: 10_000,
  };

  it("prioritizes explicit approval and input waits", () => {
    assert.equal(classifyStreamHealth({ ...base, pendingApprovals: 1 }), "waiting-approval");
    assert.equal(classifyStreamHealth({ ...base, pendingInputs: 1 }), "waiting-input");
    assert.equal(
      classifyStreamHealth({ ...base, running: false, pendingApprovals: 1 }),
      "waiting-approval",
    );
    assert.equal(
      classifyStreamHealth({
        ...base,
        now: base.lastEventAt + STREAM_STALE_AFTER_MS + 1,
        pendingApprovals: 1,
      }),
      "waiting-approval",
    );
  });

  it("distinguishes live, missing and stale host activity", () => {
    assert.equal(classifyStreamHealth(base), "working");
    assert.equal(classifyStreamHealth({ ...base, lastEventAt: null }), "waiting-host");
    assert.equal(
      classifyStreamHealth({
        ...base,
        now: base.lastEventAt + STREAM_STALE_AFTER_MS,
      }),
      "stalled",
    );
    assert.equal(classifyStreamHealth({ ...base, running: false }), "idle");
  });

  it("keeps an accepted stop request visible until the host confirms it", () => {
    assert.equal(classifyStreamHealth({ ...base, stopping: true }), "stopping");
    assert.equal(streamHealthLabel("stopping"), "Stopping Muse");
  });

  it("keeps labels and elapsed wording compact", () => {
    assert.equal(streamHealthLabel("stalled"), "No recent host update");
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(61_000), "1m 1s");
  });
});
