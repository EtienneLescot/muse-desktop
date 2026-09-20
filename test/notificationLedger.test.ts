/**
 * Native mirror of the notification inbox (M3-09).
 *
 * `notificationLedger.ts` was the only module in `src/lib` (besides two trivial
 * constants) that no test imported. It sits on the boundary to the native side:
 * it decides whether the Tauri IPC is reachable, refuses a payload whose schema
 * does not match, and funnels concurrent mirror writes through an ordering
 * queue.
 *
 * The tests below stay on the side of that boundary a node process can reach:
 * the runtime guard, the failure contract (never throw, return `null`/`false`),
 * and the queue's ordering. The IPC call itself is not exercised — a node
 * process cannot reach it.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_NOTIFICATIONS_SCHEMA,
  createNotificationWriteQueue,
  loadNativeNotifications,
  saveNativeNotifications,
} from "../src/lib/notificationLedger.ts";

/** Minimal stand-in for the webview global, with or without the Tauri marker. */
function setRuntime(tauri: boolean): void {
  const w: Record<string, unknown> = {};
  if (tauri) w.__TAURI_INTERNALS__ = {};
  (globalThis as Record<string, unknown>).window = w;
}

/** No webview global at all, as in a plain node process. */
function clearRuntime(): void {
  delete (globalThis as Record<string, unknown>).window;
}

/**
 * Wait for a condition instead of sleeping a fixed delay.
 *
 * A fixed `setTimeout` does not guarantee the writer callback has run: a slow or
 * busy machine can fail the assertion for no real reason. Polling with a
 * generous ceiling keeps the test honest on a slow worker while still failing if
 * the condition never holds.
 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

beforeEach(() => clearRuntime());

describe("native notification mirror", () => {
  it("reports the schema it writes", () => {
    assert.equal(NATIVE_NOTIFICATIONS_SCHEMA, "muse-desktop.native-notifications.v1");
  });

  it("is inert outside the Tauri webview", async () => {
    // Without the runtime marker, both directions must decline rather than
    // attempt an import of the Tauri API.
    assert.equal(await loadNativeNotifications(), null);
    assert.equal(await saveNativeNotifications([]), null);
  });

  it("is inert when there is no window at all", async () => {
    // A worker or a test process has no `window`; the guard must not throw.
    assert.equal(await loadNativeNotifications(), null);
    assert.equal(await saveNativeNotifications([]), null);
  });

  it("declines instead of throwing when the IPC is unreachable", async () => {
    setRuntime(true);
    // The Tauri API module cannot resolve here, which is exactly the failure a
    // broken or missing native side produces.
    assert.equal(await loadNativeNotifications(), null);
    assert.equal(await saveNativeNotifications([]), false);
  });

  it("never rejects, whatever the caller passes", async () => {
    setRuntime(true);
    const cases: unknown[] = [undefined, null, [], "not an array", { nope: true }];
    for (const value of cases) {
      const loaded = await loadNativeNotifications();
      assert.equal(loaded, null);
      const saved = await saveNativeNotifications(value as never);
      assert.equal(saved, false, `saving ${JSON.stringify(value)} should report failure, not throw`);
    }
  });
});

describe("notification write queue", () => {
  it("returns a synchronous enqueue function", () => {
    const queue = createNotificationWriteQueue(async () => undefined);
    assert.equal(typeof queue, "function");
    // Enqueueing must not return a promise the caller could await out of order.
    const returned = queue([]);
    assert.equal(returned, undefined);
  });

  it("coalesces writes that arrive while one is in flight", async () => {
    // The queue is a *latest-write* queue: intermediate states are dropped on
    // purpose so the native mirror never lands on a stale value. My first
    // version of this test asserted every enqueue reached the writer, which is
    // the opposite of the contract.
    const seen: number[] = [];
    let release: (() => void) | null = null;
    const queue = createNotificationWriteQueue(async (items) => {
      seen.push(items.length);
      await new Promise<void>((resolve) => { release = resolve; });
    });

    queue([{ id: "a" } as never]);                       // starts the first write
    queue([{ id: "a" } as never, { id: "b" } as never]); // coalesced
    queue([{ id: "c" } as never]);                       // replaces the pending one
    await waitFor(() => seen.length >= 1, "the first write never started");
    assert.equal(seen.length, 1, "only the in-flight write should have started");

    release?.();
    await waitFor(() => seen.length >= 2, "the coalesced batch never followed");
    assert.equal(seen.length, 2, "exactly one follow-up write");
    assert.equal(seen[1], 1, "the last enqueued state wins");
  });

  it("keeps going after a writer that rejects", async () => {
    // A failed native write must not wedge the mirror for later events.
    let attempts = 0;
    const queue = createNotificationWriteQueue(async () => {
      attempts += 1;
      throw new Error("native write failed");
    });
    queue([]);
    queue([]);
    await waitFor(() => attempts >= 2, "the second write was never attempted");
    assert.equal(attempts, 2, "the second write should still be attempted");
  });
});
