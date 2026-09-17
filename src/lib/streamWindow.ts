/**
 * Bounded transcript windowing for long conversations.
 *
 * Logs remain durable and complete; only the DOM window is capped. The
 * helpers are pure so session switching and live appends can be tested
 * without a browser layout engine.
 */
export const STREAM_WINDOW_THRESHOLD = 600;
export const STREAM_WINDOW_SIZE = 160;
export const STREAM_WINDOW_PAGE = 120;

export function shouldWindowStream(length: number): boolean {
  return length > STREAM_WINDOW_THRESHOLD;
}

export function maxStreamWindowStart(length: number): number {
  return Math.max(0, length - STREAM_WINDOW_SIZE);
}

/** Pick a saved start, or default to the newest window on first render. */
export function initialStreamWindowStart(
  length: number,
  savedStart?: number,
): number {
  if (!shouldWindowStream(length)) return 0;
  const max = maxStreamWindowStart(length);
  if (savedStart === undefined || !Number.isFinite(savedStart)) return max;
  return Math.min(Math.max(0, Math.floor(savedStart)), max);
}

/**
 * Move the window after the log changes. A window at the tail follows new
 * messages; a reader who loaded older messages keeps their current anchor.
 */
export function nextStreamWindowStart(
  currentStart: number,
  previousLength: number,
  nextLength: number,
): number {
  if (!shouldWindowStream(nextLength)) return 0;
  const previousMax = maxStreamWindowStart(previousLength);
  if (currentStart >= previousMax) return maxStreamWindowStart(nextLength);
  return Math.min(
    Math.max(0, Math.floor(currentStart)),
    maxStreamWindowStart(nextLength),
  );
}

export function prependStreamWindowStart(
  currentStart: number,
  pageSize = STREAM_WINDOW_PAGE,
): number {
  return Math.max(0, Math.floor(currentStart) - Math.max(1, Math.floor(pageSize)));
}
