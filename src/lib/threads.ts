/**
 * US-5 threads sidebar: pure thread-list logic (sorting, archive partition,
 * keyboard cycling). Dependency-free so it stays unit-testable under
 * `node:test` without React or Tauri.
 */

export interface ThreadLike {
  session_id: string;
  title: string;
  createdAt: number;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  /** Lower values appear first within the same pinned/running tier. */
  sortOrder?: number;
  running?: boolean;
}

export type CycleDir = 1 | -1;

/** True when the thread is archived (explicit flag only, never truthy junk). */
export function isArchived(t: ThreadLike): boolean {
  return t.archived === true;
}

/**
 * Active (non-archived) threads, most relevant first: running threads on
 * top (live multi-agent work stays visible even with many threads), then
 * most recently created.
 */
export function selectActiveThreads<T extends ThreadLike>(sessions: T[]): T[] {
  return sessions
    .filter((s) => !isArchived(s))
    .sort((a, b) => {
      const pa = a.pinned === true ? 0 : 1;
      const pb = b.pinned === true ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ra = a.running === true ? 0 : 1;
      const rb = b.running === true ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const oa = a.sortOrder;
      const ob = b.sortOrder;
      if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
      if (oa !== undefined && ob === undefined) return -1;
      if (oa === undefined && ob !== undefined) return 1;
      return b.createdAt - a.createdAt;
    });
}

export function withPinnedFlag<T extends ThreadLike>(
  sessions: T[],
  sessionId: string,
  pinned: boolean,
): T[] {
  return sessions.map((s) =>
    s.session_id === sessionId ? { ...s, pinned } : s,
  );
}

/** Archived threads, most recently created first. */
export function selectArchivedThreads<T extends ThreadLike>(sessions: T[]): T[] {
  return sessions
    .filter(isArchived)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Count of running threads among the active ones (live indicator). */
export function countRunning<T extends ThreadLike>(sessions: T[]): number {
  return sessions.filter((s) => !isArchived(s) && s.running === true).length;
}

/**
 * Keyboard thread cycling (ctrl-tab / ctrl+shift+tab / arrow keys).
 * Walks `ids` (already in display order) with wrap-around; returns null
 * when there is nothing to switch to. An unknown current id restarts from
 * the list edge matching the direction.
 */
export function cycleThreadId(
  ids: string[],
  currentId: string | null,
  dir: CycleDir,
): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  const i = currentId === null ? -1 : ids.indexOf(currentId);
  if (i === -1) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}

/**
 * Set the archived flag on one thread. Everything else — title included —
 * is preserved by reference-shaped copy ({...t}), so auto titles survive
 * archive/restore round-trips.
 */
export function withArchivedFlag<T extends ThreadLike>(
  sessions: T[],
  sessionId: string,
  archived: boolean,
): T[] {
  return sessions.map((s) =>
    s.session_id === sessionId ? { ...s, archived } : s,
  );
}

export function withUnreadFlag<T extends ThreadLike>(
  sessions: T[],
  sessionId: string,
  unread: boolean,
): T[] {
  return sessions.map((s) =>
    s.session_id === sessionId ? { ...s, unread } : s,
  );
}

/** The tier a thread is ranked in; order is only manual inside one tier. */
function tierOf(thread: ThreadLike): string {
  return `${thread.pinned === true ? "pinned" : "normal"}:${thread.running === true ? "running" : "idle"}`;
}

/**
 * Drop `movedId` on `targetId`: the moved thread takes the target's slot and
 * the rest closes up behind it. Dropping on itself, on an unknown thread, or
 * across tiers changes nothing — pinned and running threads are ranked above
 * the manual order, so a cross-tier drop would silently snap back.
 */
export function reorderThread<T extends ThreadLike>(
  sessions: T[],
  movedId: string,
  targetId: string,
): T[] {
  if (movedId === targetId) return sessions;
  const active = selectActiveThreads(sessions);
  const from = active.findIndex((s) => s.session_id === movedId);
  const to = active.findIndex((s) => s.session_id === targetId);
  if (from < 0 || to < 0) return sessions;
  if (tierOf(active[from]) !== tierOf(active[to])) return sessions;
  const ordered = active.map((s) => s.session_id);
  ordered.splice(to, 0, ...ordered.splice(from, 1));
  const ranks = new Map(ordered.map((id, rank) => [id, rank]));
  return sessions.map((s) =>
    ranks.has(s.session_id) ? { ...s, sortOrder: ranks.get(s.session_id) } : s,
  );
}

/** Move an active conversation one slot in the manual order. */
export function moveThread<T extends ThreadLike>(
  sessions: T[],
  sessionId: string,
  direction: -1 | 1,
): T[] {
  const active = selectActiveThreads(sessions);
  const index = active.findIndex((s) => s.session_id === sessionId);
  if (index < 0) return sessions;
  const target = index + direction;
  if (target < 0 || target >= active.length) return sessions;
  if (tierOf(active[index]) !== tierOf(active[target])) return sessions;
  const ordered = active.map((s) => s.session_id);
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const ranks = new Map(ordered.map((id, rank) => [id, rank]));
  return sessions.map((s) =>
    ranks.has(s.session_id) ? { ...s, sortOrder: ranks.get(s.session_id) } : s,
  );
}
