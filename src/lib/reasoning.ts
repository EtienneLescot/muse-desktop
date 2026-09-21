/**
 * Reasoning effort exposed by the Muse host.  Keep this list as the single
 * source of truth for persisted settings and both composer controls.
 *
 * The values and their order are the MSP contract's, not ours: `muse schema
 * generate-json-schema` exports `$defs.ReasoningEffort` as exactly these eight
 * strings, and `muse --help` documents the same eight for `--reasoning-effort`.
 * `max` was missing here for a while, so the picker could not reach a level the
 * engine accepts and announces like any other (verified against a live host:
 * all eight reply `accepted` and emit `session/reasoningEffortChanged`).
 *
 * The descriptions are not a guess either — the CLI's own guidance states that
 * `high` is the default Meta baseline, that `xhigh` is the opt-in premium
 * precision tier, and that `ultra` is "the saved client selection" which "uses
 * `max` reasoning on the Meta wire" plus proactive workflow/delegation guidance.
 * `ultra` is therefore not a deeper ninth level: it is `max` plus an autonomy
 * change, and its copy has to say so.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
  max: "Max",
  ultra: "Ultra",
};

const DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: "Fast responses with no extended reasoning",
  minimal: "Fast responses with a light reasoning pass",
  low: "Short reasoning for straightforward tasks",
  medium: "Balanced speed and depth",
  high: "The default Muse baseline",
  xhigh: "Opt-in premium precision tier",
  max: "Deepest reasoning depth on the wire",
  ultra: "Max reasoning plus proactive workflow and delegation guidance; can raise token usage quickly",
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
