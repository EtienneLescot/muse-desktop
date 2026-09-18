/** Native durability mirror for the M0-03 send outbox. */

import { isTauriRuntime } from "./env.ts";
import {
  isValidOutboxEntry,
  normalizeOutboxEntries,
  MAX_OUTBOX_ENTRIES,
  type OutboxEntry,
} from "./outbox.ts";

export const NATIVE_OUTBOX_SCHEMA = "muse-desktop.native-outbox.v1";
export const MAX_OUTBOX_SESSIONS = 100;

export type OutboxStore = Record<string, OutboxEntry[]>;

function cleanSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 256 ? id : null;
}

/** Keep accepted rows long enough to suppress an older native retry. */
function validRows(raw: unknown): OutboxEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidOutboxEntry).slice(-MAX_OUTBOX_ENTRIES);
}

export function normalizeOutboxStore(value: unknown): OutboxStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: OutboxStore = {};
  for (const [rawSessionId, rawEntries] of Object.entries(value as Record<string, unknown>)) {
    const sessionId = cleanSessionId(rawSessionId);
    const entries = validRows(rawEntries);
    if (sessionId === null || entries.length === 0) continue;
    result[sessionId] = entries;
  }
  return Object.fromEntries(Object.entries(result).slice(-MAX_OUTBOX_SESSIONS));
}

function mergeEntries(local: unknown, native: unknown): OutboxEntry[] {
  const merged = new Map<string, OutboxEntry>();
  for (const entry of validRows(local)) merged.set(entry.clientMessageId, entry);
  for (const entry of validRows(native)) {
    const current = merged.get(entry.clientMessageId);
    if (current === undefined ||
      entry.updatedAt > current.updatedAt ||
      (entry.updatedAt === current.updatedAt && entry.createdAt >= current.createdAt)) {
      merged.set(entry.clientMessageId, entry);
    }
  }
  return normalizeOutboxEntries([...merged.values()]);
}

/** Merge localStorage and native copies without resurrecting accepted sends. */
export function mergeOutboxStores(local: OutboxStore, native: OutboxStore): OutboxStore {
  const sessionIds = new Set([...Object.keys(local), ...Object.keys(native)]);
  const merged: OutboxStore = {};
  for (const sessionId of sessionIds) {
    const entries = mergeEntries(local[sessionId], native[sessionId]);
    if (entries.length > 0) merged[sessionId] = entries;
  }
  return Object.fromEntries(Object.entries(merged).slice(-MAX_OUTBOX_SESSIONS));
}

export async function loadNativeOutbox(): Promise<OutboxStore | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<unknown>("outbox_read");
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;
    if (value.schema !== NATIVE_OUTBOX_SCHEMA) return null;
    return normalizeOutboxStore(value.sessions);
  } catch {
    return null;
  }
}

export async function saveNativeOutbox(store: OutboxStore): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("outbox_write", {
      payload: JSON.stringify({
        schema: NATIVE_OUTBOX_SCHEMA,
        sessions: normalizeOutboxStore(store),
      }),
    });
    return true;
  } catch {
    return false;
  }
}
