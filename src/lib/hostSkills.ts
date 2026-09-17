/**
 * Skills advertised by the Muse host through the MSP `skill/list` method.
 *
 * Host skills are distinct from local SKILL.md discovery: the host owns the
 * implementation and expands the selector server-side. Keep this parser
 * defensive because skill metadata is an additive protocol surface.
 */

export interface HostSkill {
  selector: string;
  displayName: string;
  description: string;
  argumentHint?: string;
  pluginId?: string;
  source?: string;
}

const MAX_SKILLS = 500;
const MAX_SELECTOR = 200;
const MAX_DISPLAY_NAME = 200;
const MAX_DESCRIPTION = 1_000;
const MAX_OPTIONAL = 200;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

/** Parse a raw `skill/list` response into stable, display-safe metadata. */
export function parseHostSkills(value: unknown): HostSkill[] {
  if (typeof value !== "object" || value === null) return [];
  const raw = (value as { skills?: unknown }).skills;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: HostSkill[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const selector = boundedString(row.selector, MAX_SELECTOR);
    const displayName = boundedString(row.displayName, MAX_DISPLAY_NAME) ?? selector;
    const description = boundedString(row.description, MAX_DESCRIPTION) ?? "";
    if (!selector || !displayName) continue;
    const key = selector.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      selector,
      displayName,
      description,
      ...(boundedString(row.argumentHint, MAX_OPTIONAL) ? { argumentHint: boundedString(row.argumentHint, MAX_OPTIONAL) } : {}),
      ...(boundedString(row.pluginId, MAX_OPTIONAL) ? { pluginId: boundedString(row.pluginId, MAX_OPTIONAL) } : {}),
      ...(boundedString(row.source, MAX_OPTIONAL) ? { source: boundedString(row.source, MAX_OPTIONAL) } : {}),
    });
    if (result.length >= MAX_SKILLS) break;
  }
  return result;
}

/** Match a slash command against a host selector. */
export function findHostSkill(skills: HostSkill[], name: string): HostSkill | null {
  const wanted = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return skills.find((skill) => skill.selector.trim().toLowerCase().replace(/[\s_]+/g, "-") === wanted) ?? null;
}
