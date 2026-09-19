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
      turnId: "turn-1",
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

  it("accepts snake_case terminal payloads without leaking secrets", () => {
    const result = parseTurnCompletion("turn/failed", JSON.stringify({
      status: "failed",
      turn_id: "turn-snake",
      duration_ms: 2048,
      result_preview: { summary: "The run stopped safely." },
      failure: {
        category: "provider_error",
        message: "Bearer abc123 was rejected",
        retryable: true,
      },
    }));
    assert.deepEqual(result, {
      terminal: "failed",
      reason: null,
      turnId: "turn-snake",
      resultPreview: "The run stopped safely.",
      error: {
        kind: "provider_error",
        message: "Bearer [redacted] was rejected",
        retryable: true,
        reason: undefined,
        turnId: "turn-snake",
        durationMs: 2048,
      },
    });
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

  it("keeps an optional host-authored completion preview bounded", () => {
    const result = parseTurnCompletion("turn/completed", JSON.stringify({
      turnId: "turn-1",
      result: "The requested files were updated.",
    }));
    assert.equal(result?.error, null);
    assert.equal(result?.resultPreview, "The requested files were updated.");
    const bounded = parseTurnCompletion("turn/completed", JSON.stringify({
      text: "x".repeat(500),
    }));
    assert.equal(bounded?.resultPreview?.length, 320);
    assert.equal(bounded?.resultPreview?.endsWith("…"), true);
    const structured = parseTurnCompletion("turn/completed", JSON.stringify({
      result: { summary: "Structured result from the host." },
    }));
    assert.equal(structured?.resultPreview, "Structured result from the host.");
    const tooDeep = parseTurnCompletion("turn/completed", JSON.stringify({
      result: { summary: { summary: { summary: { text: "ignored" } } } },
    }));
    assert.equal(tooDeep?.resultPreview, undefined);
  });

  it("keeps explicit structured issues and next steps bounded", () => {
    const result = parseTurnCompletion("turn/completed", JSON.stringify({
      result: {
        summary: "Completed with follow-up.",
        issues: [{ message: "Bearer secret should never be shown" }, "workspace is dirty"],
        warnings: ["review the generated patch"],
        nextSteps: ["Run tests", { text: "Publish the release" }],
      },
    }));
    assert.deepEqual(result?.resultIssues, [
      "Bearer [redacted] should never be shown",
      "workspace is dirty",
      "review the generated patch",
    ]);
    assert.deepEqual(result?.resultNextSteps, ["Run tests", "Publish the release"]);
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
