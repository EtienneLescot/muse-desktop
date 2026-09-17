/**
 * Map the small set of terminal control shortcuts supported by the compact
 * command line. The shell still receives the bytes through the normal PTY
 * write path; this helper only keeps keyboard policy deterministic and
 * testable outside React.
 */
export function terminalControlSequence(
  key: string,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): string | null {
  if (modifiers.altKey || modifiers.metaKey) return null;
  if (modifiers.ctrlKey) {
    switch (key.toLowerCase()) {
      case "c":
        return "\x03"; // SIGINT / interrupt
      case "d":
        return "\x04"; // EOF
      case "l":
        return "\x0c"; // clear-screen
      default:
        return null;
    }
  }
  if (key === "Tab") return "\t";
  if (key === "Escape") return "\x1b";
  return null;
}
