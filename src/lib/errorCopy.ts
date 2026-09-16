import { redactDiagnostic } from "./diagnostics.ts";

type ErrorPattern = readonly [RegExp, string];

// Keep protocol verbs out of the primary sentence while retaining a bounded,
// redacted detail for support. This is presentation copy only; callers still
// keep the original error for retry and diagnostics classification.
const FRIENDLY_PATTERNS: ErrorPattern[] = [
  [/^(?:event poll|restore_sessions) failed\b/i, "Live updates are unavailable."],
  [/^folder picker failed\b/i, "The folder picker could not be opened."],
  [/^recovery export failed\b/i, "The recovery export could not be downloaded."],
  [/^recovery import failed\b/i, "The recovery snapshot could not be imported."],
  [/^start_session failed\b/i, "This conversation could not be started."],
  [/^send_input failed\b/i, "Your message could not be sent."],
  [/^turn\/steer failed\b/i, "This turn could not be redirected."],
  [/^cancel_session failed\b/i, "This conversation could not be stopped."],
  [/^(?:approve|answer_input) failed\b/i, "Your response could not be submitted."],
  [/^model catalog unavailable\b/i, "The model list is unavailable."],
  [/^set model failed\b/i, "The model could not be changed."],
  [/^reconnect failed\b/i, "This conversation could not be reconnected."],
  [/^worktree .* failed\b/i, "The worktree action could not be completed."],
  [/^local MCP .* failed\b/i, "The local MCP action could not be completed."],
  [/^remote MCP .* failed\b/i, "The remote MCP action could not be completed."],
  [/^skills scan failed\b/i, "The skills scan could not be completed."],
  [/^schedule run failed\b/i, "The scheduled run could not be started."],
  [/^index .* failed\b/i, "The workspace index action could not be completed."],
  [/^terminal_.* failed\b/i, "The terminal action could not be completed."],
  [/^subagent_.* failed\b/i, "The sub-agent action could not be completed."],
  [/^retry failed\b/i, "The previous message could not be retried."],
  [/^restore failed\b/i, "The recovery action could not be completed."],
];

function asText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  return String(error);
}

/** Return calm, English, redacted copy for a user-facing error surface. */
export function userFacingError(error: unknown, fallback = "Something went wrong."): string {
  const redacted = redactDiagnostic(asText(error).replace(/^Error:\s*/i, ""));
  const value = redacted?.trim() || fallback;
  const match = FRIENDLY_PATTERNS.find(([pattern]) => pattern.test(value));
  if (!match) return value;
  const detail = value
    .replace(match[0], "")
    .replace(/^\s*[:\-]\s*/, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return detail.length > 0 ? `${match[1]} — ${detail}` : match[1];
}
