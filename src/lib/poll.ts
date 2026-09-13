/**
 * Serialized backend polling.
 *
 * The UI drains the supervisor's event buffer with `poll_events { since }`.
 * Two drains overlapping with the same cursor would deliver the same events
 * twice (duplicated streamed text), so every drain — the periodic tick and
 * the immediate kick after send/answer/approve — goes through one promise
 * chain. A rejected drain must not poison the chain: the next drain still
 * runs (the cursor only advances on success, so nothing is lost).
 */
export interface PollChain {
  current: Promise<void>;
}

export function createPollChain(): PollChain {
  return { current: Promise.resolve() };
}

/** Append `poll` to the chain; it runs after all previously queued drains. */
export function enqueuePoll(chain: PollChain, poll: () => Promise<void>): void {
  chain.current = chain.current.then(poll, poll);
}
