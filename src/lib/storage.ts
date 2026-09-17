/**
 * Shared, defensive localStorage facade.
 *
 * Persistence keys already carry a v1 suffix. This layer keeps their format
 * stable while making corruption, unavailable storage and quota failures
 * observable to callers that want to surface recovery guidance. Reads never
 * throw and writes never erase a previous value on failure.
 */

export type StorageIssueKind = "unavailable" | "corrupt" | "quota";

export interface StorageIssue {
  key: string;
  kind: StorageIssueKind;
  message: string;
  at: number;
}

const MAX_ISSUES = 50;
const ISSUE_MESSAGE_LIMIT = 300;
/** Keep recovery exports bounded even when a broken webview stores a huge value. */
export const RECOVERY_RAW_LIMIT = 120_000;
let issues: StorageIssue[] = [];
const issueListeners = new Set<() => void>();

function boundRecoveryRaw(raw: string): { raw: string; truncated: boolean } {
  const chars = Array.from(raw);
  if (chars.length <= RECOVERY_RAW_LIMIT) return { raw, truncated: false };
  return {
    raw: chars.slice(0, RECOVERY_RAW_LIMIT).join(""),
    truncated: true,
  };
}

function storage(): Storage | null {
  try {
    const candidate = (globalThis as Record<string, unknown>).localStorage;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as Storage).getItem === "function" &&
      typeof (candidate as Storage).setItem === "function"
    ) {
      return candidate as Storage;
    }
  } catch {
    // Access can throw in privacy mode or when the webview blocks storage.
  }
  return null;
}

/** Resolve session storage without letting restricted WebViews throw. */
function sessionStorage(): Storage | null {
  try {
    const candidate = (globalThis as Record<string, unknown>).sessionStorage;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as Storage).getItem === "function" &&
      typeof (candidate as Storage).setItem === "function"
    ) {
      return candidate as Storage;
    }
  } catch {
    // Private browsing and restricted webviews can deny sessionStorage.
  }
  return null;
}

function record(key: string, kind: StorageIssueKind, message: string): void {
  issues = [
    ...issues.filter((issue) => !(issue.key === key && issue.kind === kind)),
    { key, kind, message: message.slice(0, ISSUE_MESSAGE_LIMIT), at: Date.now() },
  ].slice(-MAX_ISSUES);
  for (const listener of issueListeners) {
    try {
      listener();
    } catch {
      // A diagnostic subscriber must never break the storage operation.
    }
  }
}

/** Subscribe to newly recorded issues; returns an idempotent unsubscribe. */
export function subscribeStorageIssues(listener: () => void): () => void {
  issueListeners.add(listener);
  return () => issueListeners.delete(listener);
}

/** Drain and clear issues recorded since the previous call. */
export function consumeStorageIssues(): StorageIssue[] {
  const result = issues;
  issues = [];
  return result;
}

/** Read JSON without throwing; malformed values fall back and are reported. */
export function readStorageJson<T>(key: string, fallback: T): T {
  const store = storage();
  if (store === null) {
    record(key, "unavailable", "local storage is unavailable");
    return fallback;
  }
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch (error) {
    record(key, "unavailable", `local storage read failed: ${String(error)}`);
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    record(key, "corrupt", `invalid JSON: ${String(error)}`);
    return fallback;
  }
}

/** Read a namespaced scalar without JSON parsing (for theme/feature flags). */
export function readStorageString(key: string, fallback: string | null = null): string | null {
  const store = storage();
  if (store === null) {
    record(key, "unavailable", "local storage is unavailable");
    return fallback;
  }
  try {
    return store.getItem(key) ?? fallback;
  } catch (error) {
    record(key, "unavailable", `local storage read failed: ${String(error)}`);
    return fallback;
  }
}

