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
