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

import { normalizeOutboxEntries, MAX_OUTBOX_ENTRIES, type OutboxEntry } from "./outbox.ts";
import type {
  Project,
  ProjectSettings,
  ThreadProjectMap,
} from "./projects.ts";
import { normalizeReasoningEffort } from "./reasoning.ts";
import type { WorktreeRecord } from "./worktrees.ts";
import type { GitTurnSnapshot } from "./git.ts";
import {
  readStorageJson,
  removeStorageKey,
  writeStorageJson,
} from "./storage.ts";
import type { EngineErrorDetails } from "./engineError.ts";
import { isSubagentStatus, type SubagentStatus } from "./subagent.ts";

export interface StoredSession {
  session_id: string;
  workspace: string;
  title: string;
  createdAt: number;
  /** Last model requested for this conversation when the host omits it. */
  model_id?: string;
  /** Latest branch observation supplied by the session host, when known. */
  branch?: string;
  /** Host-reported persistence posture; absent in older local rows. */
  session_durability?: string;
  /**
   * US-5: archived threads leave the main sidebar list for the collapsible
   * archived section. Persisted like the rest; absent = active (V1 data).
   */
  archived?: boolean;
  /** US-5/M1-12: pinned conversations stay at the top of the active list. */
  pinned?: boolean;
  /** US-5/M1-12: explicit unread marker for responses in another thread. */
  unread?: boolean;
  /** US-5/M1-12: manual order within the same pinned/running tier. */
  sortOrder?: number;
}

/** Reasoning is persisted separately so it can be disclosed in the stream. */
export type LogRole = "user" | "assistant" | "thinking" | "subagent" | "system" | "tool";

/** Bounded metadata for host-provided rich output (bytes stay behind outputRef). */
export interface RichContent {
  type: string;
  mediaType: string;
  path: string;
  sourceToolName: string;
  width?: number;
  height?: number;
}

export interface LogEntry {
  id: string;
  ts: number;
  role: LogRole;
  text: string;
  /** Sub-agent identity for `subagent` entries (grouping key). */
  agentId?: string;
  /** MSP item id: coalescing and completion target concurrent items precisely. */
  itemId?: string;
  /** MSP turn id owning this item; enables an exact conversation fork anchor. */
  turnId?: string;
  /** Host item revision used to apply idempotent `item/updated` snapshots. */
  itemRevision?: number;
  /** Opaque host reference for lazily loading a large item output. */
  outputRef?: string;
  /** Host-provided rich output metadata; payload bytes are never persisted here. */
  richContent?: RichContent[];
  /** True while further stream chunks may still be appended. */
  open?: boolean;
  /** Drill-down into the child's own transcript (`session/read`). */
  childSessionId?: string;
  /**
   * Host-internal child item (`reminderchild`): it keeps its own lane so its
   * text can never merge into the answer, but it is not a controllable
   * sub-agent and is never rendered as one.
   */
  subagentInternal?: boolean;
  /** Sub-agent header facts from `item/started` (objective/role/depth). */
  objective?: string;
  subagentRole?: string;
  depth?: number;
  /** Host-confirmed lifecycle state for a sub-agent block. */
  subagentStatus?: SubagentStatus;
  /**
   * M0-03 idempotency key on user entries: stable across retries of the
   * same logical send, so a retry reuses this entry instead of appending
   * a duplicate bubble.
   */
  clientMessageId?: string;
  /** M0-07: structured terminal failure details, when a turn failed. */
  engineError?: EngineErrorDetails;
}

const SESSIONS_KEY = "muse-desktop.sessions.v1";
const WORKSPACE_KEY = "muse-desktop.workspace.v1";
const ACTIVE_KEY = "muse-desktop.active.v1";
const TOMBSTONES_KEY = "muse-desktop.tombstones.v1";
const logKey = (sessionId: string) => `muse-desktop.log.v1.${sessionId}`;
const gitTurnSnapshotKey = (sessionId: string) => `muse-desktop.git-turn.v1.${sessionId}`;

/** Cap per-session log length (mitigation for huge/corrupt histories). */
export const MAX_LOG_ENTRIES = 2000;

function read<T>(key: string, fallback: T): T {
  return readStorageJson(key, fallback);
}

