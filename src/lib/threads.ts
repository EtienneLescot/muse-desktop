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
