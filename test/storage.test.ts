import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consumeStorageIssues,
  exportStorageSnapshot,
  readStorageJson,
  removeStorageKey,
  subscribeStorageIssues,
  writeStorageJson,
} from "../src/lib/storage.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, String(value));
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    get length(): number {
      return values.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  return { storage, values };
}

describe("defensive storage facade", () => {
  beforeEach(() => {
    fakeStorage();
    consumeStorageIssues();
  });

  it("reports corrupt JSON while returning the caller fallback", () => {
    fakeStorage({ "muse-desktop.sessions.v1": "{broken" });
    assert.deepEqual(readStorageJson("muse-desktop.sessions.v1", []), []);
    const [issue] = consumeStorageIssues();
    assert.equal(issue?.kind, "corrupt");
    assert.equal(issue?.key, "muse-desktop.sessions.v1");
  });

  it("reports unavailable and quota failures without throwing", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    assert.equal(readStorageJson("muse-desktop.any.v1", "fallback"), "fallback");
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    const emptySnapshot = JSON.parse(exportStorageSnapshot()) as {
      entries: Record<string, unknown>;
    };
    assert.deepEqual(emptySnapshot.entries, {});
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).localStorage = failing;
    assert.equal(writeStorageJson("muse-desktop.full.v1", { ok: true }), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "quota");

    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("storage blocked", "SecurityError");
      },
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).localStorage = blocked;
    assert.equal(writeStorageJson("muse-desktop.blocked.v1", { ok: true }), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");
  });

  it("rejects undefined serialization and notifies mounted subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeStorageIssues(() => {
      seen.push(...consumeStorageIssues().map((issue) => issue.kind));
    });
    assert.equal(writeStorageJson("muse-desktop.invalid.v1", undefined), false);
    assert.deepEqual(seen, ["corrupt"]);
    unsubscribe();
  });

  it("exports valid and damaged namespaced entries for recovery", () => {
    const { values } = fakeStorage({
      "muse-desktop.sessions.v1": JSON.stringify([{ session_id: "s1" }]),
      "muse-desktop.corrupt.v1": "{broken",
      unrelated: "should not export",
    });
    const snapshot = JSON.parse(exportStorageSnapshot()) as {
      format: string;
      version: number;
      entries: Record<string, unknown>;
    };
    assert.equal(snapshot.format, "muse-desktop-storage");
    assert.equal(snapshot.version, 1);
    assert.deepEqual(snapshot.entries["muse-desktop.sessions.v1"], [{ session_id: "s1" }]);
    assert.deepEqual(snapshot.entries["muse-desktop.corrupt.v1"], {
      raw: "{broken",
      parseError: true,
    });
    assert.equal(snapshot.entries.unrelated, undefined);
    assert.equal(values.get("unrelated"), "should not export");
  });

  it("removes a key through the same safe facade", () => {
    const { values } = fakeStorage({ "muse-desktop.tmp.v1": "1" });
    assert.equal(removeStorageKey("muse-desktop.tmp.v1"), true);
    assert.equal(values.has("muse-desktop.tmp.v1"), false);
  });
});