/** Write JSON without replacing the previous value when storage rejects it. */
export function writeStorageJson(key: string, value: unknown): boolean {
  const store = storage();
  if (store === null) {
    record(key, "unavailable", "local storage is unavailable");
    return false;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    record(key, "corrupt", "value is not JSON-serializable");
    return false;
  }
  try {
    store.setItem(key, serialized);
    return true;
  } catch (error) {
    const name =
      typeof DOMException !== "undefined" && error instanceof DOMException ? error.name : "";
    const message = String(error).toLowerCase();
    const kind: StorageIssueKind =
      name === "QuotaExceededError" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      message.includes("quota")
        ? "quota"
        : "unavailable";
    record(key, kind, `local storage write failed: ${String(error)}`);
    return false;
  }
}

/** Write a namespaced scalar without changing its representation. */
export function writeStorageString(key: string, value: string): boolean {
  const store = storage();
  if (store === null) {
    record(key, "unavailable", "local storage is unavailable");
    return false;
  }
  try {
    store.setItem(key, value);
    return true;
  } catch (error) {
    record(key, "quota", `local storage write failed: ${String(error)}`);
    return false;
  }
}

/** Read an ephemeral namespaced scalar without throwing in a restricted WebView. */
export function readSessionStorageString(key: string, fallback = ""): string {
  const store = sessionStorage();
  if (store === null) {
    record(key, "unavailable", "session storage is unavailable");
    return fallback;
  }
  try {
    return store.getItem(key) ?? fallback;
  } catch (error) {
    record(key, "unavailable", `session storage read failed: ${String(error)}`);
    return fallback;
  }
}

/** Write an ephemeral namespaced scalar while keeping the in-memory draft on failure. */
export function writeSessionStorageString(key: string, value: string): boolean {
  const store = sessionStorage();
  if (store === null) {
    record(key, "unavailable", "session storage is unavailable");
    return false;
  }
  try {
    store.setItem(key, value);
    return true;
  } catch (error) {
    record(key, "quota", `session storage write failed: ${String(error)}`);
    return false;
  }
}

/** Remove one ephemeral value without throwing. */
export function removeSessionStorageKey(key: string): boolean {
  const store = sessionStorage();
  if (store === null) {
    record(key, "unavailable", "session storage is unavailable");
    return false;
  }
  try {
    store.removeItem(key);
    return true;
  } catch (error) {
    record(key, "unavailable", `session storage remove failed: ${String(error)}`);
    return false;
  }
}

/** Remove one key, retaining an observable issue when the webview rejects it. */
export function removeStorageKey(key: string): boolean {
  const store = storage();
  if (store === null) {
    record(key, "unavailable", "local storage is unavailable");
    return false;
  }
  try {
    store.removeItem(key);
    return true;
  } catch (error) {
    record(key, "unavailable", `local storage remove failed: ${String(error)}`);
    return false;
  }
}

/**
 * Explicit user-requested recovery export. The snapshot is local JSON; no
 * network or host call is made. Unknown/non-JSON values are retained as raw
 * strings so a damaged entry is still recoverable for support.
 */
export function exportStorageSnapshot(prefix = "muse-desktop."): string {
  const store = storage();
  const entries: Record<string, unknown> = {};
  if (store === null) {
    record(prefix, "unavailable", "local storage is unavailable");
  } else {
    let length = 0;
    try {
      length = store.length;
    } catch (error) {
      record(prefix, "unavailable", `local storage enumeration failed: ${String(error)}`);
    }
    for (let i = 0; i < length; i += 1) {
      let key: string | null;
      try {
        key = store.key(i);
      } catch (error) {
        record(prefix, "unavailable", `local storage key lookup failed: ${String(error)}`);
        break;
      }
      if (key === null || !key.startsWith(prefix)) continue;
      let raw: string | null;
      try {
        raw = store.getItem(key);
      } catch (error) {
        record(key, "unavailable", `local storage read failed: ${String(error)}`);
        continue;
      }
      if (raw === null) continue;
      try {
        entries[key] = JSON.parse(raw);
      } catch {
        const bounded = boundRecoveryRaw(raw);
        entries[key] = {
          raw: bounded.raw,
          parseError: true,
          ...(bounded.truncated ? { truncated: true } : {}),
        };
      }
    }
  }
  return JSON.stringify(
    {
      format: "muse-desktop-storage",
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    },
    null,
    2,
  );
}

