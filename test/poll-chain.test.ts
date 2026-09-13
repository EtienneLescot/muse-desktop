/**
 * The poll tick (slow at idle) plus the immediate kick after send/answer/
 * approve share one promise chain so two drains never overlap with the same
 * cursor — overlap would deliver the same buffered events twice and duplicate
 * streamed text.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPollChain, enqueuePoll } from "../src/lib/poll.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("poll chain", () => {
  it("runs queued drains strictly one after another", async () => {
    const chain = createPollChain();
    const order: string[] = [];
    const first = deferred();
    const second = deferred();

    enqueuePoll(chain, async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    enqueuePoll(chain, async () => {
      order.push("second-start");
      await second.promise;
      order.push("second-end");
    });

    // Let the microtasks run: the second drain must not start early.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["first-start"]);

    first.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["first-start", "first-end", "second-start"]);

    second.resolve();
    await chain.current;
    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  });

  it("a rejected drain does not block later drains", async () => {
    const chain = createPollChain();
    const ran: string[] = [];
    enqueuePoll(chain, async () => {
      ran.push("bad");
      throw new Error("poll failed");
    });
    enqueuePoll(chain, async () => {
      ran.push("good");
    });
    await chain.current;
    assert.deepEqual(ran, ["bad", "good"]);
  });
});
