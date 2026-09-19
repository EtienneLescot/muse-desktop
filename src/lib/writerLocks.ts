/**
 * Renderer-side writer leases.
 *
 * MSP does not currently expose a file-lock RPC. This registry therefore
 * protects concurrent orchestration panels in one Muse process only. The
 * host remains authoritative for cross-process and filesystem locking.
 */

export interface WriterLock {
  token: string;
  workspace: string;
  agent: string;
  targetPaths: string[];
  acquiredAt: number;
}

export interface WriterLockConflict {
  agent: string;
  targetPaths: string[];
}

export interface WriterLockResult {
  lock: WriterLock | null;
  conflicts: WriterLockConflict[];
}

const locks = new Map<string, WriterLock>();

function normalizeWorkspace(workspace: string): string {
  return workspace.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function normalizePath(path: string): string | null {
  const value = path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (value.length === 0 || value.startsWith("/") || value.includes(":")) return null;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizedTargets(paths: readonly string[]): string[] {
  return paths
    .map(normalizePath)
    .filter((path): path is string => path !== null)
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 80);
}

/** Acquire a process-local lease, refusing overlapping targets in one workspace. */
export function acquireWriterLock(
  workspace: string,
  agent: string,
  targetPaths: readonly string[],
  now = Date.now(),
): WriterLockResult {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const targets = normalizedTargets(targetPaths);
  const conflicts: WriterLockConflict[] = [];
  for (const current of locks.values()) {
    if (current.workspace !== normalizedWorkspace) continue;
    const conflictingTargets = current.targetPaths.filter((currentPath) =>
      targets.some((target) => overlaps(currentPath, target)),
    );
    if (conflictingTargets.length > 0) {
      conflicts.push({ agent: current.agent, targetPaths: conflictingTargets });
    }
  }
  if (conflicts.length > 0 || normalizedWorkspace.length === 0 || targets.length === 0) {
    return { lock: null, conflicts };
  }
  const token = `writer-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const lock: WriterLock = {
    token,
    workspace: normalizedWorkspace,
    agent: agent.trim().slice(0, 160) || "writer",
    targetPaths: targets,
    acquiredAt: Number.isFinite(now) ? now : Date.now(),
  };
  locks.set(token, lock);
  return { lock, conflicts: [] };
}

/** Release one lease; repeated release is intentionally idempotent. */
export function releaseWriterLock(token: string | null | undefined): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  return locks.delete(token);
}

/** Release every lease owned by one workspace, used when a panel changes root. */
export function releaseWriterLocksForWorkspace(workspace: string): number {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  let released = 0;
  for (const [token, lock] of locks) {
    if (lock.workspace === normalizedWorkspace && locks.delete(token)) released += 1;
  }
  return released;
}

/** Test/support projection; callers receive copies and cannot mutate the registry. */
export function listWriterLocks(workspace?: string): WriterLock[] {
  const normalizedWorkspace = workspace === undefined ? null : normalizeWorkspace(workspace);
  return [...locks.values()]
    .filter((lock) => normalizedWorkspace === null || lock.workspace === normalizedWorkspace)
    .map((lock) => ({ ...lock, targetPaths: [...lock.targetPaths] }));
}
