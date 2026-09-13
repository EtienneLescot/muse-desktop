/**
 * US-23 (w-index): opt-in local file index + search.
 *
 * Zero imports (no React, no Tauri): safe to unit-test on the built-in
 * node:test runner. The index is built from caller-supplied file snapshots
 * (the browser/Tauri webview has no direct fs access), so every function
 * below is pure except the small localStorage helpers at the bottom, which
 * are best-effort and guarded for non-DOM runtimes.
 *
 * - Opt-in: indexing only runs when the caller enables it (default off;
 *   see INDEX_ENABLED_KEY). Nothing here reads the disk on its own.
 * - Formats: exactly the extensions with an implemented line parser below
 *   (SUPPORTED_EXTENSIONS). Parsers are line splitters per format; the list
 *   shown in the UI is derived from this constant, never hardcoded twice.
 * - Exclusions: common build/vendor dirs (EXCLUDED_DIRS) plus .gitignore
 *   rules parsed from the workspace root .gitignore when supplied.
 * - Refresh is on-demand and mtime-based (rescanIndex): snapshots carry
 *   mtimeMs, unchanged entries are reused, no watcher dependency.
 */

export interface FileSnapshot {
  /** Workspace-relative path with `/` separators, e.g. `src/lib/x.ts`. */
  path: string;
  /** Modification stamp (File.lastModified or stat mtime). */
  mtimeMs: number;
  content: string;
}

export interface IndexedEntry {
  path: string;
  mtimeMs: number;
  lines: string[];
}

export interface IndexStore {
  files: Record<string, IndexedEntry>;
  /** Last successful build/rescan epoch ms, null when never built. */
  builtAt: number | null;
}

