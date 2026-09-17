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
