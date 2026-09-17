/** Accessible metadata for the bounded conversation transcript (M1-13).
 *
 * The renderer may only mount a window of the log, but assistive technology
 * should still understand each visible entry's position in the full durable
 * conversation. Keeping the calculation pure avoids deriving identity from
 * the currently selected window or mutating the session SSOT.
 */

export interface StreamEntryA11y {
  role: "article";
  position: number;
  setSize: number;
  label: string;
}

/** Return bounded, one-based position metadata for one transcript entry. */
export function streamEntryA11y(
  role: string,
  index: number,
  total: number,
): StreamEntryA11y {
  const setSize = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const position = setSize === 0
    ? 1
    : Math.min(Math.max(0, Math.floor(Number.isFinite(index) ? index : 0)), setSize - 1) + 1;
  const safeRole = role.trim() || "Message";
  return {
    role: "article",
    position,
    setSize,
    label: `${safeRole}, message ${position} of ${setSize}`,
  };
}

/** Stable announcement for screen readers when a long-log window changes. */
export function streamWindowAnnouncement(
  start: number,
  end: number,
  total: number,
): string {
  const size = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (size === 0) return "Conversation is empty.";
  const first = Math.min(Math.max(1, Math.floor(start) + 1), size);
  const last = Math.min(Math.max(first, Math.floor(end)), size);
  return `Showing messages ${first} to ${last} of ${size}.`;
}
