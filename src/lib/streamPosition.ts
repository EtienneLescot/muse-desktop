import { readStorageJson, writeStorageJson } from "./storage.ts";

/** UI-only viewport memory; transcript content remains in the session log. */
export const STREAM_POSITIONS_KEY = "muse-desktop.stream-position.v1";
export const MAX_STREAM_POSITIONS = 200;
const MAX_SCROLL_TOP = 1_000_000_000;
const MAX_WINDOW_START = 1_000_000;

export interface StreamPosition {
  sessionId: string;
  scrollTop: number;
  windowStart: number;
  updatedAt: number;
}

function validPosition(value: unknown): value is StreamPosition {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sessionId === "string" && row.sessionId.trim().length > 0 &&
    typeof row.scrollTop === "number" && Number.isFinite(row.scrollTop) &&
    row.scrollTop >= 0 && row.scrollTop <= MAX_SCROLL_TOP &&
    typeof row.windowStart === "number" && Number.isFinite(row.windowStart) &&
    row.windowStart >= 0 && row.windowStart <= MAX_WINDOW_START &&
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && row.updatedAt > 0;
}

function loadAll(): StreamPosition[] {
  const raw = readStorageJson<unknown>(STREAM_POSITIONS_KEY, []);
  return Array.isArray(raw)
    ? raw.filter(validPosition).slice(-MAX_STREAM_POSITIONS)
    : [];
}

/** Load one conversation's last viewport, or null when none is stored. */
export function loadStreamPosition(sessionId: string | null): StreamPosition | null {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
  const rows = loadAll().filter((row) => row.sessionId === sessionId);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Persist only bounded UI coordinates; never store transcript text here. */
export function saveStreamPosition(
  sessionId: string | null,
  scrollTop: number,
  windowStart: number,
  updatedAt = Date.now(),
): void {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
  if (!Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > MAX_SCROLL_TOP) return;
  if (!Number.isFinite(windowStart) || windowStart < 0 || windowStart > MAX_WINDOW_START) return;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return;
  const next: StreamPosition = {
    sessionId: sessionId.trim(),
    scrollTop: Math.floor(scrollTop),
    windowStart: Math.floor(windowStart),
    updatedAt,
  };
  const rows = loadAll().filter((row) => row.sessionId !== next.sessionId);
  writeStorageJson(STREAM_POSITIONS_KEY, [...rows, next].slice(-MAX_STREAM_POSITIONS));
}

/** Remove viewport memory when a conversation is explicitly deleted. */
export function removeStreamPosition(sessionId: string | null): void {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
  const rows = loadAll().filter((row) => row.sessionId !== sessionId.trim());
  writeStorageJson(STREAM_POSITIONS_KEY, rows);
}
