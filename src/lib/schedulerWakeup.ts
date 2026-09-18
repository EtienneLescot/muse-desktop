/** Native wake-up scheduling for M3-07. The renderer remains the SSOT for schedules. */

import { isTauriRuntime } from "./env.ts";
import { nextScheduleOccurrence, type Schedule } from "./schedules.ts";

export const SCHEDULER_WAKEUP_SCHEMA = "muse-desktop.scheduler-wakeup.v1";

export interface SchedulerWakeupStatus {
  schema: string;
  supported: boolean;
  installed: boolean;
  wakeAt: number | null;
  message: string;
}

export const INITIAL_SCHEDULER_WAKEUP_STATUS: SchedulerWakeupStatus = {
  schema: SCHEDULER_WAKEUP_SCHEMA,
  supported: false,
  installed: false,
  wakeAt: null,
  message: "Native wake-up is not configured.",
};

/** Pick the earliest future occurrence from enabled schedules. */
export function nextSchedulerWakeAt(
  schedules: readonly Schedule[],
  now = Date.now(),
): number | null {
  if (!Number.isFinite(now)) return null;
  const candidates = schedules
    .filter((schedule) => schedule.enabled)
    .map((schedule) => nextScheduleOccurrence(schedule))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => (value > now + 1_000 ? value : now + 60_000));
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Ask the native supervisor to create or remove the one-shot wake task. */
export async function syncNativeSchedulerWakeup(
  wakeAt: number | null,
): Promise<SchedulerWakeupStatus> {
  if (!isTauriRuntime()) return INITIAL_SCHEDULER_WAKEUP_STATUS;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<unknown>("scheduler_wakeup_sync", { wakeAt });
    if (typeof result !== "object" || result === null) {
      return { ...INITIAL_SCHEDULER_WAKEUP_STATUS, message: "Native wake-up returned an invalid status." };
    }
    const row = result as Record<string, unknown>;
    return {
      schema: typeof row.schema === "string" ? row.schema : SCHEDULER_WAKEUP_SCHEMA,
      supported: row.supported === true,
      installed: row.installed === true,
      wakeAt: typeof row.wakeAt === "number" && Number.isFinite(row.wakeAt) ? row.wakeAt : null,
      message: typeof row.message === "string" && row.message.trim() !== ""
        ? row.message
        : "Native wake-up status is unavailable.",
    };
  } catch {
    return {
      ...INITIAL_SCHEDULER_WAKEUP_STATUS,
      message: "Native wake-up is unavailable; keep Muse open for automations.",
    };
  }
}

/** Serialize native task updates so the last schedule snapshot wins. */
export function createSchedulerWakeupQueue(
  sync: (wakeAt: number | null) => Promise<SchedulerWakeupStatus> = syncNativeSchedulerWakeup,
): (wakeAt: number | null) => Promise<SchedulerWakeupStatus> {
  type Waiter = (status: SchedulerWakeupStatus) => void;
  let pending: { wakeAt: number | null; waiters: Waiter[] } | null = null;
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending !== null) {
        const next = pending;
        pending = null;
        let status: SchedulerWakeupStatus;
        try {
          status = await sync(next.wakeAt);
        } catch {
          status = {
            ...INITIAL_SCHEDULER_WAKEUP_STATUS,
            message: "Native wake-up is unavailable; keep Muse open for automations.",
          };
        }
        next.waiters.forEach((resolve) => resolve(status));
      }
    } finally {
      draining = false;
      if (pending !== null) void drain();
    }
  };

  return (wakeAt) => new Promise((resolve) => {
    if (pending === null) pending = { wakeAt, waiters: [resolve] };
    else {
      pending.wakeAt = wakeAt;
      pending.waiters.push(resolve);
    }
    void drain();
  });
}
