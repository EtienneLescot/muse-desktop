import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadQueuedTurns,
  MAX_QUEUED_TURNS,
  QUEUED_TURNS_KEY,
  reconcileQueuedTurns,
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

  it("adopts a host snapshot without inventing text for known turns", () => {
    const rows = reconcileQueuedTurns("s", [
      { session_id: "s", turn_id: "t1", text: "build", createdAt: 10 },
    ], [
      { turnId: "t2", commandId: "c2" },
      { turnId: "t1", commandId: "c1" },
      { turnId: "t2", commandId: "duplicate" },
    ], 20);
    assert.deepEqual(rows, [
      { session_id: "s", turn_id: "t2", text: "Queued turn t2 — verify the host queue", createdAt: 20, recovered: true },
      { session_id: "s", turn_id: "t1", text: "build", createdAt: 10 },
    ]);
  });

  it("leaves local state untouched when no snapshot was served", () => {
    assert.equal(reconcileQueuedTurns("s", [], null), null);
    assert.equal(reconcileQueuedTurns("s", [], { queuedTurns: [] }), null);
  });
});
