import { buildThreadRecap, type ArtifactLogEntry } from "./artifacts.ts";

/** Bounded, extractive result facts shown in the scheduled-run inspector. */
export interface ScheduleRunSummary {
  headline: string;
  totalItems: number;
  assistantMessages: number;
  toolEvents: number;
  filesMentioned: string[];
  decisions: string[];
}

const MAX_HEADLINE = 280;

function clip(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > MAX_HEADLINE ? `${compact.slice(0, MAX_HEADLINE)}…` : compact;
}

/**
 * Build a result summary from the already persisted conversation log. This
 * never calls a model and only retains the bounded recap facts used by the UI.
 */
export function buildScheduleRunSummary(
  sessionId: string,
  log: ArtifactLogEntry[],
): ScheduleRunSummary {
  const recap = buildThreadRecap(sessionId, log);
  const assistant = [...log].reverse().find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);
  const headline = assistant ? clip(assistant.text) : recap.decisions[0] ?? "The scheduled conversation completed.";
  return {
    headline,
    totalItems: recap.total,
    assistantMessages: recap.counts.assistant,
    toolEvents: recap.counts.tool,
    filesMentioned: recap.filesMentioned,
    decisions: recap.decisions,
  };
}
