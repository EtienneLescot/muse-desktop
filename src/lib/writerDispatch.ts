/**
 * M2-08 writer dispatch: shape the explicit task sent to one worktree
 * conversation and keep the renderer-side lane contract deterministic.
 *
 * The host remains the authority for file locking. Muse only dispatches after
 * the user has declared bounded target paths and the pre-flight queue has
 * admitted the writer.
 */
import type { WriterQueueStatus } from "./writerQueue";

export const MAX_WRITER_OBJECTIVE = 2_000;
export const MAX_WRITER_PROMPT = 6_000;

export type WriterDispatchStatus =
  | "starting"
  | "running"
  | "stopping"
  | "complete"
  | "failed";

export interface WriterDispatchRecord {
  agent: string;
  sessionId: string | null;
  status: WriterDispatchStatus;
  prompt: string;
  error: string | null;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Build an explicit, bounded task for the writer conversation. */
export function buildWriterPrompt(
  agent: string,
  targetPaths: readonly string[],
  objective?: string,
): string {
  const safeAgent = clip(agent, 160) || "writer";
  const paths = targetPaths
    .map((path) => clip(path, 240))
    .filter(Boolean)
    .slice(0, 80);
  const task = clip(objective ?? "Complete the assigned writer task and report the result.", MAX_WRITER_OBJECTIVE);
  const prompt = [
    `You are writer ${safeAgent} in a dedicated Muse worktree conversation.`,
    "Work only in this conversation's assigned workspace.",
    `Allowed target paths: ${paths.length > 0 ? paths.join(", ") : "(none declared)"}.`,
    "Do not modify files outside the declared target paths. Inspect first, make the smallest coherent change, and report files changed, checks run, and any blocker.",
    "",
    "Assigned task:",
    task,
  ].join("\n");
  return clip(prompt, MAX_WRITER_PROMPT);
}

export function writerDispatchCanStart(
  queueStatus: WriterQueueStatus,
  activeDispatches: number,
  lanes: number,
): boolean {
  if (queueStatus !== "ready" && queueStatus !== "queued") return false;
  if (!Number.isFinite(activeDispatches) || !Number.isFinite(lanes)) return false;
  return activeDispatches < Math.max(1, Math.floor(lanes));
}

export function writerDispatchIsActive(status: WriterDispatchStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}
