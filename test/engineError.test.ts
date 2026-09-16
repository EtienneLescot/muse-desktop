import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineErrorSummary, findRetryPrompt, parseTurnCompletion } from "../src/lib/engineError.ts";

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

  it("finds only the prompt before the failed turn", () => {
    const entries = [
      { id: "u1", role: "user", text: "first" },
      { id: "a1", role: "assistant", text: "partial" },
      { id: "u2", role: "user", text: "second" },
      { id: "f1", role: "system", text: "failed" },
      { id: "u3", role: "user", text: "later" },
    ];
    assert.equal(findRetryPrompt(entries, "f1"), "second");
    assert.equal(findRetryPrompt(entries, "missing"), null);
  });
});
