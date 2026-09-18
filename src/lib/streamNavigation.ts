/** Keyboard navigation targets for the scrollable conversation transcript. */

export type StreamNavigationKey = "Home" | "End" | "PageUp" | "PageDown";

/**
 * Resolve a keyboard navigation key to a bounded scroll position.
 *
 * Keeping this calculation pure makes the long-transcript behaviour testable
 * without a browser layout engine. The caller still owns the actual scroll
 * element and its windowing side effects.
 */
export function streamNavigationTarget(
  key: string,
  viewportHeight: number,
  currentTop: number,
  maxTop: number,
): number | null {
  if (!(key === "Home" || key === "End" || key === "PageUp" || key === "PageDown")) {
    return null;
  }
  const safeMax = Math.max(0, Number.isFinite(maxTop) ? maxTop : 0);
  if (key === "Home") return 0;
  if (key === "End") return safeMax;
  const safeCurrent = Math.min(
    safeMax,
    Math.max(0, Number.isFinite(currentTop) ? currentTop : 0),
  );
  const page = Math.max(1, (Number.isFinite(viewportHeight) ? viewportHeight : 0) * 0.85);
  return Math.min(
    safeMax,
    Math.max(0, safeCurrent + (key === "PageDown" ? page : -page)),
  );
}
