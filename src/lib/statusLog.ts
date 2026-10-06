/**
 * User-facing transcript copy for lifecycle statuses that do not have a
 * dedicated UI lane. Protocol housekeeping such as `started` and
 * `item_done` belongs in the live stream state, not in the conversation
 * history. Keep this allowlist deliberately small so an unknown host status
 * never leaks raw JSON or an internal method name into the transcript.
 */
export function statusLogText(kind: string, _payload = ""): string | null {
  switch (kind) {
    case "host_exited":
      return "Muse stopped because the host process ended. Reconnect to continue.";
    case "approval_cancelled_by_restart":
      return "Approval cancelled: Muse closed before you answered, so the action did not run.";
    case "input_cancelled_by_restart":
      return "Input cancelled: Muse closed before you answered.";
    case "turn/retracted":
      return "Muse retracted the last turn.";
    case "turn/retryScheduled":
      return "Muse scheduled this turn for another attempt.";
    case "turn/unqueued":
      return "Queued turn removed.";
    case "input_requested":
      return "Muse requested input, but the prompt could not be read. Reconnect and try again.";
    default:
      return null;
  }
}

/**
 * M0-05: an exited host takes its open approvals and questions with it, so
 * the cards of its session go and the transcript says what was cancelled,
 * as after an app restart. One notice per kind of card the session had open.
 */
export function hostExitNotices(
  sessionId: string,
  approvals: readonly { session_id: string }[],
  inputs: readonly { session_id: string }[],
): string[] {
  const notices: string[] = [];
  if (approvals.some((a) => a.session_id === sessionId)) {
    notices.push("Approval cancelled: Muse stopped before you answered, so the action did not run.");
  }
  if (inputs.some((r) => r.session_id === sessionId)) {
    notices.push("Input cancelled: Muse stopped before you answered.");
  }
  return notices;
}
