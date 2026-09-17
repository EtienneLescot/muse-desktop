import assert from "node:assert/strict";
import test from "node:test";
import { searchTranscript } from "../src/lib/transcriptSearch.ts";

test("searchTranscript finds matches outside the rendered window", () => {
  const hits = searchTranscript([
    { id: "a", role: "user", text: "Start" },
    { id: "b", role: "assistant", text: "The deployment is ready" },
    { id: "c", role: "tool", text: "No match" },
  ], "DEPLOYMENT");
  assert.deepEqual(hits, [{
    index: 1,
    entryId: "b",
    role: "assistant",
    excerpt: "The deployment is ready",
  }]);
});

test("searchTranscript bounds query, excerpts and result count", () => {
  const long = `prefix ${"x".repeat(240)} target ${"y".repeat(240)}`;
  const hits = searchTranscript(
    Array.from({ length: 100 }, (_, index) => ({ id: String(index), role: "system" as const, text: long })),
    "x",
  );
  assert.equal(hits.length, 80);
  assert.ok(hits.every((hit) => hit.excerpt.length <= 182));
  assert.deepEqual(searchTranscript([{ id: "a", role: "user", text: "target" }], `${"q".repeat(300)}target`), []);
  assert.deepEqual(searchTranscript([{ id: "a", role: "user", text: "hello" }], "   "), []);
});
