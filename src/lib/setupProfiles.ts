/**
 * User-authored setup commands for managed worktrees (M2-04).
 *
 * Profiles are scoped by canonical workspace string and only remember the
 * command the user explicitly entered. Selecting or saving a profile never
 * starts a process; OrchestrationPanel still requires an explicit Run setup
 * click for the selected worktree.
 */

import { readStorageJson, writeStorageJson } from "./storage.ts";
import { normalizeSetupEnvAllowlist } from "./worktrees.ts";

export const SETUP_PROFILES_KEY = "muse-desktop.worktree-setup-profiles.v1";
export const MAX_SETUP_PROFILES = 50;

export interface SetupProfile {
  id: string;
  name: string;
  command: string;
  /** Extra environment names explicitly allowed for this profile. */
  envAllowlist: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SetupProfileInput {
  name: string;
  command: string;
  envAllowlist?: string[];
}

function scopeKey(workspace: string): string {
  return workspace.trim().toLowerCase();
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `setup-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

function validProfile(value: unknown): value is SetupProfile {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0 &&
    typeof row.name === "string" && row.name.trim().length > 0 &&
    typeof row.command === "string" && row.command.trim().length > 0 &&
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt);
}

function profileStore(): Record<string, unknown> {
  const value = readStorageJson<unknown>(SETUP_PROFILES_KEY, {});
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Load only profiles belonging to the selected workspace. */
export function loadSetupProfiles(workspace: string): SetupProfile[] {
  const key = scopeKey(workspace);
  if (key.length === 0) return [];
  const raw = profileStore()[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(validProfile)
    .map((profile) => ({
      ...profile,
      // Older profiles predate the allowlist and intentionally receive no
      // extra names; the runner still applies its safe platform defaults.
      envAllowlist: normalizeSetupEnvAllowlist(
        Array.isArray(profile.envAllowlist) ? profile.envAllowlist : [],
      ),
    }))
    .slice(-MAX_SETUP_PROFILES);
}

function persistSetupProfiles(workspace: string, profiles: SetupProfile[]): void {
  const key = scopeKey(workspace);
  if (key.length === 0) return;
  const store = profileStore();
  store[key] = profiles.slice(-MAX_SETUP_PROFILES);
  writeStorageJson(SETUP_PROFILES_KEY, store);
}

/** Insert or update a profile by case-insensitive name. */
export function upsertSetupProfile(
  workspace: string,
  profiles: SetupProfile[],
  input: SetupProfileInput,
  now = Date.now(),
): { profiles: SetupProfile[]; profile: SetupProfile | null } {
  const name = input.name.trim();
  const command = input.command.trim();
  const envAllowlist = normalizeSetupEnvAllowlist(input.envAllowlist ?? []);
  if (scopeKey(workspace).length === 0 || name.length === 0 || command.length === 0) {
    return { profiles, profile: null };
  }
  const index = profiles.findIndex((profile) => profile.name.toLowerCase() === name.toLowerCase());
  const profile = index >= 0
    ? { ...profiles[index], name, command, envAllowlist, updatedAt: now }
    : { id: makeId(), name, command, envAllowlist, createdAt: now, updatedAt: now };
  const next = index >= 0
    ? profiles.map((row, i) => i === index ? profile : row)
    : [...profiles, profile].slice(-MAX_SETUP_PROFILES);
  persistSetupProfiles(workspace, next);
  return { profiles: next, profile };
}

/** Remove one saved profile without affecting profiles in another workspace. */
export function removeSetupProfile(
  workspace: string,
  profiles: SetupProfile[],
  id: string,
): SetupProfile[] {
  const next = profiles.filter((profile) => profile.id !== id);
  if (next.length !== profiles.length) persistSetupProfiles(workspace, next);
  return next;
}
