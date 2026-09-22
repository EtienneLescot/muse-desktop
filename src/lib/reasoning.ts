/**
 * Reasoning effort exposed by the Muse host.  Keep this module the single
 * source of truth for persisted settings and every composer control.
 *
 * Two vocabularies exist, and they answer different questions:
 *
 *  - `REASONING_EFFORTS` is the closed **wire** vocabulary: `muse schema
 *    generate-json-schema` exports `$defs.ReasoningEffort` as exactly these
 *    eight strings, and `muse --help` documents the same eight for
 *    `--reasoning-effort`. Anything parsed from or sent to the host uses it —
 *    a narrower list is how `max` once went missing while the engine accepted
 *    and announced it like any other tier. The contract's own wording:
 *    "`none` is a tier of the vocabulary (ask for no reasoning), not a way to
 *    say \"unset\"".
 *
 *  - `REASONING_EFFORT_CHOICES` is what the **selector offers**: the CLI's
 *    persistent Meta tiers, the levels Muse Spark saves, which are seven of the
 *    eight. `none` is wire-only (the CLI never persists it as a level), so it
 *    is not offered; a selection that already holds it stays visible so the
 *    next save cannot silently change someone's level — see
 *    `reasoningEffortChoices`.
 *
 * The descriptions are not a guess either — the CLI's own guidance states that
 * `high` is the default Meta baseline, that `xhigh` is the opt-in premium
 * precision tier, and that `ultra` is "the saved client selection" which "uses
 * `max` reasoning on the Meta wire" plus proactive workflow/delegation guidance.
 * `ultra` is therefore not a deeper ninth level: it is `max` plus an autonomy
 * change, and its copy has to say so. Tier labels use the CLI's own spellings
 * (`xhigh`, not "Very high") so the picker reads like the product it drives.
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

/**
 * Levels a user can pick: the CLI's persistent tiers (Muse Spark). One fewer
 * than the wire enum — `none` is not a saved level.
 */
export const REASONING_EFFORT_CHOICES: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

const LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
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
  ultra: "Max depth plus proactive workflow and delegation guidance; can raise token usage quickly",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Options to render in a picker. A persisted value that is no longer offered
 * (today: `none`) stays listed first: dropping it would silently rewrite the
 * user's level the next time settings are saved.
 */
export function reasoningEffortChoices(current?: ReasoningEffort): readonly ReasoningEffort[] {
  if (current !== undefined && !REASONING_EFFORT_CHOICES.includes(current)) {
    return [current, ...REASONING_EFFORT_CHOICES];
  }
  return REASONING_EFFORT_CHOICES;
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
