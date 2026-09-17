/**
 * US-32 keyboard + screen-reader accessibility: pure decision/focus logic.
 * Dependency-free (zero imports) so it stays unit-testable under
 * `node:test` without React, DOM, or Tauri.
 */

/** Arrow/Home/End keys that move between approval choices. */
export function choiceIndexForKey(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  const safe = Math.min(Math.max(current, 0), count - 1);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (safe + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (safe - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** True for keys that confirm the focused approval choice. */
export function isChoiceConfirmKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * Focus trap step for Tab cycling inside a pending-decision panel.
 * Returns the index that should receive focus next (wraps around).
 */
export function trapTabIndex(
  current: number,
  count: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  const safe = Math.min(Math.max(current, 0), count - 1);
  const delta = shiftKey ? -1 : 1;
  return (safe + delta + count) % count;
}

/** Screen-reader text for a stream running/stopped transition. */
export function streamStatusMessage(running: boolean): string {
  return running ? "Agent running." : "Agent stopped.";
}

/** Screen-reader text when approval requests arrive. */
export function approvalAnnouncement(count: number, toolName?: string): string {
  if (count <= 0) return "";
  const what =
    toolName !== undefined && toolName !== "" && toolName !== "tool"
      ? ` for ${toolName}`
      : "";
  return count === 1
    ? `Approval needed${what}. Focus moved to the approval panel.`
    : `${count} approvals needed${what}. Focus the approval panel to decide.`;
}

/** Screen-reader text when answerable input requests arrive. */
export function inputAnnouncement(count: number, toolName?: string): string {
  if (count <= 0) return "";
  const what =
    toolName !== undefined && toolName !== "" && toolName !== "input"
      ? ` from ${toolName}`
      : "";
  return count === 1
    ? `Input requested${what}. Answer or skip in the input panel.`
    : `${count} inputs requested${what}. Answer or skip in the input panel.`;
}

/**
 * Next polite live-region message for a status transition. Returns "" when
 * nothing worth announcing changed (so callers can leave the region alone
 * and avoid chattering on every render).
 */
export function statusAnnouncement(
  prevRunning: boolean | null,
  nextRunning: boolean,
  prevPending: number,
  nextPending: number,
): string {
  if (
    prevRunning !== null &&
    prevRunning !== nextRunning &&
    nextPending === prevPending
  ) {
    return streamStatusMessage(nextRunning);
  }
  if (nextPending > prevPending) {
    const added = nextPending - prevPending;
    return added === 1 && prevRunning !== nextRunning && prevRunning !== null
      ? `${streamStatusMessage(nextRunning)} 1 decision pending.`
      : `${added} decision${added === 1 ? "" : "s"} pending.`;
  }
  if (prevRunning !== null && prevRunning !== nextRunning) {
    return streamStatusMessage(nextRunning);
  }
  return "";
}

/** Product-facing modifier label for shortcut hints on the current OS. */
export function primaryModifier(platform?: string): "Cmd" | "Ctrl" {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  return /Mac|iPhone|iPad|iPod/i.test(value) ? "Cmd" : "Ctrl";
}

/** Documented composer keyboard shortcuts (rendered as title attributes). */
export const COMPOSER_SHORTCUT_TITLES = {
  textarea:
    "Prompt input — Enter to send, Shift+Enter for a new line, Up/Down navigate completions, Tab accepts, Escape dismisses",
  send: "Send (Enter)",
  stop: "Stop the running sidecar",
} as const;