export interface LineHit {
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface RescanSummary {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

/**
 * Supported formats, listed explicitly from the implemented parsers only.
 * Each entry below has a corresponding branch in parseContentLines; the
 * panel renders this constant so the UI can never drift from reality.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".md",
  ".rs",
  ".json",
];

/** Directory names never indexed, at any depth (build output, VCS, deps). */
export const EXCLUDED_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "target",
  ".git",
  ".next",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
];

/** Bounds so a huge workspace cannot blow the localStorage quota. */
export const MAX_INDEX_FILES = 2000;
export const MAX_LINES_PER_FILE = 5000;
export const MAX_LINE_LENGTH = 2000;

export const INDEX_ENABLED_KEY = "muse-desktop.index.enabled.v1";
export const INDEX_DATA_KEY = "muse-desktop.index.data.v1";

export function emptyStore(): IndexStore {
  return { files: {}, builtAt: null };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function extensionOf(path: string): string {
  const base = normalizePath(path).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** True only for extensions with an implemented parser (see list above). */
export function isSupportedFile(path: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** True when any path segment is a common build/vendor/output directory. */
export function isExcludedDir(path: string): boolean {
  const segments = normalizePath(path).split("/");
  return segments.some((seg) =>
    (EXCLUDED_DIRS as readonly string[]).includes(seg),
  );
}

/**
 * Parse .gitignore text into raw patterns: drops blanks and `#` comments,
 * keeps ordering (later patterns override earlier ones, including `!`).
 */
export function parseGitignore(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Single gitignore pattern → RegExp over a normalized relative path.
 * Supports `*` (within a segment), `**` (across segments), trailing `/`
 * (directory prefix), and leading `/` (root-anchored; treated the same as
 * unanchored here since paths are already workspace-relative).
 */
function gitignorePatternToRegExp(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (p.length === 0) return null;
  if (p.startsWith("!")) p = p.slice(1).trim();
  if (p.length === 0) return null;
  if (p.startsWith("/")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  if (p.length === 0) return null;
  const parts = p.split("/");
  const anchored = parts.length > 1;
  let body = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) body += "/";
    const seg = parts[i];
    let segRe = "";
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j];
      if (c === "*" && seg[j + 1] === "*") {
        segRe += ".*";
        j++;
        if (seg[j + 1] === "/") {
          j++;
        }
      } else if (c === "*") {
        segRe += "[^/]*";
      } else if (c === "?") {
        segRe += "[^/]";
      } else {
        segRe += escapeRegExp(c);
      }
    }
    body += segRe;
  }
  if (dirOnly) body += "(?:/.*)?";
  const src = anchored ? `^(?:${body})(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/**
 * gitignore match with negation: later patterns override earlier ones, so
 * `["*.log", "!keep.log"]` ignores every log except keep.log.
 */
export function matchesGitignore(patterns: string[], path: string): boolean {
  const rel = normalizePath(path);
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.trim().startsWith("!");
    const re = gitignorePatternToRegExp(raw);
    if (re === null) continue;
    if (re.test(rel)) ignored = !negated;
  }
  return ignored;
}

/**
 * Full eligibility gate: supported parser + not a build/vendor dir + not
 * .gitignore-ignored. The .gitignore file itself is never indexed.
 */
export function shouldIndexPath(path: string, gitignorePatterns: string[] = []): boolean {
  const rel = normalizePath(path);
  if (rel === ".gitignore") return false;
  if (!isSupportedFile(rel)) return false;
  if (isExcludedDir(rel)) return false;
  if (matchesGitignore(gitignorePatterns, rel)) return false;
  return true;
}

/**
 * Line parser per format. Every SUPPORTED_EXTENSIONS entry is handled:
 * code/JSON split plainly on newlines; Markdown additionally drops
 * fenced-code info-string backticks? No — Markdown lines are kept verbatim
 * so search hits match the source; only overlong lines are clipped.
 */
export function parseContentLines(path: string, content: string): string[] {
  const ext = extensionOf(path);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_LINES_PER_FILE) lines.length = MAX_LINES_PER_FILE;
  return lines.map((l) =>
    l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) : l,
  );
}

/** Index every eligible snapshot; ineligible ones are skipped silently. */
export function buildIndex(
  snapshots: FileSnapshot[],
  gitignorePatterns: string[] = [],
): IndexStore {
  const files: Record<string, IndexedEntry> = {};
  const seen = new Set<string>();
  for (const snap of snapshots) {
    const rel = normalizePath(snap.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (Object.keys(files).length >= MAX_INDEX_FILES) break;
    if (!shouldIndexPath(rel, gitignorePatterns)) continue;
    files[rel] = {
      path: rel,
      mtimeMs: snap.mtimeMs,
      lines: parseContentLines(rel, snap.content),
    };
  }
  return { files, builtAt: Date.now() };
}

/**
 * On-demand mtime-based rescan: snapshots with an unchanged mtime reuse the
 * previous entry (no reparse); new/changed mtimes are (re)indexed; entries
 * with no snapshot, or newly ineligible, are dropped. Pure + synchronous.
 */
export function rescanIndex(
  prev: IndexStore,
  snapshots: FileSnapshot[],
  gitignorePatterns: string[] = [],
): { store: IndexStore; summary: RescanSummary } {
  const files: Record<string, IndexedEntry> = {};
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const snap of snapshots) {
    const rel = normalizePath(snap.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (Object.keys(files).length >= MAX_INDEX_FILES) break;
    if (!shouldIndexPath(rel, gitignorePatterns)) continue;
    const old = prev.files[rel];
    if (old !== undefined && old.mtimeMs === snap.mtimeMs) {
      files[rel] = old;
      unchanged++;
    } else if (old !== undefined) {
      files[rel] = {
        path: rel,
        mtimeMs: snap.mtimeMs,
        lines: parseContentLines(rel, snap.content),
      };
      updated++;
    } else {
      files[rel] = {
        path: rel,
        mtimeMs: snap.mtimeMs,
        lines: parseContentLines(rel, snap.content),
      };
      added++;
    }
  }
  const removed = Object.keys(prev.files).filter((p) => !(p in files)).length;
  return { store: { files, builtAt: Date.now() }, summary: { added, updated, removed, unchanged } };
}

/**
 * Case-insensitive substring search over indexed lines. Returns path + line
 * hits (1-based), capped at maxHits in deterministic path/line order.
 */
export function searchIndex(
  store: IndexStore,
  query: string,
  maxHits = 100,
): LineHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const hits: LineHit[] = [];
  const paths = Object.keys(store.files).sort();
  for (const p of paths) {
    const entry = store.files[p];
    for (let i = 0; i < entry.lines.length; i++) {
      if (entry.lines[i].toLowerCase().includes(q)) {
        hits.push({ path: p, line: i + 1, text: entry.lines[i] });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

export function indexStats(store: IndexStore): { files: number; lines: number } {
  let lines = 0;
  const paths = Object.keys(store.files);
  for (const p of paths) lines += store.files[p].lines.length;
  return { files: paths.length, lines };
}

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Quota or privacy mode: persistence is best-effort, the in-memory
    // index keeps working.
  }
}

function storageRemove(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

/** Opt-in flag, default off: no index exists until the user enables it. */
export function loadIndexEnabled(): boolean {
  return storageGet(INDEX_ENABLED_KEY) === "1";
}

export function saveIndexEnabled(enabled: boolean): void {
  if (enabled) storageSet(INDEX_ENABLED_KEY, "1");
  else storageRemove(INDEX_ENABLED_KEY);
}

function isValidEntry(e: unknown): e is IndexedEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.mtimeMs === "number" &&
    Array.isArray(r.lines) &&
    r.lines.every((l) => typeof l === "string")
  );
}

export function loadIndexData(): IndexStore {
  try {
    const raw = storageGet(INDEX_DATA_KEY);
    if (raw === null) return emptyStore();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return emptyStore();
    }
    const filesRaw = obj.files;
    if (typeof filesRaw !== "object" || filesRaw === null || Array.isArray(filesRaw)) {
      return emptyStore();
    }
    const files: Record<string, IndexedEntry> = {};
    for (const [k, v] of Object.entries(filesRaw as Record<string, unknown>)) {
      if (isValidEntry(v)) files[k] = v;
    }
    const builtAt = typeof obj.builtAt === "number" ? obj.builtAt : null;
    return { files, builtAt };
  } catch {
    return emptyStore();
  }
}

export function saveIndexData(store: IndexStore): void {
  try {
    storageSet(INDEX_DATA_KEY, JSON.stringify(store));
  } catch {
    // best-effort (quota): the in-memory index keeps working
  }
}

export function dropIndexData(): void {
  storageRemove(INDEX_DATA_KEY);
}
