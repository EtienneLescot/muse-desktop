import { buildThreadRecap, type ArtifactLogEntry } from "./artifacts.ts";

/** Bounded, extractive result facts shown in the scheduled-run inspector. */
export interface ScheduleRunSummary {
  headline: string;
  totalItems: number;
  assistantMessages: number;
  toolEvents: number;
  filesMentioned: string[];
  decisions: string[];
  /** Explicit next-step lines observed in the transcript; never inferred. */
  nextSteps?: string[];
}

const MAX_HEADLINE = 280;
const MAX_NEXT_STEPS = 4;
const MAX_NEXT_STEP_CHARS = 200;
const NEXT_STEP_RE = /^(?:[-*•]\s*)?(?:next steps?|todo|to-do|follow[- ]?up|remaining|recommended|should)\s*[:\-]/i;

function clip(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > MAX_HEADLINE ? `${compact.slice(0, MAX_HEADLINE)}…` : compact;
}

function clipNextStep(text: string): string {
  const compact = text.replace(/^[-*•\s]+/, "").replace(/\s+/g, " ").trim();
  return compact.length > MAX_NEXT_STEP_CHARS
    ? `${compact.slice(0, MAX_NEXT_STEP_CHARS)}…`
    : compact;
}

function extractNextSteps(log: ArtifactLogEntry[]): string[] {
  const steps: string[] = [];
  for (const entry of log) {
    if (entry.role !== "assistant" && entry.role !== "subagent") continue;
    for (const line of entry.text.split(/\r?\n/)) {
      if (!NEXT_STEP_RE.test(line.trim())) continue;
      const step = clipNextStep(line.replace(NEXT_STEP_RE, ""));
      if (step.length > 0 && !steps.includes(step)) steps.push(step);
      if (steps.length >= MAX_NEXT_STEPS) return steps;
    }
  }
  return steps;
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
  const nextSteps = extractNextSteps(log);
  return {
    headline,
    totalItems: recap.total,
    assistantMessages: recap.counts.assistant,
    toolEvents: recap.counts.tool,
    filesMentioned: recap.filesMentioned,
    decisions: recap.decisions,
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
  };
}
