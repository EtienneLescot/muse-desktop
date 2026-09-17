/**
 * Explicit terminal-to-prompt handoff. The output is deliberately labelled as
 * terminal data and clipped before it enters a turn; this is a user gesture,
 * not an implicit tool call or an assertion that the engine has a terminal
 * context capability.
 */
const DEFAULT_MAX_CHARS = 12_000;

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function formatTerminalContext(
  info: { terminalId: string; cwd: string; shell: string },
  output: string,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : DEFAULT_MAX_CHARS;
  const clipped = output.length > limit ? `…${output.slice(-limit + 1)}` : output;
  return [
    "",
    `[Terminal output · ${escapeAttribute(info.shell)} · ${escapeAttribute(info.cwd)} · ${escapeAttribute(info.terminalId)}]`,
    "<terminal-output>",
    clipped,
    "</terminal-output>",
  ].join("\n");
}

