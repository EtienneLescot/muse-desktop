/**
 * US-10 reflexive phase: kind→phase mapping + placeholder helpers.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REFLEXIVE_LABEL,
  applyItemSnapshotUpdate,
  dropEmptyPlaceholders,
  isItemStartKind,
  itemSnapshotIsTerminal,
  itemSnapshotLane,
  isRunningKind,
  isStoppedKind,
  isSubagentItemKind,
  isTerminalItemStatus,
  isThinkingItemKind,
  normalizeKind,
  phaseForKind,
  upsertReflexivePlaceholder,
  type PlaceholderStamp,
} from "../src/lib/phase.ts";
import type { LogEntry } from "../src/lib/persist.ts";

function entry(over: Partial<LogEntry> & { role: LogEntry["role"] }): LogEntry {
  return { id: "e", ts: 1, text: "", ...over };
}

const stamp: PlaceholderStamp = { id: "ph", ts: 7 };

describe("normalizeKind", () => {
  it("strips the method namespace and lowercases", () => {
    assert.equal(normalizeKind("turn/started"), "started");
    assert.equal(normalizeKind("ITEM/STARTED"), "started");
    assert.equal(normalizeKind("started"), "started");
    assert.equal(normalizeKind("turn_start"), "turn_start");
  });
});

describe("isRunningKind", () => {
  it("covers bare and namespaced running kinds", () => {
    for (const k of [
      "started",
      "running",
      "created",
      "turn_start",
      "turn/started",
      "TURN/STARTED",
      "item_started",
      "item/started",
    ]) {
      assert.equal(isRunningKind(k), true, k);
    }
  });

  it("rejects stopped and stream kinds", () => {
    for (const k of ["completed", "turn_end", "error", "output", "idle", ""]) {
      assert.equal(isRunningKind(k), false, k);
    }
  });
});

describe("isItemStartKind", () => {
  it("matches only item starts, never turn starts", () => {
    assert.equal(isItemStartKind("item_started"), true);
    assert.equal(isItemStartKind("item/started"), true);
    assert.equal(isItemStartKind("ITEM/STARTED"), true);
    assert.equal(isItemStartKind("started"), false);
    assert.equal(isItemStartKind("turn/started"), false);
    assert.equal(isItemStartKind("output"), false);
  });
});

describe("isStoppedKind", () => {
  it("covers bare and namespaced stopped kinds", () => {
    for (const k of [
      "cancelled",
      "retracted",
      "completed",
      "stopped",
      "exited",
      "host_exited",
      "error",
      "failed",
      "succeeded",
      "done",
      "aborted",
      "timed_out",
      "turn_end",
      "idle",
      "turn/completed",
      "turn/retracted",
      "turn/stopped",
    ]) {
      assert.equal(isStoppedKind(k), true, k);
    }
  });

  it("rejects running and stream kinds", () => {
    for (const k of ["started", "running", "output", "item_started"]) {
      assert.equal(isStoppedKind(k), false, k);
    }
  });
});

describe("phaseForKind", () => {
  it("maps kinds to stream phases", () => {
    assert.equal(phaseForKind("started"), "reflexive");
    assert.equal(phaseForKind("turn/started"), "reflexive");
    assert.equal(phaseForKind("item/started"), "reflexive");
    assert.equal(phaseForKind("item_started"), "reflexive");
    assert.equal(phaseForKind("output"), "streaming");
    assert.equal(phaseForKind("subagent_event"), "streaming");
    assert.equal(phaseForKind("item_done"), "streaming");
    assert.equal(phaseForKind("thinking"), "streaming");
    assert.equal(phaseForKind("reasoning"), "streaming");
    assert.equal(phaseForKind("completed"), "stopped");
    assert.equal(phaseForKind("turn/retracted"), "stopped");
    assert.equal(phaseForKind("turn_end"), "stopped");
    assert.equal(phaseForKind("approval/resolved"), "other");
    assert.equal(phaseForKind("something-new"), "other");
  });
});

describe("isSubagentItemKind", () => {
  it("matches the subagent lane kinds case-insensitively", () => {
    assert.equal(isSubagentItemKind("subagent"), true);
    assert.equal(isSubagentItemKind("workflow"), true);
    assert.equal(isSubagentItemKind("reminderChild"), true);
    assert.equal(isSubagentItemKind("agentMessage"), false);
    assert.equal(isSubagentItemKind("reasoning"), false);
  });
});

describe("isThinkingItemKind", () => {
  it("matches reasoning lane aliases case-insensitively", () => {
    for (const k of [
      "reasoning",
      "thinking",
      "analysis",
      "reasoning_summary",
      "REASONINGSUMMARY",
    ]) {
      assert.equal(isThinkingItemKind(k), true, k);
    }
    assert.equal(isThinkingItemKind("agentMessage"), false);
  });
});

describe("isTerminalItemStatus", () => {
  it("recognizes terminal item snapshot statuses", () => {
    assert.equal(isTerminalItemStatus("completed"), true);
    assert.equal(isTerminalItemStatus("item/done"), true);
    assert.equal(isTerminalItemStatus("inProgress"), false);
    assert.equal(isTerminalItemStatus(null), false);
  });
});

describe("item snapshot normalization", () => {
  it("keeps reasoning and shell snapshots in their dedicated lanes", () => {
    assert.equal(itemSnapshotLane({ item: { kind: "reasoning" } }), "thinking");
    assert.equal(itemSnapshotLane({ itemKind: "analysis" }), "thinking");
    assert.equal(itemSnapshotLane({ item: { kind: "userShell" } }), "tool");
    assert.equal(itemSnapshotLane({ lane: "shell_output", kind: "assistant" }), "tool");
    assert.equal(itemSnapshotLane({ kind: "agentMessage" }), "assistant");
  });

  it("recognizes terminal flags from flat and nested host snapshots", () => {
    assert.equal(itemSnapshotIsTerminal({ open: false }), true);
    assert.equal(itemSnapshotIsTerminal({ completed: true }), true);
    assert.equal(itemSnapshotIsTerminal({ item: { status: "done" } }), true);
    assert.equal(itemSnapshotIsTerminal({ status: "inProgress", item: { status: "inProgress" } }), false);
  });
});

describe("upsertReflexivePlaceholder", () => {
  it("creates an empty open assistant entry on an empty log", () => {
    const next = upsertReflexivePlaceholder([], { stamp });
    assert.equal(next.length, 1);
    assert.equal(next[0].role, "assistant");
    assert.equal(next[0].text, "");
    assert.equal(next[0].open, true);
    assert.equal(next[0].id, "ph");
  });

  it("is a no-op when a live assistant entry already exists", () => {
    const log = [entry({ role: "user", text: "hi" }), entry({ role: "assistant", text: "", open: true })];
    assert.equal(upsertReflexivePlaceholder(log, { stamp }), log);
    const streaming = [entry({ role: "assistant", text: "hello", open: true })];
    // A second start must not stack another placeholder mid-stream.
    assert.equal(upsertReflexivePlaceholder(streaming, { stamp }), streaming);
  });

  it("stamps the item id onto a send-time placeholder", () => {
    const log = [entry({ role: "assistant", text: "", open: true })];
    const next = upsertReflexivePlaceholder(log, { itemId: "it-1", stamp });
    assert.equal(next.length, 1);
    assert.equal(next[0].itemId, "it-1");
    assert.equal(next[0].text, "");
  });

  it("creates a subagent entry per agent id", () => {
    const first = upsertReflexivePlaceholder([], { agentId: "a1", stamp });
    assert.equal(first[0].role, "subagent");
    assert.equal(first[0].agentId, "a1");
    assert.equal(upsertReflexivePlaceholder(first, { agentId: "a1", stamp }), first);
    const second = upsertReflexivePlaceholder(first, { agentId: "a2", stamp });
    assert.equal(second.length, 2);
  });

  it("promotes the send-time placeholder for a reasoning item", () => {
    const send = upsertReflexivePlaceholder([], { stamp });
    const next = upsertReflexivePlaceholder(send, {
      itemId: "reason-1",
      role: "thinking",
      stamp,
    });
    assert.equal(next.length, 1);
    assert.equal(next[0].role, "thinking");
    assert.equal(next[0].itemId, "reason-1");
    assert.equal(next[0].open, true);
  });

  it("seeds and binds a user-shell tool entry to its host item", () => {
    const seeded = upsertReflexivePlaceholder([], {
      role: "tool",
      initialText: "$ git status",
      stamp,
    });
    assert.equal(seeded[0].role, "tool");
    assert.equal(seeded[0].text, "$ git status");
    const bound = upsertReflexivePlaceholder(seeded, {
      role: "tool",
      itemId: "shell-1",
      stamp,
    });
    assert.equal(bound.length, 1);
    assert.equal(bound[0].itemId, "shell-1");
    assert.equal(bound[0].text, "$ git status");
  });
});

describe("applyItemSnapshotUpdate", () => {
  it("replaces a live lane by item id and revision", () => {
    const live = [entry({ role: "thinking", itemId: "r1", text: "first", open: true, itemRevision: 2 })];
    const updated = applyItemSnapshotUpdate(live, {
      itemId: "r1",
      role: "thinking",
      text: "first\nsecond",
      revision: 3,
      open: true,
      stamp,
    });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].text, "first\nsecond");
    assert.equal(updated[0].itemRevision, 3);
    assert.equal(applyItemSnapshotUpdate(updated, {
      itemId: "r1",
      role: "thinking",
      text: "stale",
      revision: 2,
      open: true,
      stamp,
    }), updated);
  });

  it("closes a visible lane when the host sends an empty terminal snapshot", () => {
    const live = [entry({ role: "thinking", itemId: "r-empty", text: "last visible step", open: true, itemRevision: 2 })];
    const closed = applyItemSnapshotUpdate(live, {
      itemId: "r-empty",
      role: "thinking",
      text: "",
      revision: 3,
      open: false,
      stamp,
    });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].text, "last visible step");
    assert.equal(closed[0].open, false);
    assert.equal(closed[0].itemRevision, 3);
  });

  it("ignores an empty snapshot for an unknown item", () => {
    const log = [entry({ role: "assistant", text: "kept" })];
    assert.equal(applyItemSnapshotUpdate(log, {
      itemId: "missing",
      role: "thinking",
      text: "",
      open: false,
      stamp,
    }), log);
  });

  it("keeps a user-shell command paired with replaced output", () => {
    const next = applyItemSnapshotUpdate([], {
      itemId: "shell-1",
      role: "tool",
      commandText: "git status",
      text: "clean",
      revision: 1,
      stamp,
    });
    assert.equal(next[0].text, "$ git status\nclean");
  });

  it("promotes the empty post-approval placeholder instead of duplicating it", () => {
    const placeholder = [entry({ role: "assistant", text: "", open: true })];
    const next = applyItemSnapshotUpdate(placeholder, {
      itemId: "answer-1",
      role: "assistant",
      text: "Resumed.",
      revision: 1,
      stamp,
    });
    assert.equal(next.length, 1);
    assert.equal(next[0].itemId, "answer-1");
    assert.equal(next[0].text, "Resumed.");
  });
});

describe("dropEmptyPlaceholders", () => {
  it("removes only still-empty open entries", () => {
    const log = [
      entry({ role: "user", text: "hi" }),
      entry({ role: "assistant", text: "", open: true }),
      entry({ role: "assistant", text: "kept", open: true }),
      entry({ role: "assistant", text: "", open: false }),
      entry({ role: "thinking", text: "", open: true }),
      entry({ role: "tool", text: "", open: true }),
    ];
    const next = dropEmptyPlaceholders(log);
    assert.deepEqual(
      next.map((e) => e.text),
      ["hi", "kept", ""],
    );
  });

  it("returns the input unchanged when there is nothing to drop", () => {
    const log = [entry({ role: "assistant", text: "kept", open: true })];
    assert.equal(dropEmptyPlaceholders(log), log);
  });
});

describe("REFLEXIVE_LABEL", () => {
  it("is a short non-empty label", () => {
    assert.ok(REFLEXIVE_LABEL.length > 0 && REFLEXIVE_LABEL.length <= 24);
  });
});
