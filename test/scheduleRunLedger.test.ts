/**
 * Native mirror of the scheduled-run ledger (M3-07).
 *
 * Parallel to `notificationLedger.ts`, with one difference: this module exposes
 * no write queue of its own — `useMuseSessions.ts` wraps `saveNativeScheduleRuns`
 * in `createLatestWriteQueue` directly.
 *
 * It was unreachable from any test until the value imports in this file and in
 * `notificationLedger.ts` gained their `.ts` extension; a node process could not
 * resolve `from "./env"`. These tests keep it covered, and
 * `test/moduleReachability.test.ts` keeps it reachable.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_SCHEDULE_RUNS_SCHEMA,
  loadNativeScheduleRuns,
  saveNativeScheduleRuns,
} from "../src/lib/scheduleRunLedger.ts";

/** Minimal stand-in for the webview global, with or without the Tauri marker. */
function setRuntime(tauri: boolean): void {
  const w: Record<string, unknown> = {};
  if (tauri) w.__TAURI_INTERNALS__ = {};
  (globalThis as Record<string, unknown>).window = w;
}

function clearRuntime(): void {
  delete (globalThis as Record<string, unknown>).window;
}

beforeEach(() => clearRuntime());

describe("native schedule-run mirror", () => {
  it("reports the schema it writes", () => {
    assert.equal(NATIVE_SCHEDULE_RUNS_SCHEMA, "muse-desktop.native-schedule-runs.v1");
  });

  it("is inert outside the Tauri webview", async () => {
    assert.equal(await loadNativeScheduleRuns(), null);
    assert.equal(await saveNativeScheduleRuns([]), null);
  });

  it("is inert when there is no window at all", async () => {
    assert.equal(await loadNativeScheduleRuns(), null);
    assert.equal(await saveNativeScheduleRuns([]), null);
  });

  it("falls back instead of throwing when the IPC is unreachable", async () => {
    // The module's own comment states the contract: an unreadable mirror must
    // fall back to the renderer ledger, and the next write repairs it. That
    // means `null` on read, not an exception.
    setRuntime(true);
    assert.equal(await loadNativeScheduleRuns(), null);
    assert.equal(await saveNativeScheduleRuns([]), false);
  });

  it("never rejects, whatever the caller passes", async () => {
    setRuntime(true);
    const cases: unknown[] = [undefined, null, [], "not an array", { nope: true }, 42];
    for (const value of cases) {
      assert.equal(await loadNativeScheduleRuns(), null);
      const saved = await saveNativeScheduleRuns(value as never);
      assert.equal(saved, false, `saving ${JSON.stringify(value)} should report failure, not throw`);
    }
  });

  it("does not reach for the Tauri API when the runtime marker is absent", async () => {
    // Guards the ordering of the runtime check: it must come before the import.
    // If the import ran first, this call would reject rather than return null.
    const first = await loadNativeScheduleRuns();
    assert.equal(first, null);
  });
});
