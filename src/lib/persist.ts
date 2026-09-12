/**
 * Local persistence for muse-desktop (frontend side).
 *
 * - Session metadata list (id, workspace, title, createdAt).
 * - Append-only per-session message/event log, capped to the newest
 *   MAX_LOG_ENTRIES entries so a corrupt or huge history stays bounded.
 * - Last-selected workspace path.
 *
 * Everything lives in localStorage, so history survives app restarts and is
 * merged with the Rust supervisor's `restore_sessions` result on boot.
 * All writes are confined to these keys; nothing is written outside them.
 */

export interface StoredSession {
  session_id: string;
  workspace: string;
  title: string;
  createdAt: number;
}

export type LogRole = "user" | "assistant" | "subagent" | "system" | "tool";

export interface LogEntry {
  id: string;
  ts: number;
  role: LogRole;
  text: string;
  /** Sub-agent identity for `subagent` entries (grouping key). */
  agentId?: string;
  /** MSP item id: coalescing and completion target concurrent items precisely. */
  itemId?: string;
  /** True while further stream chunks may still be appended. */
  open?: boolean;
}

const SESSIONS_KEY = "muse-desktop.sessions.v1";
const WORKSPACE_KEY = "muse-desktop.workspace.v1";
const ACTIVE_KEY = "muse-desktop.active.v1";
const TOMBSTONES_KEY = "muse-desktop.tombstones.v1";
const logKey = (sessionId: string) => `muse-desktop.log.v1.${sessionId}`;

/** Cap per-session log length (mitigation for huge/corrupt histories). */
export const MAX_LOG_ENTRIES = 2000;

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
    // Quota or privacy mode: persistence is best-effort, the live
    // session keeps working in memory.
  }
}

function isValidSession(s: unknown): s is StoredSession {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.session_id === "string" &&
    r.session_id.length > 0 &&
    typeof r.workspace === "string" &&
    typeof r.title === "string" &&
    typeof r.createdAt === "number"
  );
}

function isValidEntry(e: unknown): e is LogEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.ts === "number" &&
    (r.role === "user" ||
      r.role === "assistant" ||
      r.role === "subagent" ||
      r.role === "system" ||
      r.role === "tool") &&
    typeof r.text === "string"
  );
}

export function loadSessions(): StoredSession[] {
  const raw = read<unknown>(SESSIONS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidSession);
}

export function saveSessions(sessions: StoredSession[]): void {
  write(SESSIONS_KEY, sessions);
}

/**
 * Tombstones: ids the user deleted. The MSP host has no session/stop, so a
 * killed session still exists server-side and would be resurrected by
 * `restore_sessions` or a late in-flight event. Tombstones (persisted, capped)
 * make deletion stick. Ids are UUIDv7: never reused, so no pruning by return.
 */
const MAX_TOMBSTONES = 500;

export function loadTombstones(): string[] {
  const raw = read<unknown>(TOMBSTONES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

export function saveTombstones(ids: string[]): void {
  write(TOMBSTONES_KEY, ids.slice(-MAX_TOMBSTONES));
}

export function loadLog(sessionId: string): LogEntry[] {
  const raw = read<unknown>(logKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  // Close any blocks left open across restarts so new stream chunks
  // start fresh entries instead of appending to a stale one.
  return raw
    .filter(isValidEntry)
    .slice(-MAX_LOG_ENTRIES)
    .map((e) => (e.open ? { ...e, open: false } : e));
}

/** Append entries to the stored log (append-only; oldest pruned past cap). */
export function appendLog(sessionId: string, entries: LogEntry[]): void {
  if (entries.length === 0) return;
  const cur = loadLog(sessionId);
  write(logKey(sessionId), [...cur, ...entries].slice(-MAX_LOG_ENTRIES));
}

/** Rewrite one session's log (used to persist streaming coalescing). */
export function saveLog(sessionId: string, entries: LogEntry[]): void {
  write(logKey(sessionId), entries.slice(-MAX_LOG_ENTRIES));
}

export function dropLog(sessionId: string): void {
  try {
    localStorage.removeItem(logKey(sessionId));
  } catch {
    // best-effort
  }
}

export function loadWorkspace(): string | null {
  const w = read<unknown>(WORKSPACE_KEY, null);
  return typeof w === "string" && w.length > 0 ? w : null;
}

export function saveWorkspace(path: string): void {
  write(WORKSPACE_KEY, path);
}

export function loadActiveId(): string | null {
  const v = read<unknown>(ACTIVE_KEY, null);
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function saveActiveId(id: string | null): void {
  if (id === null) {
    try {
      localStorage.removeItem(ACTIVE_KEY);
    } catch {
      // best-effort
    }
  } else {
    write(ACTIVE_KEY, id);
  }
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}
