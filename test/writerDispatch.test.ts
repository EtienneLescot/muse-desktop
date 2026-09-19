import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWriterPrompt,
  summarizeWriterLog,
  writerDispatchCanStart,
  writerDispatchIsActive,
} from "../src/lib/writerDispatch.ts";

describe("writer dispatch", () => {
  it("builds a bounded prompt with explicit target paths", () => {
    const prompt = buildWriterPrompt("agent-one", ["src/App.tsx", "src/lib/queue.ts"], "Fix the queue");
    assert.match(prompt, /writer agent-one/);
    assert.match(prompt, /src\/App\.tsx/);
    assert.match(prompt, /Assigned task:\nFix the queue/);
    assert.ok(prompt.length <= 6_000);
  });

  it("clips untrusted objective text", () => {
    const prompt = buildWriterPrompt("agent", ["src/a.ts"], "x".repeat(10_000));
    assert.ok(prompt.length <= 6_000);
    assert.match(prompt, /…$/);
  });

  it("only admits ready or queued rows while a lane is free", () => {
    assert.equal(writerDispatchCanStart("ready", 0, 2), true);
    assert.equal(writerDispatchCanStart("queued", 1, 2), true);
    assert.equal(writerDispatchCanStart("queued", 2, 2), false);
    assert.equal(writerDispatchCanStart("conflict", 0, 2), false);
    assert.equal(writerDispatchCanStart("blocked", 0, 2), false);
  });

  it("identifies dispatches that still occupy a lane", () => {
    assert.equal(writerDispatchIsActive("starting"), true);
    assert.equal(writerDispatchIsActive("running"), true);
    assert.equal(writerDispatchIsActive("stopping"), true);
    assert.equal(writerDispatchIsActive("complete"), false);
    assert.equal(writerDispatchIsActive("failed"), false);
  });

  it("summarizes observed writer output without claiming host structure", () => {
    const result = summarizeWriterLog([
      { id: "u", ts: 1, role: "user", text: "Do the work" },
      { id: "t", ts: 2, role: "tool", text: "npm test" },
      { id: "a", ts: 3, role: "assistant", text: "Finished the change" },
      {
        id: "e",
        ts: 4,
        role: "system",
        text: "The host reported an error",
        engineError: { kind: "host", message: "failed", retryable: false },
      },
    ]);
    assert.deepEqual(result, {
      entryCount: 4,
      assistantMessages: 1,
      toolEvents: 1,
      failures: 1,
      lastAssistantOutput: "Finished the change",
    });
  });

  it("returns no summary before a writer transcript exists", () => {
    assert.equal(summarizeWriterLog([]), null);
  });
});
