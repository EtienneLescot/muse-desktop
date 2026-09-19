/**
 * M2-08 writer dispatch: shape the explicit task sent to one worktree
 * conversation and keep the renderer-side lane contract deterministic.
 *
 * The host remains the authority for file locking. Muse only dispatches after
 * the user has declared bounded target paths and the pre-flight queue has
 * admitted the writer.
 */
import type { WriterQueueStatus } from "./writerQueue";
import type { LogEntry } from "./persist";

export const MAX_WRITER_OBJECTIVE = 2_000;
export const MAX_WRITER_PROMPT = 6_000;

export type WriterDispatchStatus =
  | "starting"
  | "running"
  | "stopping"
  | "complete"
  | "failed";

/**
 * Local, extractive evidence from a writer transcript. This is deliberately
 * not a host result: until MSP exposes a structured writer completion payload,
 * Muse can only report what it has already observed in the child log.
 */
export interface WriterResultSummary {
  entryCount: number;
  assistantMessages: number;
  toolEvents: number;
  failures: number;
  lastAssistantOutput: string | null;
}

export interface WriterDispatchRecord {
  agent: string;
  sessionId: string | null;
  status: WriterDispatchStatus;
  prompt: string;
  error: string | null;
  result?: WriterResultSummary | null;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Build a bounded, local summary from the writer's observed transcript. */
export function summarizeWriterLog(
  entries: readonly LogEntry[],
): WriterResultSummary | null {
  if (entries.length === 0) return null;
  let lastAssistantOutput: string | null = null;
  let assistantMessages = 0;
  let toolEvents = 0;
  let failures = 0;
  for (const entry of entries) {
    if (entry.role === "assistant") {
      assistantMessages += 1;
      if (entry.text.trim() !== "") lastAssistantOutput = clip(entry.text, 320);
    }
    if (entry.role === "tool") toolEvents += 1;
    if (entry.engineError !== undefined) failures += 1;
  }
  return {
    entryCount: entries.length,
    assistantMessages,
    toolEvents,
    failures,
    lastAssistantOutput,
  };
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
