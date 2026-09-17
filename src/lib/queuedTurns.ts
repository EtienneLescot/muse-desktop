/** M1-10: durable visibility for turns accepted into the host queue. */

import { readStorageJson, writeStorageJson } from "./storage.ts";

export const QUEUED_TURNS_KEY = "muse-desktop.queued-turns.v1";
export const MAX_QUEUED_TURNS = 100;

export interface PersistedQueuedTurn {
  session_id: string;
  turn_id: string;
  text: string;
  createdAt: number;
}

export type PersistedQueuedTurns = Record<string, PersistedQueuedTurn[]>;

/** A server snapshot names queued turns but does not echo their prompt text. */
export interface QueueSnapshotTurn {
  turn_id: string;
  command_id?: string;
}

/**
 * Reconcile a host-provided queued-turn snapshot with the local durable queue.
 * `null` means the host did not serve a snapshot, so callers must keep their
 * local state untouched. When a turn is new to the renderer, retain its
 * identity with a visible verification label instead of inventing prompt
 * text or replaying it automatically.
 */
export function reconcileQueuedTurns(
  sessionId: string,
  local: readonly (PersistedQueuedTurn & { recovered?: boolean })[],
  snapshot: unknown,
  now = Date.now(),
): Array<PersistedQueuedTurn & { recovered?: boolean }> | null {
  if (!Array.isArray(snapshot)) return null;
  const known = new Map(local.map((row) => [row.turn_id, row]));
  const seen = new Set<string>();
  const next: Array<PersistedQueuedTurn & { recovered?: boolean }> = [];
  for (const raw of snapshot) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const turnId = typeof row.turnId === "string" ? row.turnId.trim() :
      typeof row.turn_id === "string" ? row.turn_id.trim() : "";
    if (!turnId || seen.has(turnId)) continue;
    seen.add(turnId);
    const previous = known.get(turnId);
    next.push(previous ?? {
      session_id: sessionId,
      turn_id: turnId,
      text: `Queued turn ${turnId.slice(0, 12)} — verify the host queue`,
      createdAt: now,
      recovered: true,
    });
  }
  return next.slice(-MAX_QUEUED_TURNS);
}

function isQueuedTurn(value: unknown): value is PersistedQueuedTurn {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.session_id === "string" && row.session_id.length > 0 &&
    typeof row.turn_id === "string" && row.turn_id.length > 0 &&
    typeof row.text === "string" && Number.isFinite(row.createdAt)
  );
}

export function loadQueuedTurns(): PersistedQueuedTurns {
  const raw = readStorageJson<unknown>(QUEUED_TURNS_KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: PersistedQueuedTurns = {};
  let remaining = MAX_QUEUED_TURNS;
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (remaining <= 0 || !Array.isArray(value)) continue;
    const rows = value
      .filter(isQueuedTurn)
      .slice(-remaining)
      .map(({ session_id, turn_id, text, createdAt }) => ({ session_id, turn_id, text, createdAt }));
    if (rows.length === 0) continue;
    out[sessionId] = rows;
    remaining -= rows.length;
  }
  return out;
}

export function saveQueuedTurns(
  value: Record<string, Array<PersistedQueuedTurn & { recovered?: boolean }>>,
): void {
  const out: PersistedQueuedTurns = {};
  let remaining = MAX_QUEUED_TURNS;
  const sessions = Object.entries(value).reverse();
  for (const [sessionId, rows] of sessions) {
    if (remaining <= 0) break;
    const clean = rows
      .filter(isQueuedTurn)
      .slice(-remaining)
      .map(({ session_id, turn_id, text, createdAt }) => ({ session_id, turn_id, text, createdAt }))
      .reverse();
    if (clean.length === 0) continue;
    out[sessionId] = clean.reverse();
    remaining -= clean.length;
  }
  writeStorageJson(QUEUED_TURNS_KEY, out);
}
