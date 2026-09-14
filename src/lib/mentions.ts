/**
 * Pure helpers for @-mentions of workspace files/folders (US-18).
 *
 * No imports: safe to unit-test on the built-in node:test runner and to
 * reuse from the Composer. Scope verdicts here are a client-side fallback
 * (path containment under the workspace root); when the backend exposes a
 * `check_scope` command (US-22 parallel workstream) the Composer prefers it
 * and only falls back to these helpers when the command is missing.
 */

/** One `@query` token found in composer text (offsets into the string). */
export interface MentionToken {
  query: string;
  start: number;
  end: number;
}

/** A token resolved against a workspace root. */
export interface ResolvedMention extends MentionToken {
  /** Absolute, dot-normalized path the query points at. */
  absPath: string;
  /** Workspace-relative display form (`..` when it escapes the root). */
  relPath: string;
  /** False when the target escapes the workspace root. */
  inScope: boolean;
}

/** Chars allowed inside a mention query (paths, no whitespace). */
const QUERY_RE = /@([A-Za-z0-9_./~+~-]*)/g;

/**
 * List every `@query` token in `text`, in order. An `@` followed by
 * whitespace or punctuation (e.g. a lone "@" or an email "a@b") yields no
 * token; an `@` at end-of-input yields an empty query (completion just
 * opened).
 */
export function parseMentions(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  QUERY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  for (;;) {
    m = QUERY_RE.exec(text);
    if (m === null) break;
    // Skip email-like `user@host`: the @ must start a token (start of
    // string or preceded by whitespace/opening punctuation).
    const before = m.index === 0 ? "" : text[m.index - 1];
    if (before !== "" && !/[\s([{"'‘“>]/.test(before)) continue;
    if (m[1].length === 0) {
      // Lone "@": only a token when it ends the text (typing in progress).
      if (m.index + 1 !== text.length) continue;
    }
    out.push({ query: m[1], start: m.index, end: m.index + 1 + m[1].length });
  }
  return out;
}

/**
 * Active token under `caret` (completion target), or null. The caret must
 * sit inside or right at the end of the token.
 */
export function findMentionAt(text: string, caret: number): MentionToken | null {
  for (const t of parseMentions(text)) {
    if (caret >= t.start && caret <= t.end) return t;
  }
  return null;
}

/** Split a path on both separators, dropping empty segments. */
function splitSegs(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Dot-normalize segments (`a/./b`, `a/../b`); leading `..` are kept. */
function normalizeSegs(segs: string[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s === ".") continue;
    if (s === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(s);
    }
  }
  return out;
}

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Join with forward slashes (display/wire form, not OS form). */
function joinAbs(rootSegs: string[], prefix: string, rel: string): string {
  const parts = [...rootSegs, ...splitSegs(rel)];
  return `${prefix}${normalizeSegs(parts).join("/")}`;
}

/**
 * Resolve `query` against `workspaceRoot`.
 * - `~/x` → treated as absolute outside the workspace (home dir).
 * - `/abs` or `C:\abs` → absolute, scope = containment in the root.
 * - `rel/path` → rooted at the workspace.
 * - `../escape` → escapes the root → out of scope.
 */
export function resolveMention(workspaceRoot: string, query: string): ResolvedMention {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const rootSegs = splitSegs(root);
  const prefix = /^[A-Za-z]:/.test(root) ? `${rootSegs[0]}/` : "/";
  const rootNorm = `${prefix}${normalizeSegs(rootSegs.slice(/^[A-Za-z]:$/.test(rootSegs[0] ?? "") ? 1 : 0)).join("/")}`;

  let absPath: string;
  if (query.startsWith("~/") || query === "~") {
    absPath = query; // home-relative: not resolvable against the workspace
  } else if (isAbs(query)) {
    const q = query.replace(/\\/g, "/");
    const drive = /^([A-Za-z]:)/.exec(q)?.[1] ?? "";
    const rest = splitSegs(drive ? q.slice(2) : q);
    absPath = `${drive ? `${drive}/` : "/"}${normalizeSegs(rest).join("/")}`;
  } else {
    absPath = joinAbs(
      /^[A-Za-z]:$/.test(rootSegs[0] ?? "") ? rootSegs.slice(1) : rootSegs,
      prefix,
      query,
    );
  }

  const inScope = absPath === rootNorm || absPath.startsWith(`${rootNorm}/`);
  let relPath: string;
  if (absPath === rootNorm) relPath = ".";
  else if (inScope) relPath = absPath.slice(rootNorm.length + 1);
  else if (absPath.startsWith("~/") || absPath === "~") relPath = absPath;
  else {
    // Relative escape path (`../..`) for display.
    const a = splitSegs(absPath);
    const r = splitSegs(rootNorm);
    let common = 0;
    while (common < a.length && common < r.length && a[common] === r[common]) common++;
    relPath = [...Array<string>(r.length - common).fill(".."), ...a.slice(common)].join("/") || ".";
  }
  return { query, start: -1, end: -1, absPath, relPath, inScope };
}

/**
 * Resolve every token in `text` against the workspace root (offsets kept).
 */
export function resolveMentions(workspaceRoot: string, text: string): ResolvedMention[] {
  return parseMentions(text).map((t) => ({ ...resolveMention(workspaceRoot, t.query), start: t.start, end: t.end }));
}

/**
 * Build the enriched send payload: each in-scope `@query` is replaced by
 * its backticked absolute path; out-of-scope tokens are left verbatim (the
 * caller blocks the send until permission is granted).
 */
export function buildEnrichedText(workspaceRoot: string, text: string): { text: string; mentions: ResolvedMention[] } {
  const mentions = resolveMentions(workspaceRoot, text);
  if (mentions.length === 0) return { text, mentions };
  let out = "";
  let cursor = 0;
  for (const m of mentions) {
    out += text.slice(cursor, m.start);
    out += m.inScope ? `\`${m.absPath}\`` : text.slice(m.start, m.end);
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, mentions };
}

/**
 * Normalize a `check_scope` backend verdict (US-22) to granted/denied.
 * Accepts the object shape `{ in_scope: boolean }` as well as legacy
 * boolean/string grants, so the Composer never treats a truthy object as
 * an allow. Unknown shapes deny (fail closed).
 */
export function interpretScopeVerdict(granted: unknown): boolean {
  if (granted === true) return true;
  if (typeof granted === "string") {
    const v = granted.toLowerCase();
    return v === "allow" || v === "granted" || v === "true";
  }
  if (typeof granted === "object" && granted !== null) {
    const rec = granted as Record<string, unknown>;
    if (typeof rec.in_scope === "boolean") return rec.in_scope;
    if (typeof rec.inScope === "boolean") return rec.inScope;
  }
  return false;
}

/**
 * Error message used when the send is blocked on out-of-scope mentions and
 * no `check_scope` backend command exists (US-22 not yet merged).
 */
export function outOfScopeMessage(mentions: ResolvedMention[]): string {
  const paths = mentions.filter((m) => !m.inScope).map((m) => m.absPath);
  return `Out-of-workspace mention${paths.length > 1 ? "s" : ""} blocked (${paths.join(", ")}): granting access needs the workspace permission flow (check_scope, US-22).`;
}
