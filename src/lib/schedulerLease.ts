/**
 * Best-effort cross-window scheduler lease (M3-07).
 *
 * A lease is deliberately small and expiring: a crashed renderer cannot block
 * scheduling forever, and only the owner that currently holds the lease may
 * renew or release it. The localStorage read-back narrows the race between
 * two windows starting at the same time; a Tauri build also delegates the
 * process-level claim to the native supervisor when available.
 */
import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";
import { isTauriRuntime } from "./env.ts";

export const SCHEDULER_LEASE_KEY = "muse-desktop.scheduler-lease.v1";
export const DEFAULT_SCHEDULER_LEASE_TTL_MS = 30_000;

export interface SchedulerLease {
  ownerId: string;
  expiresAt: number;
}

export interface NativeSchedulerLeaseResult {
  schema: string;
  acquired: boolean;
  ownerId?: string;
  expiresAt?: number;
  native: boolean;
}

export type SchedulerRuntimeMode = "native" | "local" | "waiting" | "error";

/** Renderer-only projection used by Automations to explain who can dispatch. */
export interface SchedulerRuntimeStatus {
  mode: SchedulerRuntimeMode;
  checkedAt: number | null;
  message: string;
}

export const INITIAL_SCHEDULER_RUNTIME_STATUS: SchedulerRuntimeStatus = {
  mode: "waiting",
  checkedAt: null,
  message: "Checking for an available scheduler…",
};

/**
 * Convert the lease probe result into a small, user-facing status. Keeping
 * this pure makes the renderer projection testable and avoids leaking native
 * command details into the Automations panel.
 */
export function schedulerRuntimeStatusFromProbe(
  nativeClaim: boolean | null,
  acquired: boolean,
  checkedAt: number,
): SchedulerRuntimeStatus {
  if (!Number.isFinite(checkedAt)) return INITIAL_SCHEDULER_RUNTIME_STATUS;
  if (!acquired) {
    return {
      mode: "waiting",
      checkedAt,
      message: "Another Muse window is running automations. This window will retry automatically.",
    };
  }
  if (nativeClaim === true) {
    return {
      mode: "native",
      checkedAt,
      message: "This desktop instance owns the native scheduler lease.",
    };
  }
  return {
    mode: "local",
    checkedAt,
    message: "This window owns the local scheduler lease. Keep Muse open for automations to run.",
  };
}

export function schedulerRuntimeErrorStatus(checkedAt: number): SchedulerRuntimeStatus {
  return {
    mode: "error",
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : null,
    message: "The scheduler could not be checked. Muse will retry automatically.",
  };
}

/**
 * Ask the native supervisor for a process-level lease. `null` means this
 * runtime does not expose the command (web preview or an older build), so
 * callers should retain the localStorage fallback. A `false` result is a
 * real competing process and must not fall back to localStorage.
 */
export async function tryAcquireNativeSchedulerLease(
  ownerId: string,
  leaseTtlMs = DEFAULT_SCHEDULER_LEASE_TTL_MS,
): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<NativeSchedulerLeaseResult>("scheduler_claim", {
      ownerId,
      leaseTtlMs,
    });
    return result?.native === true ? result.acquired === true : null;
  } catch {
    return null;
  }
}

export async function renewNativeSchedulerLease(
  ownerId: string,
  leaseTtlMs = DEFAULT_SCHEDULER_LEASE_TTL_MS,
): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<NativeSchedulerLeaseResult>("scheduler_renew", {
      ownerId,
      leaseTtlMs,
    });
    return result?.native === true ? result.acquired === true : null;
  } catch {
    return null;
  }
}

export async function releaseNativeSchedulerLease(ownerId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("scheduler_release", { ownerId });
  } catch {
    // Teardown is best effort; dropping the native file handle is crash-safe.
  }
}

function validLease(value: unknown): value is SchedulerLease {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.ownerId === "string" && row.ownerId.length > 0 &&
    typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt);
}

function ttl(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCHEDULER_LEASE_TTL_MS;
  return Math.max(5_000, Math.min(120_000, Math.floor(value)));
}

function readLease(): SchedulerLease | null {
  const value = readStorageJson<unknown>(SCHEDULER_LEASE_KEY, null);
  return validLease(value) ? value : null;
}

/** Claim the lease when it is free, expired, or already owned by this window. */
export function tryAcquireSchedulerLease(
  ownerId: string,
  now = Date.now(),
  leaseTtlMs = DEFAULT_SCHEDULER_LEASE_TTL_MS,
): boolean {
  const owner = ownerId.trim();
  if (owner.length === 0 || !Number.isFinite(now)) return false;
  const current = readLease();
  if (current !== null && current.ownerId !== owner && current.expiresAt > now) return false;
  writeStorageJson(SCHEDULER_LEASE_KEY, { ownerId: owner, expiresAt: now + ttl(leaseTtlMs) });
  const confirmed = readLease();
  return confirmed?.ownerId === owner && confirmed.expiresAt > now;
}

/** Extend an existing lease without stealing another window's claim. */
export function renewSchedulerLease(
  ownerId: string,
  now = Date.now(),
  leaseTtlMs = DEFAULT_SCHEDULER_LEASE_TTL_MS,
): boolean {
  const owner = ownerId.trim();
  const current = readLease();
  if (owner.length === 0 || !Number.isFinite(now) || current?.ownerId !== owner || current.expiresAt <= now) {
    return false;
  }
  writeStorageJson(SCHEDULER_LEASE_KEY, { ownerId: owner, expiresAt: now + ttl(leaseTtlMs) });
  return readLease()?.ownerId === owner;
}

/** Release only this window's lease; a newer owner is left untouched. */
export function releaseSchedulerLease(ownerId: string): void {
  if (readLease()?.ownerId === ownerId.trim()) removeStorageKey(SCHEDULER_LEASE_KEY);
}
