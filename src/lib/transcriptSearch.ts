import type { LogEntry, LogRole } from "./persist";

/** Keep the in-transcript finder responsive even when a log is large/corrupt. */
export const MAX_TRANSCRIPT_QUERY_CHARS = 160;
export const MAX_TRANSCRIPT_HITS = 80;
export const MAX_TRANSCRIPT_EXCERPT_CHARS = 180;

export interface TranscriptHit {
  index: number;
  entryId: string;
  role: LogRole;
  excerpt: string;
}

function excerpt(text: string, matchAt: number): string {
  if (text.length <= MAX_TRANSCRIPT_EXCERPT_CHARS) return text;
  const half = Math.floor(MAX_TRANSCRIPT_EXCERPT_CHARS / 2);
  const start = Math.max(0, Math.min(matchAt - half, text.length - MAX_TRANSCRIPT_EXCERPT_CHARS));
  const end = Math.min(text.length, start + MAX_TRANSCRIPT_EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Search the complete durable transcript, including rows outside the DOM window. */
export function searchTranscript(
  entries: Pick<LogEntry, "id" | "role" | "text">[],
  query: string,
  maxHits = MAX_TRANSCRIPT_HITS,
): TranscriptHit[] {
  const needle = query.trim().slice(0, MAX_TRANSCRIPT_QUERY_CHARS).toLocaleLowerCase();
  if (!needle) return [];
  const requested = Number.isFinite(maxHits) ? Math.floor(maxHits) : MAX_TRANSCRIPT_HITS;
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_HITS, requested));
  const hits: TranscriptHit[] = [];
  for (let index = 0; index < entries.length && hits.length < limit; index += 1) {
    const entry = entries[index];
    const text = entry.text;
    const matchAt = text.toLocaleLowerCase().indexOf(needle);
    if (matchAt < 0) continue;
    hits.push({
      index,
      entryId: entry.id,
      role: entry.role,
      excerpt: excerpt(text, matchAt),
    });
  }
  return hits;
}
