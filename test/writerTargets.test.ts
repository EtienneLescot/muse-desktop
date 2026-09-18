import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WRITER_TARGET_TEXT,
  normalizeWriterTargetStore,
  normalizeWriterTargets,
  updateWriterTargetStore,
} from "../src/lib/writerTargets.ts";

describe("writer target persistence", () => {
  it("drops malformed entries and bounds editable declarations", () => {
    const normalized = normalizeWriterTargets({
      one: " src/App.tsx ",
      empty: "   ",
      bad: 42,
      [" ".repeat(2)]: "src/no-agent.ts",
      long: "x".repeat(MAX_WRITER_TARGET_TEXT + 100),
    });
    assert.equal(normalized.one, "src/App.tsx");
    assert.equal(normalized.empty, undefined);
    assert.equal(normalized.bad, undefined);
    assert.equal(normalized.long?.length, MAX_WRITER_TARGET_TEXT);
  });

  it("keeps workspace declarations isolated and removes an emptied workspace", () => {
    const first = updateWriterTargetStore({}, "C:/repo-a", { one: "src/a.ts" });
    const second = updateWriterTargetStore(first, "C:/repo-b", { two: "src/b.ts" });
    assert.deepEqual(second["C:/repo-a"], { one: "src/a.ts" });
    assert.deepEqual(second["C:/repo-b"], { two: "src/b.ts" });
    const removed = updateWriterTargetStore(second, "C:/repo-a", {});
    assert.equal(removed["C:/repo-a"], undefined);
    assert.deepEqual(removed["C:/repo-b"], { two: "src/b.ts" });
  });

  it("ignores malformed workspace records and caps the store", () => {
    const normalized = normalizeWriterTargetStore({
      bad: null,
      "C:/valid": { agent: "src/a.ts" },
      "": { agent: "src/empty.ts" },
    });
    assert.deepEqual(normalized, { "C:/valid": { agent: "src/a.ts" } });
  });
});
