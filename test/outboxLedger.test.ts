import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOutboxWriteQueue,
  mergeOutboxStores,
  normalizeOutboxStore,
} from "../src/lib/outboxLedger.ts";
import { createOutboxEntry, markAccepted, type OutboxEntry } from "../src/lib/outbox.ts";

function entry(id: string, updatedAt = 100): OutboxEntry {
  return createOutboxEntry({
    clientMessageId: id,
    sessionId: "session-1",
    text: id,
    outgoingText: id,
    now: updatedAt,
  });
}

describe("native outbox ledger merge", () => {
  it("adds entries found only in the native mirror", () => {
    const merged = mergeOutboxStores(
      { "session-1": [entry("local")] },
      { "session-1": [entry("native")] },
    );
    assert.deepEqual(merged["session-1"]?.map((item) => item.clientMessageId), ["local", "native"]);
  });

  it("uses the newest copy and lets an accepted row suppress an older retry", () => {
    const local = entry("same", 100);
    const native = entry("same", 200);
    assert.equal(
      mergeOutboxStores({ "session-1": [local] }, { "session-1": [native] })["session-1"]?.[0]?.updatedAt,
      200,
    );
    const accepted = markAccepted(entry("same", 300), 300);
    assert.deepEqual(
      mergeOutboxStores({ "session-1": [entry("same", 100)] }, { "session-1": [accepted] }),
      {},
    );
  });

  it("drops malformed sessions and rows before merging", () => {
    const raw = normalizeOutboxStore({
      "session-1": [entry("ok"), { clientMessageId: "broken" }],
      "": [entry("empty-session")],
      bad: "not an array",
    });
    assert.deepEqual(Object.keys(raw), ["session-1"]);
    assert.deepEqual(raw["session-1"]?.map((item) => item.clientMessageId), ["ok"]);
  });

  it("serializes mirror writes and coalesces a burst to the newest snapshot", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const queue = createOutboxWriteQueue(async (store) => {
      started.push(store["session-1"]?.[0]?.clientMessageId ?? "empty");
      await new Promise<void>((resolve) => release.push(resolve));
    });

    queue({ "session-1": [entry("first")] });
    queue({ "session-1": [entry("second")] });
    queue({ "session-1": [entry("third")] });
    assert.deepEqual(started, ["first"]);
    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, ["first", "third"]);
    release.shift()?.();
  });
});
