import type { FileReadResult } from "../hooks/useMuseSessions";

/** Keep an explicit file handoff useful without turning the composer into a file dump. */
export const MAX_WORKSPACE_FILE_CONTEXT_CHARS = 12_000;

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

/**
 * Format an explicit, provenance-labelled text-file handoff. The file is
 * treated as data and is never executed or sent implicitly.
 */
export function formatWorkspaceFileContext(
  preview: Pick<FileReadResult, "path" | "content" | "size" | "observedAt" | "truncated">,
  maxChars = MAX_WORKSPACE_FILE_CONTEXT_CHARS,
): string {
  if (preview.content === null) return "";
  const limit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : MAX_WORKSPACE_FILE_CONTEXT_CHARS;
  const clipped = preview.content.length > limit
    ? `${preview.content.slice(0, Math.max(0, limit - 1))}…`
    : preview.content;
  return [
    "",
    `[Workspace file · ${escapeAttribute(preview.path)} · ${preview.size} bytes · observed ${new Date(preview.observedAt).toISOString()}]`,
    "<workspace-file-data>",
    clipped,
    preview.truncated || preview.content.length > limit ? "[preview clipped]" : "",
    "</workspace-file-data>",
  ].join("\n");
}
