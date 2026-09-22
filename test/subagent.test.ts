/**
 * US-6 sub-agent controls: pure payload parsing/formatting.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  childSessionLabel,
  formatDrilldown,
  formatSubagentResult,
  isTerminalSubagentStatus,
  parseSubagentPayload,
  subagentControlAvailability,
  subagentStatusLabel,
  subagentSummary,
} from "../src/lib/subagent.ts";

describe("parseSubagentPayload", () => {
  it("parses JSON agent_id + text with drill-down identity", () => {
    const p = parseSubagentPayload(
      JSON.stringify({
        agent_id: "item-9",
        itemId: "item-9",
        text: "hello",
        childSessionId: "child-42",
        objective: "explore",
        role: "explorer",
        depth: 1,
      }),
    );
    assert.equal(p.agentId, "item-9");
    assert.equal(p.itemId, "item-9");
    assert.equal(p.text, "hello");
    assert.equal(p.childSessionId, "child-42");
    assert.equal(p.objective, "explore");
    assert.equal(p.role, "explorer");
    assert.equal(p.depth, 1);
  });

  it("carries the host item kind so internal children stay identifiable", () => {
    const p = parseSubagentPayload(
      JSON.stringify({
        agent_id: "item-7",
        itemId: "item-7",
        text: "",
        itemKind: "reminderChild",
        objective: "Reminder child session",
      }),
    );
    assert.equal(p.itemKind, "reminderChild");
    assert.equal(p.objective, "Reminder child session");
  });

  it("accepts a snake_case item_kind", () => {
    const p = parseSubagentPayload(
      JSON.stringify({ agent_id: "item-8", item_kind: "reminderchild" }),
    );
    assert.equal(p.itemKind, "reminderchild");
  });

  it("keeps the AC fallbacks: /*id*/, id: prefix, plain text", () => {
    assert.deepEqual(parseSubagentPayload("/*worker*/ doing things"), {
      agentId: "worker",
      text: "doing things",
    });
    assert.deepEqual(parseSubagentPayload("agent-2: more work"), {
      agentId: "agent-2",
      text: "more work",
    });
    assert.deepEqual(parseSubagentPayload("just text"), {
      agentId: "agent",
      text: "just text",
    });
  });

  it("never throws on malformed JSON, keeps identity when present", () => {
    const p = parseSubagentPayload("{not json");
    assert.equal(p.agentId, "agent");
    assert.equal(p.text, "{not json");
  });

  it("accepts snake_case child session keys", () => {
    const p = parseSubagentPayload(
      JSON.stringify({ agent_id: "a", text: "t", child_session_id: "c-1" }),
    );
    assert.equal(p.childSessionId, "c-1");
  });

  it("normalizes host lifecycle aliases and does not dump status-only payloads", () => {
    const running = parseSubagentPayload(
      JSON.stringify({ agent_id: "a", status: "in-progress" }),
    );
    assert.equal(running.status, "running");
    assert.equal(running.text, "");

    const completed = parseSubagentPayload(
      JSON.stringify({ agent_id: "a", state: "done" }),
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.text, "");
    assert.equal(isTerminalSubagentStatus(completed.status), true);
  });

  it("preserves replacement and revision metadata for full item snapshots", () => {
    const p = parseSubagentPayload(
      JSON.stringify({ agent_id: "a", item_id: "item-2", text: "snapshot", replace: true, revision: 3 }),
    );
    assert.equal(p.itemId, "item-2");
    assert.equal(p.replace, true);
    assert.equal(p.revision, 3);
  });

  it("keeps unknown host statuses visible without treating them as terminal", () => {
    const p = parseSubagentPayload(JSON.stringify({ agent_id: "a", phase: "waiting_for_host" }));
    assert.equal(p.status, "unknown");
    assert.equal(isTerminalSubagentStatus(p.status), false);
    assert.equal(subagentStatusLabel(p.status), "Awaiting host status");
  });
});

describe("subagentSummary", () => {
  it("prefers objective with role/depth attrs", () => {
    assert.equal(
      subagentSummary({ objective: "explore", subagentRole: "explorer", depth: 1, text: "x" }),
      "explore (explorer, depth 1)",
    );
  });

  it("falls back to the first text line", () => {
    assert.equal(subagentSummary({ text: "line one\nline two" }), "line one");
  });
});

