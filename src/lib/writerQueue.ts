/**
 * M2-08 writer coordination: bounded, deterministic pre-flight planning.
 *
 * The Muse host currently exposes no writer-spawn or file-lock RPC. This
 * module therefore never starts a writer. It computes the safe queue that the
 * UI can show before a future runtime dispatch: every writer must have its
 * own worktree and declare the paths it may change; overlapping paths are
 * blocked instead of being scheduled together.
 */

export const MAX_WRITER_PATHS = 80;

export type WriterQueueStatus =
  | "blocked"
  | "needsPaths"
  | "conflict"
  | "ready"
  | "queued";

export interface WriterSpec {
  agent: string;
  worktreePath: string;
  hasWorktree: boolean;
  targetPaths: readonly string[];
}

export interface WriterQueueRow {
  agent: string;
  worktreePath: string;
  targetPaths: string[];
  status: WriterQueueStatus;
  lane: number | null;
  queuePosition: number | null;
  conflictsWith: string[];
}

export interface WriterQueuePlan {
  lanes: number;
  rows: WriterQueueRow[];
  ready: number;
  queued: number;
  blocked: number;
  needsPaths: number;
  conflicts: number;
}

/** Normalize a user-declared relative path; invalid/traversal paths are dropped. */
export function normalizeWriterPath(value: string): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim().replace(/\\/g, "/");
  path = path.replace(/^\.\//, "").replace(/\/+/g, "/");
  if (path.length === 0 || path.startsWith("/") || path.includes(":/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.join("/").toLowerCase();
}

/** Parse comma/newline/semicolon separated target paths with a hard cap. */
export function parseWriterPaths(input: string): {
  paths: string[];
  invalid: string[];
} {
  const paths: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const normalized = normalizeWriterPath(raw);
    if (normalized === null) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
    if (paths.length >= MAX_WRITER_PATHS) break;
  }
  return { paths, invalid };
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Build a queue preview. Conflict rows are never assigned a lane; queued rows
 * are assigned FIFO after the first `lanes` conflict-free writers.
 */
export function planWriterQueue(
  specs: readonly WriterSpec[],
  lanes: number,
): WriterQueuePlan {
  const effectiveLanes = Number.isFinite(lanes) && lanes > 0 ? Math.max(1, Math.floor(lanes)) : 1;
  const normalizedSpecs = specs.map((spec) => ({
    ...spec,
    targetPaths: spec.targetPaths
      .map((path) => normalizeWriterPath(path))
      .filter((path): path is string => path !== null)
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .slice(0, MAX_WRITER_PATHS),
  }));
  const conflicts = normalizedSpecs.map(() => new Set<string>());
  for (let i = 0; i < normalizedSpecs.length; i += 1) {
    for (let j = i + 1; j < normalizedSpecs.length; j += 1) {
      if (!normalizedSpecs[i].hasWorktree || !normalizedSpecs[j].hasWorktree) continue;
      const collides = normalizedSpecs[i].targetPaths.some((left) =>
        normalizedSpecs[j].targetPaths.some((right) => overlaps(left, right)),
      );
      if (collides) {
        conflicts[i].add(normalizedSpecs[j].agent);
        conflicts[j].add(normalizedSpecs[i].agent);
      }
    }
  }

  let runnableIndex = 0;
  let queuePosition = 0;
  const rows = normalizedSpecs.map((spec, index): WriterQueueRow => {
    const conflictList = [...conflicts[index]];
    if (!spec.hasWorktree) {
      return {
        agent: spec.agent,
        worktreePath: spec.worktreePath,
        targetPaths: [...spec.targetPaths],
        status: "blocked",
        lane: null,
        queuePosition: null,
        conflictsWith: conflictList,
      };
    }
    if (spec.targetPaths.length === 0) {
      return {
        agent: spec.agent,
        worktreePath: spec.worktreePath,
        targetPaths: [],
        status: "needsPaths",
        lane: null,
        queuePosition: null,
        conflictsWith: conflictList,
      };
    }
    if (conflictList.length > 0) {
      return {
        agent: spec.agent,
        worktreePath: spec.worktreePath,
        targetPaths: [...spec.targetPaths],
        status: "conflict",
        lane: null,
        queuePosition: null,
        conflictsWith: conflictList,
      };
    }
    runnableIndex += 1;
    const lane = runnableIndex <= effectiveLanes ? runnableIndex : null;
    if (lane !== null) {
      return {
        agent: spec.agent,
        worktreePath: spec.worktreePath,
        targetPaths: [...spec.targetPaths],
        status: "ready",
        lane,
        queuePosition: null,
        conflictsWith: [],
      };
    }
    queuePosition += 1;
    return {
      agent: spec.agent,
      worktreePath: spec.worktreePath,
      targetPaths: [...spec.targetPaths],
      status: "queued",
      lane: null,
      queuePosition,
      conflictsWith: [],
    };
  });
  return {
    lanes: effectiveLanes,
    rows,
    ready: rows.filter((row) => row.status === "ready").length,
    queued: rows.filter((row) => row.status === "queued").length,
    blocked: rows.filter((row) => row.status === "blocked" || row.status === "conflict").length,
    needsPaths: rows.filter((row) => row.status === "needsPaths").length,
    conflicts: rows.filter((row) => row.status === "conflict").length,
  };
}