function write(key: string, value: unknown): void {
  // Quota or privacy mode remains best-effort; the facade records the issue
  // for an optional recovery banner while the live session keeps working.
  writeStorageJson(key, value);
}

function isValidGitTurnSnapshot(value: unknown): value is GitTurnSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.clientMessageId !== "string" ||
    row.clientMessageId.length === 0 ||
    (row.turnId !== null && row.turnId !== undefined && typeof row.turnId !== "string") ||
    typeof row.capturedAt !== "number" ||
    !Number.isFinite(row.capturedAt) ||
    !["captured", "running", "queued", "completed", "failed"].includes(String(row.phase))
  ) return false;
  const status = row.status;
  if (typeof status !== "object" || status === null || Array.isArray(status)) return false;
  const state = status as Record<string, unknown>;
  if (
    typeof state.repoRoot !== "string" ||
    typeof state.fingerprint !== "string" ||
    !Array.isArray(state.files) ||
    state.files.length > 500
  ) return false;
  return state.files.every((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return false;
    const row = file as Record<string, unknown>;
    return typeof row.path === "string" &&
      (row.originalPath === null || row.originalPath === undefined || typeof row.originalPath === "string") &&
      typeof row.indexStatus === "string" &&
      typeof row.worktreeStatus === "string" &&
      typeof row.changeType === "string" &&
      typeof row.staged === "boolean" &&
      typeof row.unstaged === "boolean" &&
      typeof row.untracked === "boolean" &&
      typeof row.conflicted === "boolean" &&
      typeof row.binary === "boolean";
  });
}

/** Load the latest explicit repository baseline for one conversation. */
export function loadGitTurnSnapshot(sessionId: string): GitTurnSnapshot | null {
  const value = read<unknown>(gitTurnSnapshotKey(sessionId), null);
  return isValidGitTurnSnapshot(value) ? value : null;
}

/** Persist one bounded repository baseline without making it part of the log. */
export function saveGitTurnSnapshot(sessionId: string, snapshot: GitTurnSnapshot): void {
  write(gitTurnSnapshotKey(sessionId), snapshot);
}

/** Remove the baseline together with a deleted conversation. */
export function dropGitTurnSnapshot(sessionId: string): void {
  removeStorageKey(gitTurnSnapshotKey(sessionId));
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
    (r.model_id === undefined || (typeof r.model_id === "string" && r.model_id.trim().length > 0)) &&
    (r.branch === undefined || (typeof r.branch === "string" && r.branch.trim().length > 0)) &&
    (r.session_durability === undefined ||
      (typeof r.session_durability === "string" && r.session_durability.trim().length > 0)) &&
    (r.archived === undefined || typeof r.archived === "boolean") &&
    (r.pinned === undefined || typeof r.pinned === "boolean") &&
    (r.unread === undefined || typeof r.unread === "boolean") &&
    (r.sortOrder === undefined || (typeof r.sortOrder === "number" && Number.isFinite(r.sortOrder)))
  );
}

