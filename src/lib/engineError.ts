/**
 * M0-07: structured terminal failures from the Muse host.
 *
 * The supervisor forwards `turn/completed` as a status event because a turn
 * failure is a terminal view event, not a JSON-RPC rejection. Keep parsing
 * defensive: older hosts send a plain reason while newer hosts include the
 * stable `{ kind, message, retryable }` error object.
 */

import { redactDiagnostic } from "./diagnostics.ts";

export interface EngineErrorDetails {
  kind: string;
  message: string;
  retryable: boolean;
  reason?: string;
  turnId?: string;
  durationMs?: number;
}

export interface TurnCompletionDetails {
  terminal: string;
  reason: string | null;
  error: EngineErrorDetails | null;
  turnId?: string;
  /** Optional host-authored completion text, bounded before it reaches UI. */
  resultPreview?: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

function isFailureTerminal(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^.*\//, "").replace(/[\s_-]+/g, "");
  return new Set(["failed", "failure", "error", "timeout", "timedout", "rejected"]).has(normalized);
}

function resultText(value: unknown, depth = 0): string | null {
  if (depth > 2) return null;
  const text = nonEmpty(value);
  if (text !== null) return text;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["resultPreview", "summary", "output", "text", "message", "headline"]) {
    const nested = resultText(object[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function boundedResult(value: unknown): string | undefined {
  const text = resultText(value);
  if (text === null) return undefined;
  return text.length > 320 ? `${text.slice(0, 319)}…` : text;
}

/** Parse a terminal status payload without ever throwing. */
export function parseTurnCompletion(
  kind: string,
  payload: string,
): TurnCompletionDetails | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    const reason = nonEmpty(payload);
    const failureTerminal = isFailureTerminal(kind);
    return reason === null
      ? null
      : {
          terminal: kind,
          reason,
          error: failureTerminal
            ? { kind: "unknown", message: reason, retryable: false }
            : null,
        };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const reason = nonEmpty(payload);
    return reason === null ? null : { terminal: kind, reason, error: null };
  }
  const row = parsed as Record<string, unknown>;
  // Do not swallow unrelated status JSON merely because its kind happens to
  // be one of the broad stopped-state labels.
  if (!["terminal", "status", "reason", "error", "failure", "turnId", "turn_id", "durationMs", "duration_ms", "result", "resultPreview", "result_preview", "output", "summary", "text"].some((key) => key in row)) {
    return null;
  }
  const terminal = nonEmpty(field(row, "terminal", "status")) ?? kind;
  const reason = redactDiagnostic(nonEmpty(field(row, "reason", "reason_text")));
  const turnId = nonEmpty(field(row, "turnId", "turn_id")) ?? undefined;
  const resultPreview = boundedResult(
    field(row, "resultPreview", "result_preview", "result", "output", "summary", "text"),
  );
  const rawError = field(row, "error", "failure");
  if (typeof rawError !== "object" || rawError === null || Array.isArray(rawError)) {
    const failureTerminal = isFailureTerminal(terminal);
    return {
      terminal,
      reason,
      ...(turnId === undefined ? {} : { turnId }),
      ...(resultPreview === undefined ? {} : { resultPreview }),
      error: failureTerminal && reason !== null
        ? { kind: "unknown", message: reason, retryable: false }
        : null,
    };
  }
  const failure = rawError as Record<string, unknown>;
  const message = redactDiagnostic(nonEmpty(failure.message)) ?? reason;
  const error = message === null
    ? null
    : {
        kind: nonEmpty(field(failure, "kind", "category")) ?? "unknown",
        message,
        retryable: failure.retryable === true,
        reason: reason ?? undefined,
        turnId: nonEmpty(field(row, "turnId", "turn_id")) ?? nonEmpty(field(failure, "turnId", "turn_id")) ?? undefined,
        durationMs: finiteDuration(field(row, "durationMs", "duration_ms")),
      };
  return {
    terminal,
    reason,
    error,
    ...(turnId === undefined ? {} : { turnId }),
    ...(resultPreview === undefined ? {} : { resultPreview }),
  };
}

/** Copy-safe user-facing summary for the transcript header. */
export function engineErrorSummary(error: EngineErrorDetails): string {
  return error.retryable
    ? "Muse could not complete this turn; retrying may succeed."
    : "Muse could not complete this turn.";
}

/** Find the most recent user prompt that precedes a failed turn. */
export function findRetryPrompt(
  entries: readonly { id: string; role: string; text: string }[],
  failureEntryId: string,
): string | null {
  const failureIndex = entries.findIndex((entry) => entry.id === failureEntryId);
  // A stale failure card must never fall back to an unrelated, newer prompt.
  // The caller can surface a recoverable message and let the user resubmit.
  if (failureIndex < 0) return null;
  const before = entries.slice(0, failureIndex);
  return [...before]
    .reverse()
    .find((entry) => entry.role === "user" && entry.text.trim().length > 0)
    ?.text ?? null;
}
