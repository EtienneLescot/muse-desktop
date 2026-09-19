/** Native mirror for schedule definitions (M3-07). */

import { isTauriRuntime } from "./env.ts";
import { normalizeSchedules, type Schedule } from "./schedules.ts";

export const NATIVE_SCHEDULES_SCHEMA = "muse-desktop.native-schedules.v1";

export function mergeSchedules(local: Schedule[], native: Schedule[]): Schedule[] {
  const byId = new Map(local.map((schedule) => [schedule.id, schedule]));
  for (const candidate of normalizeSchedules(native)) {
    const current = byId.get(candidate.id);
    if (current === undefined) { byId.set(candidate.id, candidate); continue; }
    const currentCursor = current.lastFiredAt ?? current.createdAt;
    const nativeCursor = candidate.lastFiredAt ?? candidate.createdAt;
    if (nativeCursor > currentCursor) byId.set(candidate.id, candidate);
  }
  return normalizeSchedules([...byId.values()]);
}

export async function loadNativeSchedules(): Promise<Schedule[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<unknown>("scheduler_schedules_read");
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;
    if (value.schema !== NATIVE_SCHEDULES_SCHEMA || !Array.isArray(value.schedules)) return null;
    return normalizeSchedules(value.schedules);
  } catch { return null; }
}

export async function saveNativeSchedules(schedules: Schedule[]): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("scheduler_schedules_write", {
      payload: JSON.stringify({ schema: NATIVE_SCHEDULES_SCHEMA, schedules: normalizeSchedules(schedules) }),
    });
    return true;
  } catch { return false; }
}