export interface StorageImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface StorageSnapshotEntry {
  key: string;
  existing: boolean;
  parseError: boolean;
}

export interface StorageSnapshotPreview {
  entries: StorageSnapshotEntry[];
  errors: string[];
}

export interface StorageMigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

export const STORAGE_MIGRATION_KEY = "muse-desktop.storage-migrations.v1";

/**
 * Validate a recovery snapshot and inspect which namespaced keys already
 * exist. Values stay in the serialized snapshot; the preview only exposes
 * key names and whether restoring would replace an existing entry.
 */
export function inspectStorageSnapshot(
  serialized: string,
  prefix = "muse-desktop.",
): StorageSnapshotPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { entries: [], errors: ["Recovery snapshot is not valid JSON."] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { entries: [], errors: ["Recovery snapshot must be a JSON object."] };
  }
  const snapshot = parsed as Record<string, unknown>;
  if (snapshot.format !== "muse-desktop-storage" || snapshot.version !== 1) {
    return { entries: [], errors: ["Unsupported recovery snapshot format or version."] };
  }
  const values = snapshot.entries;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return { entries: [], errors: ["Recovery snapshot has no valid entries map."] };
  }
  const entries: StorageSnapshotEntry[] = [];
  const errors: string[] = [];
  const store = storage();
  if (store === null) {
    record(prefix, "unavailable", "local storage is unavailable");
    return { entries: [], errors: ["Local storage is unavailable."] };
  }
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      errors.push(`Skipped non-namespaced key: ${key}`);
      continue;
    }
    let existing = false;
    try {
      existing = store.getItem(key) !== null;
    } catch (error) {
      record(key, "unavailable", `local storage read failed: ${String(error)}`);
      errors.push(`Could not inspect existing key: ${key}`);
      continue;
    }
    const parseError = typeof value === "object" && value !== null &&
      (value as Record<string, unknown>).parseError === true &&
      typeof (value as Record<string, unknown>).raw === "string";
    entries.push({ key, existing, parseError });
  }
  return { entries, errors };
}

/**
 * Legacy aliases from the pre-namespaced prototype. Migration is deliberately
 * copy-only: source keys remain available for rollback and existing v1 keys
 * always win. The log prefixes cover both early spellings used by prototypes.
 */
const LEGACY_EXACT_KEYS: Record<string, string> = {
  "muse.sessions": "muse-desktop.sessions.v1",
  "muse.sessions.v1": "muse-desktop.sessions.v1",
  "muse.workspace": "muse-desktop.workspace.v1",
  "muse.workspace.v1": "muse-desktop.workspace.v1",
  "muse.active": "muse-desktop.active.v1",
  "muse.active.v1": "muse-desktop.active.v1",
  "muse.settings": "muse-desktop.settings.v1",
  "muse.settings.v1": "muse-desktop.settings.v1",
};

