/**
 * US-34 import of existing CLI/IDE config: surface resumable
 * sessions + a config summary. Import-only: merged entries never overwrite
 * existing ones (match by id, keep the local row on collision).
 *
 * Well-known local config paths read by the importer (documented here so
 * the UI can list them; the host reads the file bytes, this module only
 * parses + summarizes — dependency-light and `node:test`-safe):
 *
 * Muse CLI:
 *   - ~/.muse/config.json          (CLI global config)
 *   - ~/.muse/sessions/            (past CLI session transcripts)
 *   - <project>/.muse/settings.json (project overrides)
 * Codex CLI:
 *   - ~/.codex/config.toml         (CLI global config)
 *   - ~/.codex/sessions/           (past CLI session rollouts)
 * VSCode family:
 *   - ~/.config/Code/User/settings.json            (VSCode settings)
 *   - ~/.config/Code/User/prompts/                 (reusable prompts)
 * JetBrains family:
 *   - ~/.config/JetBrains/<product>/options/       (IDE options)
 * Zed:
 *   - ~/.config/zed/settings.json  (Zed settings)
 *
 * Persistence lives under `muse-desktop.import.v1` (imported resumable
 * sessions only); existing sessions/logs are never touched by an import.
 */

import { readStorageJson, writeStorageJson } from "./storage.ts";

export const IMPORT_KEY = "muse-desktop.import.v1";

/** Well-known config locations the importer knows how to summarize. */
export const KNOWN_CONFIG_PATHS: readonly string[] = [
  "~/.muse/config.json",
  "~/.muse/sessions/",
  "<project>/.muse/settings.json",
  "~/.codex/config.toml",
  "~/.codex/sessions/",
  "~/.config/Code/User/settings.json",
  "~/.config/Code/User/prompts/",
  "~/.config/JetBrains/<product>/options/",
  "~/.config/zed/settings.json",
];

/** One resumable session surfaced by an import (visible, never auto-run). */
export interface ResumableSession {
  id: string;
  title: string;
  source: string;
  workspace?: string;
  lastActive?: number;
}

/** Human-readable summary of one imported config file. */
export interface ImportSummary {
  source: string;
  sessions: ResumableSession[];
  notes: string[];
}

function readKey(key: string): unknown {
  return readStorageJson<unknown>(key, null);
}

function writeKey(key: string, value: unknown): void {
  writeStorageJson(key, value);
}

function isValidResumable(s: unknown): s is ResumableSession {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.title === "string" &&
    typeof r.source === "string" &&
    (r.workspace === undefined || typeof r.workspace === "string") &&
    (r.lastActive === undefined || typeof r.lastActive === "number")
  );
}

export function loadImportedSessions(): ResumableSession[] {
  const raw = readKey(IMPORT_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidResumable);
}

export function saveImportedSessions(sessions: ResumableSession[]): void {
  writeKey(IMPORT_KEY, sessions);
}

/** True when the path is one of (or under one of) the known locations. */
export function isKnownConfigPath(path: string): boolean {
  const p = path.trim();
  if (p.length === 0) return false;
  return KNOWN_CONFIG_PATHS.some((known) => {
    if (known.endsWith("/")) {
      const base = known.replace("<project>/", "").replace("~/", "");
      const bare = p.replace(/^<project>\//, "").replace(/^~\//, "");
      return bare.startsWith(base) || p === known;
    }
    return p === known;
  });
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function titleOf(obj: Record<string, unknown>, fallback: string): string {
  for (const k of ["title", "name", "topic", "label"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return clip(v, 80);
  }
  return fallback;
}

/**
 * Parse one imported config file's text into a summary. Never throws:
 * unparseable content yields zero sessions + one note explaining why.
 * JSON is tried first; TOML/unknown formats fall back to session-id
 * scanning (`session_id` values) so Codex `config.toml`-adjacent rollouts
 * still surface resumable ids.
 */
export function parseImportPayload(source: string, content: string): ImportSummary {
  const notes: string[] = [];
  const sessions: ResumableSession[] = [];
  const text = content.trim();
  if (text.length === 0) {
    return { source, sessions, notes: ["empty file: nothing to import"] };
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>).sessions)
          ? ((parsed as Record<string, unknown>).sessions as unknown[])
          : [parsed];
      let i = 0;
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;
        const id =
          (typeof obj.session_id === "string" && obj.session_id) ||
          (typeof obj.id === "string" && obj.id) ||
          `${source}#${i}`;
        const ws = typeof obj.workspace === "string" ? obj.workspace : undefined;
        const la = typeof obj.lastActive === "number" ? obj.lastActive : undefined;
        sessions.push({ id, title: titleOf(obj, `Imported ${id.slice(0, 8)}`), source, workspace: ws, lastActive: la });
        i++;
      }
      notes.push(`${sessions.length} session(s) found in ${source}`);
      return { source, sessions, notes };
    } catch {
      // fall through to id scanning
    }
  }
  const seen = new Set<string>();
  const re = /["']?(session_id|sessionId|id)["']?\s*[:=]\s*["']([A-Za-z0-9_-]{4,})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    sessions.push({ id, title: `Imported ${id.slice(0, 8)}`, source });
  }
  notes.push(
    sessions.length > 0
      ? `${sessions.length} session id(s) scanned in ${source} (non-JSON format)`
      : `no importable sessions found in ${source}`,
  );
  return { source, sessions, notes };
}

/**
 * Merge imported sessions into the stored resumable list. Import-only:
 * ids already present (imported before OR matching a live session id
 * passed via `liveIds`) are skipped — the existing row always wins, the
 * import never overwrites.
 */
export function mergeImportedSessions(
  current: ResumableSession[],
  incoming: ResumableSession[],
  liveIds: readonly string[] = [],
): ResumableSession[] {
  const live = new Set(liveIds);
  const known = new Set(current.map((s) => s.id));
  const next = [...current];
  for (const s of incoming) {
    if (known.has(s.id) || live.has(s.id)) continue;
    known.add(s.id);
    next.push(s);
  }
  return next;
}

/** Drop one imported resumable session (dismiss). Unknown ids = no-op. */
export function dismissImportedSession(
  current: ResumableSession[],
  id: string,
): ResumableSession[] {
  if (!current.some((s) => s.id === id)) return current;
  return current.filter((s) => s.id !== id);
}
