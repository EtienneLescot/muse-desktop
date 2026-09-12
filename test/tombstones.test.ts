/**
 * Regression test: deleted sessions stay deleted (tombstones).
 *
 * The MSP host has no session/stop, so a killed session still exists
 * server-side and would be resurrected by `restore_sessions` or a late
 * in-flight event. The hook consults these persisted tombstones in all
 * three paths (boot list, restore merge, event handling).
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTombstones, saveTombstones } from "../src/lib/persist.ts";

function fakeStorage(): void {
  const m = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

describe("session tombstones", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("returns [] when nothing was deleted", () => {
    assert.deepEqual(loadTombstones(), []);
  });

  it("round-trips deleted ids", () => {
    saveTombstones(["aaa", "bbb"]);
    assert.deepEqual(loadTombstones(), ["aaa", "bbb"]);
  });

  it("filters out non-string and empty entries", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => JSON.stringify(["ok", 42, "", null, "fine"]),
      setItem: () => {},
      removeItem: () => {},
    };
    assert.deepEqual(loadTombstones(), ["ok", "fine"]);
  });

  it("returns [] on corrupt payload", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => "{not json",
      setItem: () => {},
      removeItem: () => {},
    };
    assert.deepEqual(loadTombstones(), []);
  });

  it("caps persisted ids to the newest 500", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `s-${i}`);
    saveTombstones(ids);
    const back = loadTombstones();
    assert.equal(back.length, 500);
    assert.equal(back[0], "s-100");
    assert.equal(back[499], "s-599");
  });
});
