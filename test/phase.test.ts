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
  dropEmptyPlaceholders,
  isItemStartKind,
  isRunningKind,
  isStoppedKind,
  isSubagentItemKind,
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
      "completed",
      "stopped",
      "exited",
      "host_exited",
      "error",
      "turn_end",
      "idle",
      "turn/completed",
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
    assert.equal(phaseForKind("completed"), "stopped");
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
});

describe("dropEmptyPlaceholders", () => {
  it("removes only still-empty open entries", () => {
    const log = [
      entry({ role: "user", text: "hi" }),
      entry({ role: "assistant", text: "", open: true }),
      entry({ role: "assistant", text: "kept", open: true }),
      entry({ role: "assistant", text: "", open: false }),
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
