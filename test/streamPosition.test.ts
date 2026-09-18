import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadStreamPosition,
  removeStreamPosition,
  saveStreamPosition,
  STREAM_POSITIONS_KEY,
} from "../src/lib/streamPosition.ts";

function fakeStorage(initial: unknown[] = []): Map<string, string> {
  const values = new Map<string, string>([[STREAM_POSITIONS_KEY, JSON.stringify(initial)]]);
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); },
  };
  return values;
}

describe("stream viewport position persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("rounds and restores bounded coordinates per conversation", () => {
    saveStreamPosition("session-1", 123.9, 40.8, 1000);
    assert.deepEqual(loadStreamPosition("session-1"), {
      sessionId: "session-1",
      scrollTop: 123,
      windowStart: 40,
      updatedAt: 1000,
    });
  });

  it("replaces a conversation row while retaining other conversations", () => {
    saveStreamPosition("session-1", 10, 2, 1000);
    saveStreamPosition("session-2", 20, 4, 1100);
    saveStreamPosition("session-1", 30, 6, 1200);
    assert.equal(loadStreamPosition("session-1")?.scrollTop, 30);
    assert.equal(loadStreamPosition("session-2")?.scrollTop, 20);
  });

  it("ignores invalid coordinates and removes deleted conversations", () => {
    saveStreamPosition("session-1", -1, 0, 1000);
    saveStreamPosition("session-1", 1, Number.POSITIVE_INFINITY, 1000);
    assert.equal(loadStreamPosition("session-1"), null);
    saveStreamPosition("session-1", 5, 1, 1000);
    removeStreamPosition("session-1");
    assert.equal(loadStreamPosition("session-1"), null);
  });
});
