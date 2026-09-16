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

import { MAX_OUTBOX_ENTRIES, type OutboxEntry } from "./outbox.ts";
import type {
  Project,
  ProjectSettings,
  ThreadProjectMap,
} from "./projects.ts";

export interface StoredSession {
  session_id: string;
  workspace: string;
  title: string;
  createdAt: number;
  /**
   * US-5: archived threads leave the main sidebar list for the collapsible
   * archived section. Persisted like the rest; absent = active (V1 data).
   */
  archived?: boolean;
}

/** Reasoning is persisted separately so it can be disclosed in the stream. */
export type LogRole = "user" | "assistant" | "thinking" | "subagent" | "system" | "tool";

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
  /** Drill-down into the child's own transcript (`session/read`). */
  childSessionId?: string;
  /** Sub-agent header facts from `item/started` (objective/role/depth). */
  objective?: string;
  subagentRole?: string;
  depth?: number;
  /**
   * M0-03 idempotency key on user entries: stable across retries of the
   * same logical send, so a retry reuses this entry instead of appending
   * a duplicate bubble.
   */
  clientMessageId?: string;
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
    typeof r.createdAt === "number" &&
    (r.archived === undefined || typeof r.archived === "boolean")
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
      r.role === "thinking" ||
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

/**
 * US-15 allowlist: persistent approval rules (extends this module's scope).
 * One rule memoizes a command pattern + scope with an allow/prompt/forbidden
 * decision. Stored under a dedicated localStorage key so it survives restarts
 * like sessions and logs; writes are best-effort like everything else here.
 */
export type AllowDecision = "allow" | "prompt" | "forbidden";

export interface AllowRule {
  id: string;
  /** Command pattern: substring or `*` glob, matched case-insensitively. */
  pattern: string;
  /** Host scope the rule was memorized from (command scope or network/domain). */
  scope: string;
  decision: AllowDecision;
  createdAt: number;
}

const ALLOWLIST_KEY = "muse-desktop.allowlist.v1";

/** Cap stored rules so a runaway memorizer stays bounded (cf. 2000/500 caps). */
export const MAX_ALLOWLIST_RULES = 200;

function isValidAllowRule(r: unknown): r is AllowRule {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.pattern === "string" &&
    o.pattern.length > 0 &&
    typeof o.scope === "string" &&
    (o.decision === "allow" || o.decision === "prompt" || o.decision === "forbidden") &&
    typeof o.createdAt === "number"
  );
}

export function loadAllowlist(): AllowRule[] {
  const raw = read<unknown>(ALLOWLIST_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidAllowRule).slice(-MAX_ALLOWLIST_RULES);
}

export function saveAllowlist(rules: AllowRule[]): void {
  write(ALLOWLIST_KEY, rules.slice(-MAX_ALLOWLIST_RULES));
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * US-3 + US-30 Projects: stored project list, thread→project map, and
 * global agent settings (per-project overrides live on the Project row in
 * ../lib/projects, inheriting these globals). Dedicated localStorage keys,
 * best-effort writes like everything else here.
 */
const PROJECTS_KEY = "muse-desktop.projects.v1";
const THREAD_PROJECTS_KEY = "muse-desktop.thread-projects.v1";
const GLOBAL_SETTINGS_KEY = "muse-desktop.settings.v1";

function isValidProjectRow(p: unknown): p is Project {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.name === "string" &&
    typeof r.instructions === "string" &&
    typeof r.createdAt === "number"
  );
}

export function loadProjects(): Project[] {
  const raw = read<unknown>(PROJECTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidProjectRow);
}

export function saveProjects(projects: Project[]): void {
  write(PROJECTS_KEY, projects);
}

export function loadThreadProjects(): ThreadProjectMap {
  const raw = read<unknown>(THREAD_PROJECTS_KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ThreadProjectMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

export function saveThreadProjects(map: ThreadProjectMap): void {
  write(THREAD_PROJECTS_KEY, map);
}

function isValidGlobalSettings(s: unknown): s is ProjectSettings {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.model === "string" &&
    (r.sandbox === "read-only" || r.sandbox === "workspace" || r.sandbox === "full") &&
    (r.networkDefault === "allow" || r.networkDefault === "prompt" || r.networkDefault === "deny") &&
    typeof r.autoCompact === "boolean"
  );
}

export function loadGlobalSettings(
  fallback: ProjectSettings,
): ProjectSettings {
  const raw = read<unknown>(GLOBAL_SETTINGS_KEY, null);
  if (!isValidGlobalSettings(raw)) return fallback;
  return raw;
}

export function saveGlobalSettings(settings: ProjectSettings): void {
  write(GLOBAL_SETTINGS_KEY, settings);
}

/**
 * M0-03 outbox: durable retryable outgoing messages, one key per session
 * (`sending` entries are recovered as failed/ambiguous on boot; `accepted`
 * ones are removed). Best-effort writes like everything else here — a
 * storage failure keeps the live send working, only restart-recovery loses
 * its safety net, which the UI reports as a plain send failure.
 */
const outboxKey = (sessionId: string) => `muse-desktop.outbox.v1.${sessionId}`;

function isValidOutboxEntry(e: unknown): e is OutboxEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.clientMessageId === "string" &&
    r.clientMessageId.length > 0 &&
    (r.serverCommandId === undefined ||
      (typeof r.serverCommandId === "string" && r.serverCommandId.length > 0)) &&
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.text === "string" &&
    typeof r.outgoingText === "string" &&
    (r.state === "sending" || r.state === "accepted" || r.state === "failed") &&
    (r.error === null || typeof r.error === "string") &&
    typeof r.ambiguous === "boolean" &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number" &&
    typeof r.attempts === "number"
  );
}

export function loadOutbox(sessionId: string): OutboxEntry[] {
  const raw = read<unknown>(outboxKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidOutboxEntry).slice(-MAX_OUTBOX_ENTRIES);
}

export function saveOutbox(sessionId: string, entries: OutboxEntry[]): void {
  write(outboxKey(sessionId), entries.slice(-MAX_OUTBOX_ENTRIES));
}

export function dropOutbox(sessionId: string): void {
  try {
    localStorage.removeItem(outboxKey(sessionId));
  } catch {
    // best-effort
  }
}
