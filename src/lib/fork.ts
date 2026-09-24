/** User-facing recovery copy for a server-side conversation fork. */
import type { LogEntry } from "./persist";

const INVALID_ANCHOR = /(?:cutpoint|lastturnid|fork.?boundary|invalid.*(?:turn|anchor)|(?:turn|anchor).*(?:not found|unknown|invalid|unavailable)|stale)/i;

/**
 * Keep host-specific fork errors actionable without retrying a different
 * branch point implicitly. The user can choose the latest-turn fork from the
 * conversation header when the requested anchor is no longer durable.
 */
export function forkFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (INVALID_ANCHOR.test(detail)) {
    return "That turn is no longer available on the host. Use Fork conversation in the header to branch from the latest completed turn.";
  }
  return `Fork failed: ${detail}`;
}

/**
 * The entries a fork inherits: everything up to and including the anchor turn.
 *
 * The host branches at `lastTurnId`, so copying the whole local log gave the
 * fork turns that happen after its own branch point — the transcript claimed
 * history the new session does not have. Open items are dropped too: they
 * belong to the source turn and are never replayed.
 *
 * An unknown anchor keeps the full completed log: the host decides what the
 * branch contains, and guessing a cut here would silently lose transcript.
 */
export function inheritedForkLog(log: readonly LogEntry[], lastTurnId?: string): LogEntry[] {
  const completed = log.filter((entry) => entry.open !== true);
  const anchor = lastTurnId?.trim();
  if (!anchor) return completed;
  let end = -1;
  for (let i = completed.length - 1; i >= 0; i -= 1) {
    if (completed[i].turnId === anchor) {
      end = i;
      break;
    }
  }
  return end === -1 ? completed : completed.slice(0, end + 1);
}
