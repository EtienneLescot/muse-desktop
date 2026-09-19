import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_STALE_AFTER_MS,
  classifyStreamHealth,
  formatElapsed,
  parseRetryScheduled,
  resumeRecoveryDelay,
  shouldAcceptRetryScheduled,
  streamEventLabel,
  streamRecoveryDetail,
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

  it("keeps recovery limitations calm and explicit", () => {
    assert.match(streamRecoveryDetail("unsupported"), /does not expose durable recovery/);
    assert.match(streamRecoveryDetail("unsupported"), /local transcript is safe/);
    assert.match(streamRecoveryDetail("failed"), /could not refresh the host state/);
  });

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

  it("keeps a host retry visible through its backoff", () => {
    const retry = {
      delayMs: 5_000,
      attempt: 2,
      maxAttempts: 3,
      reason: "temporary capacity",
      scheduledAt: base.now,
    };
    assert.equal(classifyStreamHealth({ ...base, retryScheduled: retry }), "retrying");
    assert.equal(
      classifyStreamHealth({
        ...base,
        retryScheduled: retry,
        now: base.now + retry.delayMs + STREAM_STALE_AFTER_MS,
      }),
      "stalled",
    );
    assert.equal(streamHealthLabel("retrying"), "Muse is retrying");
  });

  it("exposes the short bridge state after an accepted decision", () => {
    assert.equal(
      classifyStreamHealth({ ...base, resumePendingAt: base.now }),
      "resuming",
    );
    assert.equal(
      classifyStreamHealth({
        ...base,
        resumePendingAt: base.now,
        now: base.now + STREAM_STALE_AFTER_MS,
      }),
      "stalled",
    );
    assert.equal(streamHealthLabel("resuming"), "Muse is resuming");
  });

  it("bounds one silent resume recovery read at the liveness threshold", () => {
    assert.equal(resumeRecoveryDelay(10_000, 10_000), STREAM_STALE_AFTER_MS);
    assert.equal(resumeRecoveryDelay(10_000, 25_000), 0);
    assert.equal(resumeRecoveryDelay(Number.NaN, 25_000), null);
  });

  it("keeps an accepted stop request visible until the host confirms it", () => {
    assert.equal(classifyStreamHealth({ ...base, stopping: true }), "stopping");
    assert.equal(
      classifyStreamHealth({
        ...base,
        stopping: true,
        now: base.lastEventAt + STREAM_STALE_AFTER_MS,
      }),
      "stalled",
    );
    assert.equal(
      classifyStreamHealth({ ...base, stopping: true, lastEventAt: null }),
      "stalled",
    );
    assert.equal(streamHealthLabel("stopping"), "Stopping Muse");
  });

  it("keeps labels and elapsed wording compact", () => {
    assert.equal(streamHealthLabel("stalled"), "No recent host update");
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(61_000), "1m 1s");
  });

  it("maps transport events to safe progress hints", () => {
    assert.equal(streamEventLabel("thinking"), "reasoning update");
    assert.equal(streamEventLabel("approval/resolved"), "authorization resolved");
    assert.equal(streamEventLabel("turn/stopped"), "turn stopped");
    assert.equal(streamEventLabel("history/reconciled"), "conversation synchronized");
    assert.equal(streamEventLabel("future/new_event"), "future new event");
    assert.equal(streamEventLabel(""), null);
  });

  it("parses bounded retry metadata and rejects unstructured payloads", () => {
    assert.deepEqual(parseRetryScheduled(
      JSON.stringify({ delayMs: 2_500, attempt: 2, maxAttempts: 4, reason: "busy", turnId: "turn-1" }),
      123,
    ), {
      delayMs: 2_500,
      attempt: 2,
      maxAttempts: 4,
      reason: "busy",
      turnId: "turn-1",
      scheduledAt: 123,
    });
    assert.equal(parseRetryScheduled(JSON.stringify({ delayMs: "later" }), 123), null);
    assert.equal(parseRetryScheduled("not-json", 123), null);
  });

  it("rejects retry metadata from a different or completed turn", () => {
    const retry = {
      delayMs: 1000,
      attempt: 2,
      maxAttempts: 3,
      reason: null,
      turnId: "turn-2",
      scheduledAt: 123,
    };
    assert.equal(shouldAcceptRetryScheduled(retry, "turn-1"), false);
    assert.equal(shouldAcceptRetryScheduled(retry, undefined, "turn-2"), false);
    assert.equal(shouldAcceptRetryScheduled(retry, "turn-2"), true);
    assert.equal(shouldAcceptRetryScheduled({ ...retry, turnId: undefined }), true);
  });
});
