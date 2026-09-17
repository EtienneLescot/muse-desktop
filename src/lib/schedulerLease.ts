/**
 * Best-effort cross-window scheduler lease (M3-07).
 *
 * A lease is deliberately small and expiring: a crashed renderer cannot block
 * scheduling forever, and only the owner that currently holds the lease may
 * renew or release it. The localStorage read-back narrows the race between
 * two windows starting at the same time; native scheduling remains a later
 * host-level concern.
 */
import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";

export const SCHEDULER_LEASE_KEY = "muse-desktop.scheduler-lease.v1";
export const DEFAULT_SCHEDULER_LEASE_TTL_MS = 30_000;

export interface SchedulerLease {
  ownerId: string;
  expiresAt: number;
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
