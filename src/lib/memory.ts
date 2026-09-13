/**
 * US-20 memory + anti-drift: dated/sourced memory entries with stale
 * warnings and a periodic SCAN nudge.
 *
 * Zero imports: runnable under the built-in node:test runner and reusable
 * from the Composer and the hook without side effects.
 *
 * - A memory entry is `{ id, text, source, createdAt }` (AC: datée/sourcée).
 * - Entries older than STALE_AFTER_MS (30 days) are stale: callers must
 *   surface the age badge / warning and never silently override current
 *   evidence with a stale entry (stale 0.92-1.00 [arXiv] per SPEC US-20).
 * - Entries are @-mentionable as `@mem/<id-prefix>` chips: expansion
 *   inlines the entry text flagged with source + age (stale flagged).
 * - The SCAN nudge is a lightweight periodic reminder (re-répétition
 *   allégée 20-300 tokens [HN]) to review memories, not an auto-rewrite.
 *
 * Persistence lives under `muse-desktop.memory.*` localStorage keys,
 * best-effort like persist.ts / compact.ts.
 */

/** One remembered fact: free-form text + where it came from + when. */
export interface MemoryEntry {
  id: string;
  text: string;
  /** Free-form origin: `user`, `slack`, `notion`, `docs`, `codebase`, … */
  source: string;
  /** Epoch ms when the entry was recorded. */
  createdAt: number;
}

/** Age past which an entry is stale and must carry an explicit warning. */
export const STALE_AFTER_MS = 30 * 24 * 3600 * 1000;

/** Cap stored entries so a runaway memorizer stays bounded (cf. 200/500). */
export const MAX_MEMORIES = 200;

/** Max chars kept per entry (keeps chips + send payload small). */
export const MAX_MEMORY_TEXT = 1000;

/**
 * Cadence of the SCAN review nudge. Judgment call (SPEC gives no cadence):
 * daily is frequent enough to catch drift, light enough to dismiss.
 */
export const SCAN_INTERVAL_MS = 24 * 3600 * 1000;

export const MEMORY_KEY = "muse-desktop.memory.v1";
export const MEMORY_SCAN_KEY = "muse-desktop.memory.scan.v1";

/** `@mem/<id-prefix>` token found in composer text (offsets kept). */
export interface MemoryMentionToken {
  idPrefix: string;
  start: number;
  end: number;
}

const DAY_MS = 24 * 3600 * 1000;

