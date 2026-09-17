/** Pure helpers for discovering Agent Skills documents.
 *
 * The native scanner only reads bounded documents from known workspace
 * directories. Parsing and precedence stay here so they are deterministic,
 * easy to test, and safe to reuse in the browser preview.
 */
import type { Skill, SkillSource } from "./skills";

export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 500;
export const MAX_SKILL_INSTRUCTIONS = 20_000;
export const MAX_SKILL_RESOURCES = 20;

export interface RawSkillDocument {
  path: string;
  source: SkillSource;
  text: string;
  truncated?: boolean;
}

export interface DiscoveredSkill extends Skill {
  path: string;
  resources: string[];
  discovered: true;
}

export interface SkillParseError {
  path: string;
  message: string;
}

export interface SkillParseResult {
  skill: DiscoveredSkill | null;
  error: SkillParseError | null;
}

export interface SkillScanSummary {
  root: string;
  scannedAt: number;
  skills: DiscoveredSkill[];
  errors: SkillParseError[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseResources(value: string): string[] {
  const trimmed = value.trim();
  const body = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return body
    .split(/[;,]/)
    .map((item) => unquote(item))
    .filter((item) => item.length > 0)
    .slice(0, MAX_SKILL_RESOURCES);
}

function frontmatter(text: string): { fields: Map<string, string>; body: string } | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return null;
  const header = normalized.slice(4, end);
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    fields.set(match[1].toLowerCase(), unquote(match[2]));
  }
  return { fields, body: normalized.slice(end + "\n---".length).replace(/^\n/, "").trim() };
}

/** Parse one SKILL.md document, rejecting malformed or unbounded metadata. */
export function parseSkillDocument(document: RawSkillDocument): SkillParseResult {
  const parsed = frontmatter(document.text);
  if (parsed === null) {
    return { skill: null, error: { path: document.path, message: "missing or unterminated YAML frontmatter" } };
  }
  const name = parsed.fields.get("name")?.trim() ?? "";
  const description = parsed.fields.get("description")?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name) || name.length > MAX_SKILL_NAME) {
    return { skill: null, error: { path: document.path, message: "name must use [a-z0-9-] and be at most 64 characters" } };
  }
  if (description.length === 0 || description.length > MAX_SKILL_DESCRIPTION) {
    return { skill: null, error: { path: document.path, message: "description is required and must be at most 500 characters" } };
  }
  if (document.truncated === true || parsed.body.length > MAX_SKILL_INSTRUCTIONS) {
    return { skill: null, error: { path: document.path, message: "instructions exceed the 20,000 character limit" } };
  }
  const resources = parseResources(parsed.fields.get("resources") ?? "");
  if (resources.some((resource) => {
    const normalized = resource.replace(/\\/g, "/");
    return /^(?:[A-Za-z]:\/|\/|~(?:\/|$))/.test(normalized) ||
      normalized.split("/").some((segment) => segment === "..");
  })) {
    return { skill: null, error: { path: document.path, message: "resources must be relative to the skill directory" } };
  }
  return {
    error: null,
    skill: {
      name,
      description,
      instructions: parsed.body,
      source: document.source,
      viewOnly: true,
      enabled: true,
      path: document.path,
      resources,
      discovered: true,
    },
  };
}

/** Parse all native documents while retaining every malformed path for UI. */
export function parseSkillDocuments(documents: RawSkillDocument[]): {
  skills: DiscoveredSkill[];
  errors: SkillParseError[];
} {
  const skills: DiscoveredSkill[] = [];
  const errors: SkillParseError[] = [];
  for (const document of documents) {
    const result = parseSkillDocument(document);
    if (result.skill !== null) skills.push(result.skill);
    if (result.error !== null) errors.push(result.error);
  }
  return { skills, errors };
}

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  builtin: 0,
  team: 1,
  repo: 2,
  project: 3,
};

/** Highest-priority definition wins; ties use the later document. */
export function dedupeDiscoveredSkills(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    const previous = byName.get(key);
    if (previous === undefined || SOURCE_PRIORITY[skill.source] >= SOURCE_PRIORITY[previous.source]) {
      byName.set(key, skill);
    }
  }
  return [...byName.values()];
}
