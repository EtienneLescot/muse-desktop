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
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
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
    const failureTerminal = /^(failed|failure|error|timeout|timed[_-]?out|rejected)$/i.test(kind);
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
  if (!["terminal", "reason", "error", "turnId", "durationMs"].some((key) => key in row)) {
    return null;
  }
  const terminal = nonEmpty(row.terminal) ?? kind;
  const reason = redactDiagnostic(nonEmpty(row.reason));
  const turnId = nonEmpty(row.turnId) ?? undefined;
  const rawError = row.error;
  if (typeof rawError !== "object" || rawError === null || Array.isArray(rawError)) {
    const failureTerminal = /^(failed|failure|error|timeout|timed[_-]?out|rejected)$/i.test(terminal);
    return {
      terminal,
      reason,
      ...(turnId === undefined ? {} : { turnId }),
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
        kind: nonEmpty(failure.kind) ?? "unknown",
        message,
        retryable: failure.retryable === true,
        reason: reason ?? undefined,
        turnId: nonEmpty(row.turnId) ?? undefined,
        durationMs: finiteDuration(row.durationMs),
      };
  return { terminal, reason, error, ...(turnId === undefined ? {} : { turnId }) };
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
