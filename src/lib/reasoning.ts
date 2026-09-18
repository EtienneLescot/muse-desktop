/**
 * Reasoning effort exposed by the Muse host.  Keep this list as the single
 * source of truth for persisted settings and both composer controls.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

const LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  ultra: "Ultra",
};

const DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: "Fast responses with no extended reasoning",
  minimal: "Fast responses with a light reasoning pass",
  low: "Short reasoning for straightforward tasks",
  medium: "Balanced speed and depth",
  high: "Deeper reasoning for complex work",
  xhigh: "Very deep reasoning for demanding tasks",
  ultra: "Maximum reasoning depth; responses may take longer",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): ReasoningEffort {
  return isReasoningEffort(value) ? value : fallback;
}

export function reasoningEffortLabel(value: ReasoningEffort): string {
  return LABELS[value];
}

export function reasoningEffortDescription(value: ReasoningEffort): string {
  return DESCRIPTIONS[value];
}
