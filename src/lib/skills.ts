/**
 * Skills: slash-invokable, auto-suggested, progressively disclosed
 * (US-25).
 *
 * Dependency-light and safe to unit-test on the built-in node:test runner.
 *
 * - A skill is invoked from the composer with `/skill-name optional args`.
 * - The composer also auto-suggests skills by keyword; every suggestion
 *   and every invocation is traced into the session log by the hook
 *   (see `formatSkillTrace`), so auto behavior stays auditable.
 * - Progressive disclosure: skills are view-only by default — only the
 *   name + description (the "view") is exposed until the caller passes
 *   `grantFull: true`, which unlocks the full instructions.
 * - Skills are shareable by source: `builtin` (shipped), `repo` (project
 *   repo), `team` (team config).
 *
 * Persistence lives under `muse-desktop.skills.v1` (localStorage,
 * best-effort). Under node:test there is no localStorage, so load/save
 * degrade gracefully.
 */

import { readStorageJson, writeStorageJson } from "./storage.ts";

/** Where a skill comes from (builtin plus shareable project/repo/team scopes). */
export type SkillSource = "builtin" | "repo" | "team" | "project";

/** One skill definition. */
export interface Skill {
  /** Slash name, e.g. `review-pr` (invoked as `/review-pr`). */
  name: string;
  description: string;
  /** Full instructions; only exposed when the full grant is given. */
  instructions: string;
  source: SkillSource;
  /**
   * View-only by default (progressive disclosure): true means callers
   * see name + description only unless they pass `grantFull: true`.
   */
  viewOnly: boolean;
  enabled: boolean;
  /** Absolute/relative origin when loaded from a SKILL.md on disk. */
  path?: string;
  /** Relative resource references declared by a discovered skill. */
  resources?: string[];
  /** Discovery is session-scoped and is never persisted as an override. */
  discovered?: boolean;
}

/** One auto-suggestion: which skill, and why it matched. */
export interface SkillSuggestion {
  skillName: string;
  reason: string;
}

/** Parsed `/skill-name args` composer command. */
export interface SkillCommand {
  name: string;
  args: string;
}

export interface SkillResourceContext {
  path: string;
  content: string;
  truncated: boolean;
}

/** Storage key (all writes confined to `muse-desktop.*`). */
export const SKILLS_KEY = "muse-desktop.skills.v1";

/** Skills shipped with the app (always present after merge). */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "plan-task",
    description: "Turn a goal into a short step-by-step plan.",
    instructions:
      "Break the user's goal into numbered steps. For each step give the " +
      "action, the expected outcome, and how to verify it. Ask before " +
      "executing anything destructive.",
    source: "builtin",
    viewOnly: true,
    enabled: true,
  },
  {
    name: "review-pr",
    description: "Review a pull-request diff comment by comment.",
    instructions:
      "Read the diff hunk by hunk. For each issue report the file, line, " +
      "severity (blocker/nit), and a concrete suggested change. End with " +
      "a one-line verdict: approve, comment, or request changes.",
    source: "builtin",
    viewOnly: true,
    enabled: true,
  },
  {
    name: "write-tests",
    description: "Add focused regression tests for the change at hand.",
    instructions:
      "Add the smallest test that reproduces the reported behavior, then " +
      "the fix. Cover the happy path plus one edge case. Keep new tests " +
      "next to the existing suite for the touched area.",
    source: "builtin",
    viewOnly: true,
    enabled: true,
  },
  {
    name: "summarize-thread",
    description: "Summarize the current thread into decisions + next steps.",
    instructions:
      "Summarize the thread as: decisions taken, open questions, and next " +
      "steps with owners. Keep it under 15 lines.",
    source: "builtin",
    viewOnly: true,
    enabled: true,
  },
];

/** Normalize a skill name for comparison (`/Review-PR` → `review-pr`). */
export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Parse a `/skill-name optional args` composer line. Returns null unless
 * the trimmed text starts with `/` followed by a valid skill-name token
 * (`[a-z0-9-_]` runs). A lone `/` (typing in progress) is not a command.
 */
export function parseSkillCommand(text: string): SkillCommand | null {
  const trimmed = text.trim();
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)([\s\S]*)$/.exec(trimmed);
  if (m === null) return null;
  return { name: normalizeSkillName(m[1]), args: (m[2] ?? "").trim() };
}

/** Find an enabled skill by slash name (case/format-insensitive). */
export function resolveSkill(skills: Skill[], name: string): Skill | null {
  const want = normalizeSkillName(name);
  for (const s of skills) {
    if (s.enabled && normalizeSkillName(s.name) === want) return s;
  }
  return null;
}

/**
 * Progressive disclosure: the default view exposes name + description
 * only (view-only). Full instructions require the explicit full grant.
 */
export function getSkillDetail(
  skill: Skill,
  grantFull: boolean,
): { name: string; description: string; instructions: string | null } {
  if (skill.viewOnly && !grantFull) {
    return { name: skill.name, description: skill.description, instructions: null };
  }
  return { name: skill.name, description: skill.description, instructions: skill.instructions };
}