describe("formatSubagentResult", () => {
  it("joins summary + text of a result object", () => {
    const out = formatSubagentResult({ summary: "done", text: "details here" });
    assert.match(out, /done/);
    assert.match(out, /details here/);
  });

  it("passes strings through", () => {
    assert.equal(formatSubagentResult("plain result"), "plain result");
  });
});

describe("formatDrilldown", () => {
  it("counts transcript events instead of dumping everything", () => {
    const out = formatDrilldown({ events: [{ a: 1 }, { b: 2 }] });
    assert.match(out, /2 event\(s\)/);
  });

  it("falls back to the result formatter without events", () => {
    assert.equal(formatDrilldown("oops"), "oops");
  });
});

describe("subagent controls", () => {
  it("stops offering what a finished agent cannot do", () => {
    // The reported defect: a Completed agent still offered Interrupt and Stop,
    // and every click failed. A disabled control now carries the sentence.
    const done = subagentControlAvailability("completed");
    assert.equal(done.interrupt.enabled, false);
    assert.equal(done.stop.enabled, false);
    assert.match(done.interrupt.reason ?? "", /finished/);
    // Reading a result and asking a follow-up stay available: we have no
    // evidence they are refused, and guessing would be its own defect.
    assert.equal(done.readResult.enabled, true);
    assert.equal(done.followup.enabled, true);
  });

  it("resumes only what is resumable", () => {
    assert.equal(subagentControlAvailability("running").resume.enabled, false);
    assert.match(subagentControlAvailability("running").resume.reason ?? "", /interrupted, stopped or paused/);
    for (const status of ["interrupted", "stopped", "paused"]) {
      assert.equal(subagentControlAvailability(status).resume.enabled, true, status);
    }
  });

  it("disables everything while a request is in flight", () => {
    // `hasChildSession` so the busy reason is the one under test, not the
    // missing-child one.
    const busy = subagentControlAvailability("running", { busy: true, hasChildSession: true });
    for (const control of Object.values(busy)) {
      assert.equal(control.enabled, false);
      assert.match(control.reason ?? "", /already in flight/);
    }
  });

  it("requires a child session to offer the drill-down", () => {
    assert.equal(subagentControlAvailability("running").drilldown.enabled, false);
    assert.equal(
      subagentControlAvailability("running", { hasChildSession: true }).drilldown.enabled,
      true,
    );
  });
});

describe("child session label", () => {
  it("prefers a known title and keeps the identifier in the tooltip", () => {
    assert.equal(childSessionLabel("7d2adb74-1fa9-4316", { "7d2adb74-1fa9-4316": "Review pass" }), "Review pass");
  });

  it("shortens an unknown identifier instead of printing it whole", () => {
    const label = childSessionLabel("7d2adb74-1fa9-4316-9fb9-397055ee3809");
    assert.equal(label, "7d2adb74…");
    assert.equal(childSessionLabel("   "), "unknown session");
  });
});
describe("subagent close policy", () => {
  it("does not offer to close an agent that is still working", () => {
    // The gate is our own policy, not a host rule, and the reason says so:
    // `stop` is the verb for a running agent, and it sits next to Close.
    assert.equal(subagentControlAvailability("running").close.enabled, false);
    assert.match(subagentControlAvailability("running").close.reason ?? "", /still working/);
    assert.equal(subagentControlAvailability("completed").close.enabled, true);
  });
});
describe("close and reopen", () => {
  it("offers reopen only for a closed agent", () => {
    // `closed` is one of the host's own control statuses, so this is its
    // vocabulary rather than a state the client invented.
    assert.equal(subagentControlAvailability("closed").reopen.enabled, true);
    assert.equal(subagentControlAvailability("completed").reopen.enabled, false);
    assert.match(subagentControlAvailability("completed").reopen.reason ?? "", /closed agent/);
  });

  it("treats a closed agent as finished for the stop controls", () => {
    const closed = subagentControlAvailability("closed");
    assert.equal(closed.interrupt.enabled, false);
    assert.equal(closed.stop.enabled, false);
    assert.match(closed.interrupt.reason ?? "", /finished/);
  });
});