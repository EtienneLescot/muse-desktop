import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineErrorSummary, parseTurnCompletion } from "../src/lib/engineError.ts";

describe("M0-07 structured engine failures", () => {
  it("preserves the stable failure category and retry posture", () => {
    const result = parseTurnCompletion(
      "failed",
      JSON.stringify({
        terminal: "failed",
        turnId: "turn-1",
        durationMs: 4123,
        error: { kind: "modelError", message: "provider unavailable", retryable: true },
      }),
    );
    assert.deepEqual(result, {
      terminal: "failed",
      reason: null,
      error: {
        kind: "modelError",
        message: "provider unavailable",
        retryable: true,
        reason: undefined,
        turnId: "turn-1",
        durationMs: 4123,
      },
    });
    assert.equal(
      engineErrorSummary(result!.error!),
      "Muse could not complete this turn; retrying may succeed.",
    );
  });

  it("falls back to a legacy plain reason without throwing", () => {
    const result = parseTurnCompletion("failed", "legacy host failure");
    assert.deepEqual(result, {
      terminal: "failed",
      reason: "legacy host failure",
      error: { kind: "unknown", message: "legacy host failure", retryable: false },
    });
    assert.equal(parseTurnCompletion("failed", ""), null);
  });
});
