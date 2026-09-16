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
let issues: StorageIssue[] = [];

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

function record(key: string, kind: StorageIssueKind, message: string): void {
  issues = [
    ...issues.filter((issue) => !(issue.key === key && issue.kind === kind)),
    { key, kind, message: message.slice(0, ISSUE_MESSAGE_LIMIT), at: Date.now() },
  ].slice(-MAX_ISSUES);
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
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    record(key, "quota", `local storage write failed: ${String(error)}`);
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
        entries[key] = { raw, parseError: true };
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

/**
 * Restore a previously exported snapshot. The operation is explicit and
 * bounded to the same namespace as the exporter. Existing keys are kept by
 * default; callers can pass `overwrite=true` after an explicit confirmation.
 */
export function importStorageSnapshot(
  serialized: string,
  prefix = "muse-desktop.",
  overwrite = false,
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
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      result.skipped += 1;
      result.errors.push(`Skipped non-namespaced key: ${key}`);
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
