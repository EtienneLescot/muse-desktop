/** User-facing recovery copy for a server-side conversation fork. */

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
