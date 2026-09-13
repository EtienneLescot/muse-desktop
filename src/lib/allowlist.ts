/**
 * US-15 allowlist: matching, conflict resolution, network default-deny.
 *
 * No imports from React/Tauri (besides storage + types from ./persist):
 * safe to unit-test on the built-in node:test runner.
 *
 * - A rule memoizes a command `pattern` + `scope` with an
 *   allow/prompt/forbidden decision.
 * - `resolveApproval` picks the effective decision for an approval request.
 *   Conflicts resolve most-restrictive-wins: forbidden > prompt > allow.
 * - Network scopes without a matching allow rule are effectively denied,
 *   even with no rule at all (fail-closed, cf. US-16).
 */

import {
  loadAllowlist,
  newId,
  saveAllowlist,
  type AllowDecision,
  type AllowRule,
} from "./persist.ts";

export type { AllowDecision, AllowRule };
export { loadAllowlist, saveAllowlist };

/** What the panel asks about: tool name, summary line, and choice scopes. */
export interface ApprovalCandidate {
  toolName: string;
  summary: string;
  scopes: string[];
}

/** Effective decision for one approval request. */
export interface ResolvedApproval {
  decision: AllowDecision;
  /** The winning rule, if any matched. */
  rule: AllowRule | null;
  /** True when the network default-deny fired (no matching allow rule). */
  networkDefaultDeny: boolean;
}

const RANK: Record<AllowDecision, number> = {
  allow: 1,
  prompt: 2,
  forbidden: 3,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern matches when, case-insensitively, it is a substring of the
 * haystack — or, when it contains `*`, a glob (`*` = any run of chars).
 */
export function patternMatches(pattern: string, haystack: string): boolean {
  const p = pattern.trim();
  if (p.length === 0) return false;
  const hay = haystack.toLowerCase();
  if (!p.includes("*")) return hay.includes(p.toLowerCase());
  const re = new RegExp(
    p.split("*").map(escapeRegExp).join(".*"),
    "i",
  );
  return re.test(haystack);
}

function haystackOf(c: ApprovalCandidate): string {
  return [c.toolName, c.summary, ...c.scopes].join("\n");
}

/** Rules whose pattern matches tool name, summary, or any choice scope. */
export function matchingRules(
  rules: AllowRule[],
  candidate: ApprovalCandidate,
): AllowRule[] {
  const hay = haystackOf(candidate);
  return rules.filter((r) => patternMatches(r.pattern, hay));
}

/**
 * True for network-shaped scopes: an explicit `network…` scope, a URL, or a
 * bare domain. Minimum network/domain support: the scope is stored and
 * displayed verbatim; only its shape drives the default-deny below.
 */
export function isNetworkScope(scope: string): boolean {
  const s = scope.trim();
  if (s.length === 0) return false;
  if (/^network\b/i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return true;
  return false;
}

/**
 * Effective decision for a candidate. Most-restrictive-wins across matching
 * rules (forbidden > prompt > allow; ties prefer the longest pattern, then
 * the earliest rule). A network scope with no matching allow rule is
 * effectively forbidden (fail-closed default-deny).
 */
export function resolveApproval(
  rules: AllowRule[],
  candidate: ApprovalCandidate,
): ResolvedApproval {
  const matched = matchingRules(rules, candidate);
  const network = candidate.scopes.some(isNetworkScope);
  const hasAllow = matched.some((r) => r.decision === "allow");
  if (network && !hasAllow) {
    return { decision: "forbidden", rule: null, networkDefaultDeny: true };
  }
  if (matched.length === 0) {
    return { decision: "prompt", rule: null, networkDefaultDeny: false };
  }
  let win = matched[0];
  for (const r of matched.slice(1)) {
    if (
      RANK[r.decision] > RANK[win.decision] ||
      (RANK[r.decision] === RANK[win.decision] &&
        r.pattern.length > win.pattern.length)
    ) {
      win = r;
    }
  }
  return { decision: win.decision, rule: win, networkDefaultDeny: false };
}

/**
 * Insert a rule, upserting on identical (pattern, scope): re-memorizing the
 * same command updates its decision instead of duplicating the row.
 */
export function addAllowRule(
  rules: AllowRule[],
  draft: { pattern: string; scope: string; decision: AllowDecision },
): AllowRule[] {
  const pattern = draft.pattern.trim();
  if (pattern.length === 0) return rules;
  const i = rules.findIndex(
    (r) =>
      r.pattern.toLowerCase() === pattern.toLowerCase() &&
      r.scope === draft.scope,
  );
  if (i >= 0) {
    if (rules[i].decision === draft.decision) return rules;
    const next = [...rules];
    next[i] = { ...next[i], decision: draft.decision };
    return next;
  }
  return [
    ...rules,
    {
      id: newId(),
      pattern,
      scope: draft.scope,
      decision: draft.decision,
      createdAt: Date.now(),
    },
  ];
}

export function removeAllowRule(rules: AllowRule[], id: string): AllowRule[] {
  return rules.filter((r) => r.id !== id);
}

export function setAllowRuleDecision(
  rules: AllowRule[],
  id: string,
  decision: AllowDecision,
): AllowRule[] {
  return rules.map((r) => (r.id === id ? { ...r, decision } : r));
}

/**
 * Default memorized pattern for an approval: the tool name when the host
 * supplies a real one, else the summary's first token (never empty).
 */
export function defaultPatternFor(toolName: string, summary: string): string {
  if (toolName !== "" && toolName !== "tool") return toolName;
  const first = summary.trim().split(/\s+/, 1)[0] ?? "";
  return first !== "" ? first : summary.trim().slice(0, 42);
}
