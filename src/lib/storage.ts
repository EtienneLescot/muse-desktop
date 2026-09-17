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
const issueListeners = new Set<() => void>();

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