function newMemoryId(now: number): string {
  return `m${now.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Whole days since the entry was recorded (clamped at 0: future-dated
 * entries from clock skew read as "today", never negative).
 */
export function ageDays(entry: MemoryEntry, now: number): number {
  return Math.max(0, Math.floor((now - entry.createdAt) / DAY_MS));
}

/** True when the entry is older than 30 days (stale → warning mandatory). */
export function isStale(entry: MemoryEntry, now: number): boolean {
  return now - entry.createdAt > STALE_AFTER_MS;
}

/** Short age badge: `aujourd'hui`, `12 j`, or `45 j · stale`. */
export function ageLabel(entry: MemoryEntry, now: number): string {
  const d = ageDays(entry, now);
  if (d < 1) return "aujourd'hui";
  return isStale(entry, now) ? `${d} j · stale` : `${d} j`;
}

/** Build an entry, or null when the text is blank (never store empties). */
export function createMemory(text: string, source: string, now: number): MemoryEntry | null {
  if (text.trim().length === 0) return null;
  return {
    id: newMemoryId(now),
    text: clip(text, MAX_MEMORY_TEXT),
    source: source.trim() === "" ? "user" : source.trim().slice(0, 60),
    createdAt: now,
  };
}

/** Append an entry (blank text is a no-op returning the list unchanged). */
export function addMemory(
  entries: MemoryEntry[],
  text: string,
  source: string,
  now: number,
): MemoryEntry[] {
  const entry = createMemory(text, source, now);
  if (entry === null) return entries;
  return [...entries, entry].slice(-MAX_MEMORIES);
}

/** Remove one entry by id (unknown id returns the list unchanged). */
export function removeMemory(entries: MemoryEntry[], id: string): MemoryEntry[] {
  if (!entries.some((e) => e.id === id)) return entries;
  return entries.filter((e) => e.id !== id);
}

/** Entries older than 30 days, oldest first (the review backlog). */
export function staleMemories(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return entries
    .filter((e) => isStale(e, now))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Short chip label for pickers: first line clipped to 42 chars. */
export function memoryChipLabel(entry: MemoryEntry): string {
  const oneLine = entry.text.replace(/\s+/g, " ").trim();
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}…` : oneLine;
}

/** The `@`-token addressing this entry (`@mem/<first 8 of id>`). */
export function memoryMentionQuery(entry: MemoryEntry): string {
  return `mem/${entry.id.slice(0, 8)}`;
}

/**
 * List every `@mem/<prefix>` token in `text`, in order. Same token-start
 * guard as mentions.ts: the `@` must open the string or follow
 * whitespace/opening punctuation (skips emails like `a@mem/x`).
 */
export function parseMemoryMentions(text: string): MemoryMentionToken[] {
  const out: MemoryMentionToken[] = [];
  const re = /@mem\/([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(text);
    if (m === null) break;
    const before = m.index === 0 ? "" : text[m.index - 1];
    if (before !== "" && !/[\s([{"'‘“>]/.test(before)) continue;
    out.push({ idPrefix: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Resolve an id prefix to its entry (first id match wins). Empty prefix
 * never matches: `@mem/` alone is not a reference.
 */
export function findMemoryByPrefix(
  entries: MemoryEntry[],
  idPrefix: string,
): MemoryEntry | null {
  if (idPrefix.length === 0) return null;
  return entries.find((e) => e.id.startsWith(idPrefix)) ?? null;
}

/**
 * Expand `@mem/<prefix>` tokens into quoted context blocks. Stale entries
 * are inlined FLAGGED (`stale — à vérifier`, never a silent override);
 * unknown prefixes are left verbatim and reported in `missing` so the
 * caller can warn instead of silently dropping them.
 */
export function expandMemoryMentions(
  text: string,
  entries: MemoryEntry[],
  now: number,
): { text: string; used: MemoryEntry[]; missing: string[] } {
  const tokens = parseMemoryMentions(text);
  if (tokens.length === 0) return { text, used: [], missing: [] };
  const used: MemoryEntry[] = [];
  const missing: string[] = [];
  let out = "";
  let cursor = 0;
  for (const t of tokens) {
    out += text.slice(cursor, t.start);
    const entry = findMemoryByPrefix(entries, t.idPrefix);
    if (entry === null) {
      out += text.slice(t.start, t.end);
      if (!missing.includes(t.idPrefix)) missing.push(t.idPrefix);
    } else {
      if (!used.some((u) => u.id === entry.id)) used.push(entry);
      const stale = isStale(entry, now);
      out +=
        `> [mémoire ${entry.source} · ${ageLabel(entry, now)}] ${entry.text}` +
        (stale ? "\n> ⚠ stale (> 30 j) — à vérifier, ne pas écraser la preuve courante" : "");
    }
    cursor = t.end;
  }
  out += text.slice(cursor);
  return { text: out, used, missing };
}

/**
 * True when a SCAN review nudge is due: never scanned, or the last review
 * is older than SCAN_INTERVAL_MS. Empty memory stores never nudge.
 */
export function shouldScanNudge(
  entryCount: number,
  lastScanAt: number | null,
  now: number,
): boolean {
  if (entryCount === 0) return false;
  if (lastScanAt === null) return true;
  return now - lastScanAt >= SCAN_INTERVAL_MS;
}

/**
 * Lightweight SCAN nudge entry (short by design, well under ~300 tokens):
 * counts + stale backlog pointer. A reminder to review, never an
 * auto-rewrite of the store.
 */
export function buildScanNudge(entries: MemoryEntry[], now: number): string {
  const stale = staleMemories(entries, now).length;
  const oldest =
    entries.length > 0
      ? ageLabel(
          entries.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b)),
          now,
        )
      : "—";
  return (
    `SCAN mémoire (${entries.length} entrée(s), plus ancienne : ${oldest}) : ` +
    (stale > 0
      ? `${stale} entrée(s) stale (> 30 j) — relire avant usage.`
      : `aucune entrée stale — rien à revoir.`)
  );
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort like persist.ts: the UI keeps working in memory
  }
}

function isValidMemory(e: unknown): e is MemoryEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    typeof r.source === "string" &&
    typeof r.createdAt === "number"
  );
}

export function loadMemories(): MemoryEntry[] {
  const raw = read<unknown>(MEMORY_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidMemory).slice(-MAX_MEMORIES);
}

export function saveMemories(entries: MemoryEntry[]): void {
  write(MEMORY_KEY, entries.slice(-MAX_MEMORIES));
}

export function loadLastScan(): number | null {
  const v = read<unknown>(MEMORY_SCAN_KEY, null);
  return typeof v === "number" && v >= 0 ? v : null;
}

export function saveLastScan(at: number): void {
  write(MEMORY_SCAN_KEY, at);
}
