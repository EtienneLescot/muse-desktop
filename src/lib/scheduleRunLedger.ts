/** Native mirror for the scheduled-run ledger (M3-07).
 *
 * The hook still owns the live state and localStorage remains the preview
 * fallback. In a Tauri build this mirror is stored under app data so a
 * webview reload cannot erase a queued, running, or recovery row.
 */
import { isTauriRuntime } from "./env";
import { normalizeScheduleRuns, type ScheduleRun } from "./scheduleRuns";

export const NATIVE_SCHEDULE_RUNS_SCHEMA = "muse-desktop.native-schedule-runs.v1";

export async function loadNativeScheduleRuns(): Promise<ScheduleRun[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<unknown>("scheduler_runs_read");
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;
    if (value.schema !== NATIVE_SCHEDULE_RUNS_SCHEMA || !Array.isArray(value.runs)) return null;
    return normalizeScheduleRuns(value.runs);
  } catch {
    // Older desktop builds and transient native reads fall back to the
    // renderer ledger; the next successful write repairs the mirror.
    return null;
  }
}

export async function saveNativeScheduleRuns(runs: ScheduleRun[]): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("scheduler_runs_write", {
      payload: JSON.stringify({ schema: NATIVE_SCHEDULE_RUNS_SCHEMA, runs: normalizeScheduleRuns(runs) }),
    });
    return true;
  } catch {
    return false;
  }
}
