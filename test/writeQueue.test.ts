import assert from "node:assert/strict";
import test from "node:test";
import { createLatestWriteQueue } from "../src/lib/writeQueue.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test("writeQueue writes a lone value", async () => {
  const written: number[] = [];
  const enqueue = createLatestWriteQueue<number>(async (value) => {
    written.push(value);
  });
  enqueue(1);
  await flush();
  assert.deepEqual(written, [1]);
});

test("writeQueue coalesces a synchronous burst to first and latest", async () => {
  const gate = deferred();
  const written: number[] = [];
  const enqueue = createLatestWriteQueue<number>(async (value) => {
    written.push(value);
    if (value === 1) await gate.promise;
  });
  enqueue(1);
  enqueue(2);
  enqueue(3);
  await flush(3);
  // The first write is already in flight; only the latest pending wins.
  assert.deepEqual(written, [1]);
  gate.resolve();
  await flush();
  assert.deepEqual(written, [1, 3]);
});

test("writeQueue swallows mirror failures and keeps draining", async () => {
  const written: number[] = [];
  const enqueue = createLatestWriteQueue<number>(async (value) => {
    written.push(value);
    if (value === 1) throw new Error("mirror down");
  });
  enqueue(1);
  enqueue(2);
  await flush();
  assert.deepEqual(written, [1, 2]);
});

test("writeQueue picks up values enqueued after a drain", async () => {
  const written: number[] = [];
  const enqueue = createLatestWriteQueue<number>(async (value) => {
    written.push(value);
  });
  enqueue(1);
  await flush();
  enqueue(2);
  await flush();
  assert.deepEqual(written, [1, 2]);
});

test("writeQueue rejections do not break later writes", async () => {
  const gate = deferred();
  let calls = 0;
  const written: number[] = [];
  const enqueue = createLatestWriteQueue<number>(async (value) => {
    calls += 1;
    written.push(value);
    if (calls === 1) {
      await gate.promise;
      throw new Error("late mirror failure");
    }
  });
  enqueue(1);
  enqueue(2);
  await flush(3);
  gate.resolve();
  await flush();
  assert.deepEqual(written, [1, 2]);
});
