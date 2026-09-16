/**
 * US-8 worktree helper: pure per-agent git worktree planning, zero imports.
 *
 * Git checkout creation is handled by the guarded Rust service. The shell
 * snippet remains available as a manual fallback, while setup command
 * validation is kept here so the UI and native runner share the same limit.
 * The pre-flight HEAD-hash compare is report-only — a moved HEAD never
 * blocks, it just warns.
 */

/** Root under which per-agent worktrees are created. */
export const WORKTREE_ROOT = ".muse/worktrees";

/** Default base ref for new worktree branches. */
export const WORKTREE_BASE = "HEAD";

/** Manual-setup plan for one agent's worktree. */
export interface WorktreePlan {
  agent: string;
  path: string;
  branch: string;
  base: string;
}

/** Record returned after Git has created a real worktree. */
export interface WorktreeRecord {
  repoRoot: string;
  path: string;
  branch: string;
  base: string;
  createdAt: number;
}

export interface WorktreeSetupResult {
  status: "ready" | "failed" | "timedOut" | "cancelled";
  output: string;
  exitCode: number | null;
  durationMs: number;
  environmentKeys: string[];
}

export interface WorktreeReadiness {
  status: "ready" | "blocked" | "needsSetup";
  path: string;
  projectFiles: string[];
  tools: Array<{
    name: string;
    required: boolean;
    available: boolean;
  }>;
  checkedAt: number;
}

export interface WorktreeInspection {
  repoRoot: string;
  path: string;
  branch: string | null;
  head: string | null;
  clean: boolean;
  conflicted: boolean;
  fileCount: number;
  observedAt: number;
}

export const MAX_SETUP_COMMAND_CHARS = 2_000;
export const MAX_SETUP_ENV_NAMES = 40;
export const DEFAULT_SETUP_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalize user-entered environment names without inventing values. */
export function normalizeSetupEnvAllowlist(names: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name.length === 0 || !ENV_NAME_RE.test(name) || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= MAX_SETUP_ENV_NAMES) break;
  }
  return result;
}

/** Parse the comma/newline separated extra names shown in the setup panel. */
export function parseSetupEnvAllowlist(input: string): {
  names: string[];
  error: string | null;
} {
  const rawNames = input.split(/[\s,;]+/).map((name) => name.trim()).filter(Boolean);
  const invalid = rawNames.find((name) => !ENV_NAME_RE.test(name));
  if (invalid !== undefined) {
    return {
      names: [],
      error: `Invalid environment variable name: ${invalid}`,
    };
  }
  const names = normalizeSetupEnvAllowlist(rawNames);
  if (rawNames.length > MAX_SETUP_ENV_NAMES) {
    return {
      names: [],
      error: `Environment allowlist is limited to ${MAX_SETUP_ENV_NAMES} names.`,
    };
  }
  return { names, error: null };
}

export function validateSetupCommand(command: string): string | null {
  const value = command.trim();
  if (value.length === 0) return "Setup command must not be empty.";
  if (value.length > MAX_SETUP_COMMAND_CHARS) {
    return `Setup command is limited to ${MAX_SETUP_COMMAND_CHARS} characters.`;
  }
  return null;
}

function safePathSegment(agent: string): string {
  const segment = agent.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return segment === "." || segment === ".." || segment.length === 0
    ? "agent"
    : segment;
}

/**
 * Build one plan per agent id: path `.muse/worktrees/<agent>`, branch
 * `task<N>-branch` (1-based position), base HEAD by default. Pure and
 * total: empty/blank ids are skipped, order is preserved, never throws.
 */
export function planWorktrees(
  agentIds: string[],
  base: string = WORKTREE_BASE,
): WorktreePlan[] {
  const plans: WorktreePlan[] = [];
  const usedSegments = new Set<string>();
  let n = 0;
  for (const raw of agentIds) {
    const agent = raw.trim();
    if (agent.length === 0) continue;
    if (plans.some((p) => p.agent === agent)) continue;
    n += 1;
    const baseSegment = safePathSegment(agent);
    let segment = baseSegment;
    let suffix = 2;
    while (usedSegments.has(segment)) {
      segment = `${baseSegment}-${suffix}`;
      suffix += 1;
    }
    usedSegments.add(segment);
    plans.push({
      agent,
      path: `${WORKTREE_ROOT}/${segment}`,
      branch: `task${n}-branch`,
      base,
    });
  }
  return plans;
}

/**
 * Render the manual-setup shell snippet for a plan list: one
 * `git worktree add` per agent. Empty plan list yields an empty string.
 */
export function worktreeShellSnippet(plans: WorktreePlan[]): string {
  return plans
    .map((p) => `git worktree add ${p.path} -b ${p.branch} ${p.base}`)
    .join("\n");
}

/** Outcome of the pre-flight HEAD-hash compare (report-only). */
export interface HeadCompare {
  match: boolean;
  report: string;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

/**
 * Compare the baseline HEAD hash (recorded when the plan was made) with
 * the current HEAD hash. Report-only: a mismatch warns that worktree
 * branches may need a rebase, it never invalidates the plan. Missing
 * input yields a non-match with an explicit "nothing checked" report.
 */
export function compareHeadHashes(
  baseline: string,
  current: string,
): HeadCompare {
  const b = baseline.trim();
  const c = current.trim();
  if (b.length === 0 || c.length === 0) {
    return {
      match: false,
      report: "HEAD compare needs both hashes — nothing checked.",
    };
  }
  if (b === c) {
    return {
      match: true,
      report: `HEAD matches baseline (${shortHash(b)}) — worktree plan still applies.`,
    };
  }
  return {
    match: false,
    report:
      `HEAD moved: ${shortHash(b)} → ${shortHash(c)} — rebase worktree ` +
      "branches before use (report-only, plan unchanged).",
  };
}
