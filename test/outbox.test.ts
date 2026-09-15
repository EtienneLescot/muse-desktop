/**
 * M0-03 lossless send: outbox state machine + durable storage.
 *
 * One logical send carries a stable clientMessageId across retries; entries
 * walk sending → accepted (removed) or failed (kept, retryable). Entries
 * still `sending` at boot are ambiguous: no ack ever arrived, so a retry
 * must verify the server before retransmitting.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capOutbox,
  createOutboxEntry,
  failedOutbox,
  findOutbox,
  markAccepted,
  markFailed,
  markSending,
  MAX_OUTBOX_ENTRIES,
  recoverInterrupted,
  removeOutbox,
  sendAccepted,
  sendFailed,
  upsertOutbox,
  type OutboxEntry,
} from "../src/lib/outbox.ts";
import {
  appendLog,
  loadLog,
  loadOutbox,
  saveOutbox,
} from "../src/lib/persist.ts";

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

let seq = 0;
function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  seq += 1;
  return createOutboxEntry({
    clientMessageId: overrides.clientMessageId ?? `cmid-${seq}`,
    sessionId: overrides.sessionId ?? "sess-1",
    text: overrides.text ?? "hello",
    outgoingText: overrides.outgoingText ?? "hello",
    now: overrides.now ?? 1000,
  });
}

describe("outbox state machine", () => {
  it("creates a sending entry with one attempt and no error", () => {
    const e = entry();
    assert.equal(e.state, "sending");
    assert.equal(e.attempts, 1);
    assert.equal(e.error, null);
    assert.equal(e.ambiguous, false);
  });

  it("accepting clears ambiguity and error", () => {
    const failed = markFailed(entry(), "boom", 2000, true);
    const ok = markAccepted(failed, 3000);
    assert.equal(ok.state, "accepted");
    assert.equal(ok.error, null);
    assert.equal(ok.ambiguous, false);
    assert.equal(ok.updatedAt, 3000);
  });

  it("a retry grows attempts and returns to sending", () => {
    const e = markFailed(entry(), "boom", 2000, false);
    const retried = markSending(e, 3000);
    assert.equal(retried.state, "sending");
    assert.equal(retried.attempts, 2);
    assert.equal(retried.error, null);
  });

  it("markFailed keeps the given ambiguity flag and reason", () => {
    const e = markFailed(entry(), "host gone", 2000, true);
    assert.equal(e.state, "failed");
    assert.equal(e.error, "host gone");
    assert.equal(e.ambiguous, true);
  });
});

describe("outbox list helpers", () => {
  it("upserts by clientMessageId without duplicating", () => {
    const a = entry();
    const list = upsertOutbox([a], markFailed(a, "boom", 2000, false));
    assert.equal(list.length, 1);
    assert.equal(list[0].state, "failed");
    const b = entry();
    assert.equal(upsertOutbox(list, b).length, 2);
  });

  it("finds and removes by clientMessageId", () => {
    const a = entry();
    const b = entry();
    const list = [a, b];
    assert.equal(findOutbox(list, b.clientMessageId), b);
    assert.deepEqual(removeOutbox(list, a.clientMessageId), [b]);
    assert.equal(findOutbox(list, "missing"), null);
  });

  it("failedOutbox keeps only retryable entries", () => {
    const a = markFailed(entry(), "boom", 2000, false);
    const b = entry();
    assert.deepEqual(failedOutbox([a, b]), [a]);
  });

  it("caps the list, keeping the newest", () => {
    const list: OutboxEntry[] = [];
    for (let i = 0; i < MAX_OUTBOX_ENTRIES + 5; i++) list.push(entry());
    const capped = capOutbox(list);
    assert.equal(capped.length, MAX_OUTBOX_ENTRIES);
    assert.equal(capped[capped.length - 1], list[list.length - 1]);
  });
});

describe("boot recovery", () => {
  it("recovers sending entries as failed/ambiguous", () => {
    const a = entry();
    const { entries, recovered } = recoverInterrupted([a], 5000);
    assert.equal(recovered, 1);
    assert.equal(entries[0].state, "failed");
    assert.equal(entries[0].ambiguous, true);
    assert.match(entries[0].error as string, /restarted/);
  });

  it("leaves failed entries untouched (idempotent across remounts)", () => {
    const a = markFailed(entry(), "boom", 2000, false);
    const first = recoverInterrupted([a], 5000);
    assert.equal(first.recovered, 0);
    const second = recoverInterrupted(first.entries, 6000);
    assert.equal(second.recovered, 0);
    assert.deepEqual(second.entries, [a]);
  });
});

describe("send results", () => {
  it("builds explicit accepted/failed results", () => {
    assert.deepEqual(sendAccepted("id-1"), {
      ok: true,
      clientMessageId: "id-1",
      error: null,
    });
    assert.deepEqual(sendFailed(null, "empty"), {
      ok: false,
      clientMessageId: null,
      error: "empty",
    });
  });
});

describe("outbox persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("round-trips entries per session", () => {
    const a = entry();
    const b = entry({ sessionId: "sess-2" });
    saveOutbox("sess-1", [a]);
    saveOutbox("sess-2", [b]);
    assert.deepEqual(loadOutbox("sess-1"), [a]);
    assert.deepEqual(loadOutbox("sess-2"), [b]);
  });

  it("returns [] on corrupt payload and filters invalid rows", () => {
    const storage = (globalThis as Record<string, unknown>).localStorage as {
      setItem: (k: string, v: string) => void;
    };
    storage.setItem("muse-desktop.outbox.v1.sess-1", "{not json");
    assert.deepEqual(loadOutbox("sess-1"), []);
    storage.setItem(
      "muse-desktop.outbox.v1.sess-1",
      JSON.stringify([{ clientMessageId: "only-id" }, "junk", null]),
    );
    assert.deepEqual(loadOutbox("sess-1"), []);
  });
});

describe("log entries carry the idempotency key", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("a user entry keeps its clientMessageId across restarts", () => {
    appendLog("sess-1", [
      {
        id: "e1",
        ts: 1000,
        role: "user",
        text: "hello",
        clientMessageId: "cmid-1",
      },
    ]);
    const log = loadLog("sess-1");
    assert.equal(log.length, 1);
    assert.equal(log[0].clientMessageId, "cmid-1");
    assert.equal(log[0].role, "user");
  });
});
