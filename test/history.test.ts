import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyItemsToLogEntries, mergeHistoryLog } from "../src/lib/history.ts";

describe("session history hydration", () => {
  it("maps durable item kinds to the live conversation lanes", () => {
    const entries = historyItemsToLogEntries([
      { itemId: "u1", kind: "userMessage", displayText: "Hello", recordedAt: "2026-09-16T10:00:00Z", status: "completed", commandId: "cmd-1" },
      { itemId: "r1", kind: "reasoning", summary: ["First", "second"], status: "completed" },
      { itemId: "a1", kind: "agentMessage", text: "Done", status: "completed", childSessionId: "child", turnId: "turn-1" },
      { itemId: "t1", kind: "toolCall", tool: "bash", args: "{\"command\":\"pwd\"}", status: "completed" },
    ], 1000);
    assert.deepEqual(entries.map((entry) => [entry.role, entry.text]), [
      ["user", "Hello"],
      ["thinking", "First\n\nsecond"],
      ["assistant", "Done"],
      ["tool", "bash: {\"command\":\"pwd\"}"],
    ]);
    assert.equal(entries[0].clientMessageId, "cmd-1");
    assert.equal(entries[2].childSessionId, "child");
    assert.equal(entries[2].turnId, "turn-1");
  });

  it("keeps reasoning aliases in the collapsible thinking lane", () => {
    const entries = historyItemsToLogEntries([
      { itemId: "r1", kind: "reasoningSummary", summary: ["Plan step one"] },
      { itemId: "r2", kind: "analysis", text: "Check the workspace" },
    ], 1000);
    assert.deepEqual(entries.map((entry) => [entry.role, entry.text]), [
      ["thinking", "Plan step one"],
      ["thinking", "Check the workspace"],
    ]);
  });

  it("keeps a durable user-shell command paired with its completed output", () => {
    const entries = historyItemsToLogEntries([
      {
        itemId: "shell-1",
        kind: "userShell",
        commandText: "git status",
        visibleOutput: "clean",
        status: "completed",
      },
    ], 1000);
    assert.deepEqual(entries.map((entry) => [entry.role, entry.text]), [
      ["tool", "$ git status\nclean"],
    ]);
  });

  it("preserves a lazy output reference for large tool items", () => {
    const entries = historyItemsToLogEntries([
      {
        itemId: "shell-large",
        kind: "userShell",
        commandText: "npm test",
        visibleOutput: "summary",
        outputRef: "output://shell-large",
        status: "completed",
      },
    ]);
    assert.equal(entries[0].outputRef, "output://shell-large");
  });

  it("reconciles by item id and keeps local notes without duplicating user text", () => {
    const local = [
      { id: "local-user", ts: 1, role: "user" as const, text: "Hello" },
      { id: "local-note", ts: 3, role: "system" as const, text: "queued" },
      { id: "local-assistant", ts: 2, role: "assistant" as const, text: "partial", itemId: "a1", open: true },
    ];
    const remote = [
      { id: "history:u1", ts: 1, role: "user" as const, text: "Hello", itemId: "u1" },
      { id: "history:a1", ts: 4, role: "assistant" as const, text: "complete", itemId: "a1", open: false },
    ];
    const merged = mergeHistoryLog(local, remote);
    assert.equal(merged.filter((entry) => entry.role === "user").length, 1);
    assert.equal(merged.find((entry) => entry.itemId === "a1")?.text, "complete");
    assert.equal(merged.find((entry) => entry.role === "system")?.text, "queued");
  });
});
