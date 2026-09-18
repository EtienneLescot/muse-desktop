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
/** Conservative average used before a rendered entry has been measured. */
export const STREAM_ESTIMATED_ENTRY_HEIGHT = 96;

export type StreamEntryHeights = Readonly<Record<number, number | undefined>>;

export function shouldWindowStream(length: number): boolean {
  return length > STREAM_WINDOW_THRESHOLD;
}

export function maxStreamWindowStart(length: number): number {
  return Math.max(0, length - STREAM_WINDOW_SIZE);
}

/** Inclusive/exclusive end for the DOM window at a given start. */
export function streamWindowEnd(length: number, start: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const boundedLength = Math.floor(length);
  const boundedStart = Math.min(
    Math.max(0, Number.isFinite(start) ? Math.floor(start) : 0),
    boundedLength,
  );
  return Math.min(boundedLength, boundedStart + STREAM_WINDOW_SIZE);
}

function safeHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function measuredRangeHeight(
  from: number,
  to: number,
  measuredHeights: StreamEntryHeights,
  fallback: number,
): number {
  let height = 0;
  for (let index = from; index < to; index += 1) {
    height += safeHeight(measuredHeights[index], fallback);
  }
  return height;
}

/**
 * Reserve layout space for entries outside the bounded DOM window. Keeping
 * this calculation pure makes the scroll model testable without a browser
 * layout engine and avoids a scrollbar that represents only 160 entries.
 * Measured block heights are used when available; entries not visited yet use
 * the conservative estimate so the layout remains stable before measurement.
 */
export function streamWindowPadding(
  length: number,
  start: number,
  end: number,
  entryHeight = STREAM_ESTIMATED_ENTRY_HEIGHT,
  measuredHeights: StreamEntryHeights = {},
): { top: number; bottom: number } {
  const boundedLength = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
  const boundedStart = Math.min(
    Math.max(0, Number.isFinite(start) ? Math.floor(start) : 0),
    boundedLength,
  );
  const boundedEnd = Math.min(
    Math.max(boundedStart, Number.isFinite(end) ? Math.floor(end) : boundedStart),
    boundedLength,
  );
  const fallback = Number.isFinite(entryHeight) && entryHeight > 0
    ? entryHeight
    : STREAM_ESTIMATED_ENTRY_HEIGHT;
  return {
    top: measuredRangeHeight(0, boundedStart, measuredHeights, fallback),
    bottom: measuredRangeHeight(boundedEnd, boundedLength, measuredHeights, fallback),
  };
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
