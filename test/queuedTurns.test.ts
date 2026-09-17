import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadQueuedTurns,
  MAX_QUEUED_TURNS,
  QUEUED_TURNS_KEY,
  saveQueuedTurns,
} from "../src/lib/queuedTurns.ts";

function fakeStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); },
  };
}

describe("M1-10 persistent queued turns", () => {
  it("round-trips queue order and ignores renderer-only recovery flags", () => {
    fakeStorage();
    saveQueuedTurns({
      first: [
        { session_id: "first", turn_id: "t1", text: "one", createdAt: 1, recovered: true },
        { session_id: "first", turn_id: "t2", text: "two", createdAt: 2 },
      ],
    });
    assert.deepEqual(loadQueuedTurns().first, [
      { session_id: "first", turn_id: "t1", text: "one", createdAt: 1 },
      { session_id: "first", turn_id: "t2", text: "two", createdAt: 2 },
    ]);
  });

  it("caps oversized snapshots", () => {
    fakeStorage();
    const rows = Array.from({ length: MAX_QUEUED_TURNS + 10 }, (_, i) => ({
      session_id: "s", turn_id: `t${i}`, text: `message ${i}`, createdAt: i,
    }));
    saveQueuedTurns({ s: rows });
    const loaded = loadQueuedTurns().s;
    assert.equal(loaded.length, MAX_QUEUED_TURNS);
    assert.equal(loaded[0].turn_id, "t10");
    assert.ok(localStorage.getItem(QUEUED_TURNS_KEY));
  });

  it("fails closed on malformed storage", () => {
    fakeStorage();
    localStorage.setItem(QUEUED_TURNS_KEY, "[]");
    assert.deepEqual(loadQueuedTurns(), {});
  });
});