function isValidEntry(e: unknown): e is LogEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  const error = r.engineError;
  const validEngineError =
    error === undefined ||
    (typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      typeof (error as Record<string, unknown>).kind === "string" &&
      typeof (error as Record<string, unknown>).message === "string" &&
      typeof (error as Record<string, unknown>).retryable === "boolean" &&
      ((error as Record<string, unknown>).reason === undefined ||
        typeof (error as Record<string, unknown>).reason === "string") &&
      ((error as Record<string, unknown>).turnId === undefined ||
        typeof (error as Record<string, unknown>).turnId === "string") &&
      ((error as Record<string, unknown>).durationMs === undefined ||
        (typeof (error as Record<string, unknown>).durationMs === "number" &&
          Number.isFinite((error as Record<string, unknown>).durationMs))));
  const validSubagentStatus =
    r.subagentStatus === undefined || isSubagentStatus(r.subagentStatus);
  const validRichContent =
    r.richContent === undefined ||
    (Array.isArray(r.richContent) &&
      r.richContent.length <= 16 &&
      r.richContent.every((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
        const value = item as Record<string, unknown>;
        const bounded = (key: string) =>
          typeof value[key] === "string" && (value[key] as string).length > 0 && (value[key] as string).length <= 240;
        const dimension = (key: string) =>
          value[key] === undefined ||
          (typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) > 0 && (value[key] as number) <= 10000);
        return bounded("type") && bounded("mediaType") && bounded("path") && bounded("sourceToolName") && dimension("width") && dimension("height");
      }));
  return (
    typeof r.id === "string" &&
    typeof r.ts === "number" &&
    (r.role === "user" ||
      r.role === "assistant" ||
      r.role === "thinking" ||
      r.role === "subagent" ||
      r.role === "system" ||
      r.role === "tool") &&
    typeof r.text === "string" &&
    (r.outputRef === undefined || (typeof r.outputRef === "string" && r.outputRef.length > 0 && r.outputRef.length <= 4096)) &&
    validRichContent &&
    validSubagentStatus &&
    validEngineError
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

/**
 * Host-internal children are named by the host itself. Logs written before the
 * item kind was carried still hold one as an ordinary sub-agent entry, so the
 * block (and its buttons, which can only fail) would survive the fix. Recognise
 * the host's own label once, on read; entries written now are flagged from
 * their item kind at ingest and never reach this path.
 */
const LEGACY_INTERNAL_CHILD_LABELS = new Set(["reminder child session"]);

function isLegacyInternalChild(e: LogEntry): boolean {
  if (e.role !== "subagent") return false;
  const label = (e.objective ?? e.text.split("\n")[0] ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return LEGACY_INTERNAL_CHILD_LABELS.has(label);
}

export function loadLog(sessionId: string): LogEntry[] {
  const raw = read<unknown>(logKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  // Close any blocks left open across restarts so new stream chunks
  // start fresh entries instead of appending to a stale one.
  return raw
    .filter(isValidEntry)
    .slice(-MAX_LOG_ENTRIES)
    .map((e) => {
      const closed: LogEntry = e.open ? { ...e, open: false } : e;
      if (closed.subagentInternal !== true && isLegacyInternalChild(closed)) {
        return { ...closed, subagentInternal: true };
      }
      return closed;
    });
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
  removeStorageKey(logKey(sessionId));
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
    removeStorageKey(ACTIVE_KEY);
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
const WORKTREES_KEY = "muse-desktop.worktrees.v1";

function isValidProjectRow(p: unknown): p is Project {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.name === "string" &&
    // `instructions` became optional when the client-side store was retired;
    // older rows still carry it, and a row without it is a normal row now.
    (r.instructions === undefined || typeof r.instructions === "string") &&
    typeof r.createdAt === "number" &&
    (r.workspace === undefined || typeof r.workspace === "string") &&
    (r.settings === undefined || (typeof r.settings === "object" && r.settings !== null))
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

function isValidWorktreeRecord(value: unknown): value is WorktreeRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.repoRoot === "string" && r.repoRoot.length > 0 &&
    typeof r.path === "string" && r.path.length > 0 &&
    typeof r.branch === "string" && r.branch.length > 0 &&
    typeof r.base === "string" && r.base.length > 0 &&
    typeof r.createdAt === "number" && Number.isFinite(r.createdAt)
  );
}

/** Load bounded worktree records; stale Git paths remain visible for cleanup. */
export function loadWorktrees(): WorktreeRecord[] {
  const raw = read<unknown>(WORKTREES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidWorktreeRecord).slice(-100);
}

export function saveWorktrees(worktrees: WorktreeRecord[]): void {
  write(WORKTREES_KEY, worktrees.slice(-100));
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
    typeof r.autoCompact === "boolean" &&
    (r.reasoningEffort === undefined || typeof r.reasoningEffort === "string")
  );
}

export function loadGlobalSettings(
  fallback: ProjectSettings,
): ProjectSettings {
  const raw = read<unknown>(GLOBAL_SETTINGS_KEY, null);
  if (!isValidGlobalSettings(raw)) return fallback;
  return {
    ...fallback,
    ...raw,
    reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort, fallback.reasoningEffort),
  };
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

export function loadOutbox(sessionId: string): OutboxEntry[] {
  const raw = read<unknown>(outboxKey(sessionId), []);
  return normalizeOutboxEntries(raw);
}

export function saveOutbox(sessionId: string, entries: OutboxEntry[]): void {
  write(outboxKey(sessionId), entries.slice(-MAX_OUTBOX_ENTRIES));
}

export function dropOutbox(sessionId: string): void {
  removeStorageKey(outboxKey(sessionId));
}