/** Copy readable legacy entries into the current namespace without overwrite. */
export function migrateLegacyStorage(): StorageMigrationResult {
  const result: StorageMigrationResult = { migrated: 0, skipped: 0, errors: [] };
  const store = storage();
  if (store === null) {
    record(STORAGE_MIGRATION_KEY, "unavailable", "local storage is unavailable");
    return { ...result, errors: ["Local storage is unavailable."] };
  }
  const candidates = new Map<string, string>(Object.entries(LEGACY_EXACT_KEYS));
  let length = 0;
  try {
    length = Number.isFinite(store.length) ? store.length : 0;
  } catch (error) {
    record(STORAGE_MIGRATION_KEY, "unavailable", `local storage enumeration failed: ${String(error)}`);
    return { ...result, errors: ["Could not enumerate local storage."] };
  }
  for (let index = 0; index < length; index += 1) {
    let key: string | null = null;
    try {
      key = typeof store.key === "function" ? store.key(index) : null;
    } catch {
      key = null;
    }
    if (key === null) continue;
    if (key.startsWith("muse.log.")) {
      candidates.set(key, `muse-desktop.log.v1.${key.slice("muse.log.".length)}`);
    } else if (key.startsWith("muse.logs.")) {
      candidates.set(key, `muse-desktop.log.v1.${key.slice("muse.logs.".length)}`);
    }
  }
  for (const [sourceKey, targetKey] of candidates) {
    let raw: string | null;
    try {
      raw = store.getItem(sourceKey);
    } catch (error) {
      result.skipped += 1;
      result.errors.push(`Could not read legacy key: ${sourceKey}`);
      record(sourceKey, "unavailable", `legacy read failed: ${String(error)}`);
      continue;
    }
    if (raw === null) continue;
    try {
      JSON.parse(raw);
    } catch {
      result.skipped += 1;
      result.errors.push(`Skipped corrupt legacy key: ${sourceKey}`);
      record(sourceKey, "corrupt", "legacy value is not valid JSON");
      continue;
    }
    try {
      if (store.getItem(targetKey) !== null) {
        result.skipped += 1;
        continue;
      }
    } catch {
      result.skipped += 1;
      result.errors.push(`Could not inspect target key: ${targetKey}`);
      continue;
    }
    if (writeStorageString(targetKey, raw)) result.migrated += 1;
    else {
      result.skipped += 1;
      result.errors.push(`Could not migrate key: ${sourceKey}`);
    }
  }
  if (result.migrated > 0) {
    writeStorageJson(STORAGE_MIGRATION_KEY, {
      version: 1,
      migratedAt: new Date().toISOString(),
      migrated: result.migrated,
    });
  }
  return result;
}

/**
 * Restore a previously exported snapshot. The operation is explicit and
 * bounded to the same namespace as the exporter. Existing keys are kept by
 * default; callers can pass `overwrite=true` after an explicit confirmation.
 */
export function importStorageSnapshot(
  serialized: string,
  prefix = "muse-desktop.",
  overwrite = false,
  selectedKeys?: readonly string[],
): StorageImportResult {
  const result: StorageImportResult = { imported: 0, skipped: 0, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ...result, errors: ["Recovery snapshot is not valid JSON."] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...result, errors: ["Recovery snapshot must be a JSON object."] };
  }
  const snapshot = parsed as Record<string, unknown>;
  if (snapshot.format !== "muse-desktop-storage" || snapshot.version !== 1) {
    return { ...result, errors: ["Unsupported recovery snapshot format or version."] };
  }
  const entries = snapshot.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return { ...result, errors: ["Recovery snapshot has no valid entries map."] };
  }
  const store = storage();
  if (store === null) {
    record(prefix, "unavailable", "local storage is unavailable");
    return { ...result, errors: ["Local storage is unavailable."] };
  }
  const selected = selectedKeys === undefined ? null : new Set(selectedKeys);
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      result.skipped += 1;
      result.errors.push(`Skipped non-namespaced key: ${key}`);
      continue;
    }
    if (selected !== null && !selected.has(key)) {
      result.skipped += 1;
      continue;
    }
    let encoded: string;
    if (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).parseError === true &&
      typeof (value as Record<string, unknown>).raw === "string"
    ) {
      encoded = (value as Record<string, string>).raw;
    } else {
      try {
        encoded = JSON.stringify(value);
      } catch {
        result.skipped += 1;
        result.errors.push(`Skipped unserializable key: ${key}`);
        continue;
      }
    }
    if (!overwrite) {
      try {
        if (store.getItem(key) !== null) {
          result.skipped += 1;
          continue;
        }
      } catch (error) {
        record(key, "unavailable", `local storage read failed: ${String(error)}`);
        result.skipped += 1;
        result.errors.push(`Could not inspect existing key: ${key}`);
        continue;
      }
    }
    if (writeStorageString(key, encoded)) result.imported += 1;
    else {
      result.skipped += 1;
      result.errors.push(`Could not restore key: ${key}`);
    }
  }
  return result;
}
