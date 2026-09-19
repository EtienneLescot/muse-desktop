import assert from "node:assert/strict";
import test from "node:test";
import { parseStreamChunk } from "../src/lib/streamChunks.ts";

test("stream chunks accept the bridge's canonical shape", () => {
  assert.deepEqual(
    parseStreamChunk('{"itemId":"item-1","turnId":"turn-1","text":"hello"}'),
    { itemId: "item-1", turnId: "turn-1", text: "hello" },
  );
});

test("stream chunks normalize nested delta and summary shapes", () => {
  assert.deepEqual(
    parseStreamChunk(JSON.stringify({
      item: {
        item_id: "reason-1",
        turn_id: "turn-2",
        summary: ["Inspect files", "Check the tests"],
        output_ref: "output://reason-1",
      },
    })),
    {
      itemId: "reason-1",
      turnId: "turn-2",
      outputRef: "output://reason-1",
      text: "Inspect files\nCheck the tests",
    },
  );
  assert.deepEqual(
    parseStreamChunk('{"itemId":"item-2","delta":"next step"}'),
    { itemId: "item-2", text: "next step" },
  );
});

test("metadata-only JSON never leaks transport payload into the transcript", () => {
  assert.deepEqual(
    parseStreamChunk('{"itemId":"item-3","status":"inProgress"}'),
    { itemId: "item-3", text: "" },
  );
  assert.deepEqual(parseStreamChunk("plain host output"), { text: "plain host output" });
});
