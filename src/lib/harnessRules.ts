/**
 * The rules the Muse host actually loads for a folder.
 *
 * Why this module exists. The desktop used to hold its own per-project
 * "instructions" text and prepend it to every turn. The CLI has no such store:
 * its rules live in the folder (`muse init` writes `AGENTS.md`, which says of
 * itself "Muse Code reads this file as project rules when it runs in this
 * directory"), they are versioned with the code, and the host injects them with
 * its own precedence rule — the deeper file wins. Two instruction stores that
 * ignore each other are strictly worse than one that is visible, so the
 * client-side store is gone and this is what replaced it.
 *
 * MSP cannot answer the question: the exported schema has no method,
 * notification or definition about rules. The native side therefore reads the
 * same files the host reads (`src-tauri/src/rules.rs`) and this module only
 * interprets what came back. It deliberately contains no path of its own: the
 * roles, their order and their statuses are the backend's vocabulary, and a
 * second copy here is how the two would drift apart.
 */

/** Rule file roles, in precedence order (personal first, deeper wins). */
export const RULE_STATUSES = ["governs", "superseded", "fallback", "absent"] as const;

export type RuleStatus = (typeof RULE_STATUSES)[number];

export const RULE_SCOPES = ["project", "user"] as const;

export type RuleScope = (typeof RULE_SCOPES)[number];

/** One rule file the host may load. */
export interface HarnessRuleFile {
  /** Stable role id, e.g. `project-agents`. */
  id: string;
  scope: RuleScope;
  /** File name as it appears on disk. */
  name: string;
  path: string;
  present: boolean;
  status: RuleStatus;
  bytes: number;
  /** Bounded head of the file; empty when absent or unreadable. */
  preview: string;
  truncated: boolean;
  /** One sentence explaining why this file is or is not loaded. */
  detail: string;
}

/** A read-only observation of the rules that govern one folder. */
export interface HarnessRules {
  workspace: string;
  files: HarnessRuleFile[];
  /** Id of the project rule file that governs, when one does. */
  governing: string | null;
  observedAt: number;
}

function isRuleStatus(value: unknown): value is RuleStatus {
  return typeof value === "string" && (RULE_STATUSES as readonly string[]).includes(value);
}

function isRuleScope(value: unknown): value is RuleScope {
  return typeof value === "string" && (RULE_SCOPES as readonly string[]).includes(value);
}

function parseRuleFile(raw: unknown): HarnessRuleFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !isRuleScope(value.scope) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.present !== "boolean" ||
    !isRuleStatus(value.status) ||
    typeof value.bytes !== "number" ||
    typeof value.preview !== "string" ||
    typeof value.truncated !== "boolean" ||
    typeof value.detail !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    scope: value.scope,
    name: value.name,
    path: value.path,
    present: value.present,
    status: value.status,
    bytes: value.bytes,
    preview: value.preview,
    truncated: value.truncated,
    detail: value.detail,
  };
}

/**
 * Read the native payload without trusting its shape. A row that does not parse
 * is dropped rather than repaired: an invented rule file would be worse than a
 * missing one, because the whole point is to show what really exists.
 */
export function parseHarnessRules(raw: unknown): HarnessRules | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.workspace !== "string" || !Array.isArray(value.files)) return null;
  const files = value.files.map(parseRuleFile);
  if (files.some((file) => file === null)) return null;
  if (typeof value.observedAt !== "number") return null;
  const governing =
    typeof value.governing === "string" &&
    files.some((file) => file !== null && file.id === value.governing)
      ? value.governing
      : null;
  return {
    workspace: value.workspace,
    files: files as HarnessRuleFile[],
    governing,
    observedAt: value.observedAt,
  };
}

/** The project rule file that governs the folder, if one does. */
export function governingRule(rules: HarnessRules | null): HarnessRuleFile | null {
  if (rules === null) return null;
  return rules.files.find((file) => file.id === rules.governing) ?? null;
}

/** Human label for a status, so the UI never prints a wire value. */
export function ruleStatusLabel(status: RuleStatus): string {
  return {
    governs: "Loaded",
    superseded: "Ignored",
    fallback: "Fallback",
    absent: "Missing",
  }[status];
}

/** Byte size for display. Kept deliberately coarse. */
export function formatRuleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * One sentence describing what governs a folder. This is the string the user
 * reads instead of the old instructions field, so it has to be true when there
 * is nothing to load as well as when there is.
 */
export function describeRules(rules: HarnessRules | null): string {
  if (rules === null) return "Rules have not been read yet.";
  const governing = governingRule(rules);
  if (governing !== null) {
    return `${governing.name} in this folder governs the session (${formatRuleBytes(governing.bytes)}).`;
  }
  const personal = rules.files.filter((file) => file.present && file.scope === "user");
  if (personal.length === 1) {
    return "No rules file in this folder; 1 personal rule file applies as a fallback.";
  }
  if (personal.length > 1) {
    return `No rules file in this folder; ${personal.length} personal rule files apply as a fallback.`;
  }
  return "No rules file in this folder, and none in your personal rules.";
}