/** Keyword → skill-name hints used for auto-suggestion. */
const KEYWORD_HINTS: Array<{ keywords: string[]; skill: string }> = [
  { keywords: ["plan", "steps", "roadmap", "design"], skill: "plan-task" },
  { keywords: ["review", "pr", "diff", "comment"], skill: "review-pr" },
  { keywords: ["test", "regression", "spec", "coverage"], skill: "write-tests" },
  { keywords: ["summar", "recap", "tl;dr", "tldr", "decisions"], skill: "summarize-thread" },
];

/**
 * Auto-suggest skills for a composer draft by keyword. Pure and
 * synchronous; the hook traces every returned suggestion into the
 * session log so auto behavior stays auditable. Empty drafts and
 * slash commands themselves never suggest (the slash names the skill).
 */
export function suggestSkills(skills: Skill[], text: string): SkillSuggestion[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) return [];
  const lower = trimmed.toLowerCase();
  const out: SkillSuggestion[] = [];
  for (const hint of KEYWORD_HINTS) {
    const skill = resolveSkill(skills, hint.skill);
    if (skill === null) continue;
    const hit = hint.keywords.find((k) => lower.includes(k));
    if (hit !== undefined && !out.some((s) => s.skillName === skill.name)) {
      out.push({ skillName: skill.name, reason: `keyword "${hit}"` });
    }
  }
  return out;
}

/** One-line audit trace for a suggestion (written to the session log). */
export function formatSkillTrace(s: SkillSuggestion): string {
  return `[skill suggest] ${s.skillName} — ${s.reason}`;
}

/** One-line audit trace for an invocation (written to the session log). */
export function formatSkillInvokeTrace(name: string, args: string): string {
  return args.length > 0
    ? `[skill invoke] /${name} ${args}`
    : `[skill invoke] /${name}`;
}

/**
 * Build the text actually sent for a `/skill-name args` invocation: the
 * skill instructions (full grant at invoke time) plus the user's args.
 * View-only metadata never leaks extra detail — invocation always runs
 * with the full instructions, explicitly granted here.
 */
export function buildSkillInvocation(
  skill: Skill,
  args: string,
  resources: SkillResourceContext[] = [],
): string {
  const detail = getSkillDetail(skill, true);
  const body = detail.instructions ?? "";
  const resourceText = resources.length > 0
    ? `\n\nResources (loaded from ${skill.path ?? "skill directory"}):\n${resources
        .map((resource) => `<skill-resource path="${resource.path}"${resource.truncated ? " truncated" : ""}>\n${resource.content}\n</skill-resource>`)
        .join("\n")}`
    : "";
  return args.length > 0
    ? `[${skill.name}] ${body}${resourceText}\n\nRequest: ${args}`
    : `[${skill.name}] ${body}${resourceText}`;
}

/**
 * Merge persisted skills over the builtins: builtins are always present
 * (by normalized name); stored repo/team skills and stored builtin
 * overrides (enabled/viewOnly) win. Unknown stored rows are dropped.
 */
export function mergeBuiltinSkills(stored: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const b of BUILTIN_SKILLS) byName.set(normalizeSkillName(b.name), { ...b });
  for (const s of stored) {
    if (typeof s.name !== "string" || s.name.trim().length === 0) continue;
    const key = normalizeSkillName(s.name);
    const prev = byName.get(key);
    const priority = (source: SkillSource): number =>
      source === "project" ? 3 : source === "repo" ? 2 : source === "team" ? 1 : 0;
    const source =
      s.source === "repo" || s.source === "team" || s.source === "builtin" || s.source === "project"
        ? s.source
        : "repo";
    if (prev !== undefined && priority(source) < priority(prev.source)) continue;
    byName.set(key, {
      name: prev?.name ?? s.name.trim(),
      description: typeof s.description === "string" ? s.description : "",
      instructions: typeof s.instructions === "string" ? s.instructions : "",
      source,
      viewOnly: typeof s.viewOnly === "boolean" ? s.viewOnly : true,
      enabled: typeof s.enabled === "boolean" ? s.enabled : true,
      ...(typeof s.path === "string" ? { path: s.path } : {}),
      ...(Array.isArray(s.resources) ? { resources: s.resources.filter((r): r is string => typeof r === "string") } : {}),
      ...(s.discovered === true ? { discovered: true } : {}),
    });
  }
  return [...byName.values()];
}

/** Enable/disable a skill by name; missing names leave the list unchanged. */
export function setSkillEnabled(
  skills: Skill[],
  name: string,
  enabled: boolean,
): { skills: Skill[]; changed: boolean } {
  const want = normalizeSkillName(name);
  let changed = false;
  const next = skills.map((s) => {
    if (normalizeSkillName(s.name) !== want || s.enabled === enabled) return s;
    changed = true;
    return { ...s, enabled };
  });
  return { skills: next, changed };
}

/** Load persisted skill overrides; corrupt/missing data yields []. */
export function loadSkills(): Skill[] {
  const parsed = readStorageJson<unknown>(SKILLS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter(
    (s): s is Skill => typeof s === "object" && s !== null,
  ) as Skill[];
}

/** Persist skill overrides (best-effort: quota/private mode never throws). */
export function saveSkills(skills: Skill[]): void {
  // Disk discoveries are refreshed from their source and must not become
  // stale persisted overrides when a SKILL.md is deleted or renamed.
  writeStorageJson(SKILLS_KEY, skills.filter((skill) => skill.discovered !== true));
}
