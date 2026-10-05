/**
 * M2-05: move a conversation's uncommitted work between Local and a worktree.
 * The supervisor does the Git transfer and, on a host with
 * `turn/start.workspaceRoots` (Muse 1.4.2 and later), moves the conversation
 * itself. This module only words the outcome, never claiming more than
 * happened.
 */

import { displayPath, pathKey } from "./paths.ts";

/** `handoff_preview`, or the outcome of `handoff_move`. */
export interface HandoffPreview {
  source: string;
  /** Absent while the target worktree does not exist yet. */
  target: string | null;
  /** Tracked files with uncommitted changes, staged or not. */
  tracked: number;
  untracked: number;
  /** Ignored entries; never moved. */
  ignored: number;
  conflicts: string[];
  /** After a move: the Git ref keeping both folders as they were before it. */
  snapshot: string | null;
  /** The conversation moves too; otherwise a new one opens in the target. */
  sameSession: boolean;
  /** After a move: why the conversation could not follow the files. */
  sessionError?: string;
}

/** Minimal transcript shape used for a bounded local context excerpt. */
export interface HandoffTranscriptEntry {
  role: string;
  text: string;
}

const MAX_HANDOFF_CONTEXT = 4_000;
const MAX_HANDOFF_ENTRIES = 8;
const MAX_LISTED_CONFLICTS = 10;

function contextValue(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized || fallback;
}

function transcriptExcerpt(entries: readonly HandoffTranscriptEntry[]): string[] {
  return entries
    .filter((entry) => {
      const role = entry.role.trim().toLowerCase();
      // System/protocol rows are local bookkeeping and should never be copied
      // into a handoff prompt as if they were user intent.
      return (role === "user" || role === "assistant") && entry.text.trim().length > 0;
    })
    .slice(-MAX_HANDOFF_ENTRIES)
    .map((entry) => {
      const role = entry.role.trim().toLowerCase() === "user" ? "You" : "Muse";
      const text = contextValue(entry.text, "");
      return `${role}: ${text}`;
    });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The question asked before a move, or why it cannot happen. `destination`
 * names the target for a person: "Local", "a new worktree".
 */
export function handoffQuestion(
  preview: HandoffPreview,
  destination: string,
): { blocked: boolean; text: string } {
  const conflicts = preview.conflicts;
  if (conflicts.length > 0) {
    const listed = conflicts.slice(0, MAX_LISTED_CONFLICTS).join(", ");
    const more = conflicts.length > MAX_LISTED_CONFLICTS
      ? `, and ${conflicts.length - MAX_LISTED_CONFLICTS} more`
      : "";
    return {
      blocked: true,
      text: `Nothing was moved: ${plural(conflicts.length, "file")} would conflict in ${destination} (${listed}${more}). Commit, discard or move them there first.`,
    };
  }
  return {
    blocked: false,
    text: [
      `Move all the uncommitted work in this folder to ${destination}, including changes made outside this conversation?`,
      "",
      `• ${plural(preview.tracked, "changed file")} (staged changes arrive unstaged)`,
      `• ${plural(preview.untracked, "untracked file")}`,
      `• ${plural(preview.ignored, "ignored item")} left where they are`,
      "",
      preview.sameSession
        ? "The conversation moves with them: its next message runs there."
        : "This Muse host cannot move a conversation: a new one opens there with a note, and this one stays where it is.",
    ].join("\n"),
  };
}

/** The transcript line after a move: what moved, what stayed, where the copy is. */
export function describeHandoffResult(result: HandoffPreview): string {
  return [
    `Moved ${plural(result.tracked, "changed file")} and ${plural(result.untracked, "untracked file")} to ${contextValue(displayPath(result.target ?? ""), "the target")}; ${plural(result.ignored, "ignored item")} stayed behind.`,
    result.sameSession
      ? "This conversation now runs there."
      : `This conversation stays here${result.sessionError ? ` (it could not follow: ${contextValue(result.sessionError, "unknown error")})` : ""}; the work continues in a new conversation there.`,
    result.snapshot !== null ? `Both folders as they were before the move: ${result.snapshot}.` : "",
  ].filter((line) => line.length > 0).join(" ");
}

/**
 * Why "Run in Muse" is off for a moved conversation: the host runs
 * `session/userShell` in its own folder, which the conversation left (probed
 * on 1.4.2). Null while the conversation runs in the host's folder.
 */
export function userShellBlocked(session: { workspace: string; host_workspace?: string }): string | null {
  const host = session.host_workspace;
  return host === undefined || pathKey(host) === pathKey(session.workspace)
    ? null
    : `This Muse engine runs it in ${contextValue(displayPath(host), "another folder")}, the folder this conversation moved from: use Send to run it here.`;
}

/** The transcript line when a resumed conversation could not go back to the folder it had moved to. */
export function describeWorkspaceFallback(left: string, now: string, reason: string): string {
  return `This conversation runs in ${contextValue(displayPath(now), "its first folder")} again: ${contextValue(displayPath(left), "the folder it had moved to")} could not be used (${contextValue(reason, "unknown error")}). Nothing was moved.`;
}

/**
 * The bounded note a new conversation opens with when the host could not move
 * this one (Muse 1.3.0). It never claims that the session moved.
 */
export function formatHandoffContext(
  result: HandoffPreview,
  entries: readonly HandoffTranscriptEntry[] = [],
): string {
  const lines = [
    "## Muse handoff context",
    "The uncommitted work was moved here from another folder. The previous conversation was not moved; it is still where it was.",
    `From: ${contextValue(displayPath(result.source), "unknown folder")}`,
    `To: ${contextValue(displayPath(result.target ?? ""), "unknown folder")}`,
    `Moved: ${plural(result.tracked, "changed file")}, ${plural(result.untracked, "untracked file")}; ignored files stayed behind.`,
    "Review the working tree before making changes.",
  ];
  const excerpt = transcriptExcerpt(entries);
  if (excerpt.length > 0) {
    lines.push(
      "",
      "Conversation context (local excerpt; verify against this folder):",
      ...excerpt,
    );
  }
  const text = lines.join("\n");
  return text.length <= MAX_HANDOFF_CONTEXT
    ? text
    : `${text.slice(0, MAX_HANDOFF_CONTEXT - 1)}…`;
}
