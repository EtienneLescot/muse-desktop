/**
 * US-6 sub-agent controls: pure payload parsing/formatting.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDrilldown,
  formatSubagentResult,
  isTerminalSubagentStatus,
  parseSubagentPayload,
  subagentStatusLabel,
  subagentSummary,
} from "../src/lib/subagent.ts";

describe("parseSubagentPayload", () => {
  it("parses JSON agent_id + text with drill-down identity", () => {
    const p = parseSubagentPayload(
      JSON.stringify({
        agent_id: "item-9",
        text: "hello",
        childSessionId: "child-42",
        objective: "explore",
        role: "explorer",
        depth: 1,
      }),
    );
    assert.equal(p.agentId, "item-9");
    assert.equal(p.text, "hello");
    assert.equal(p.childSessionId, "child-42");
    assert.equal(p.objective, "explore");
    assert.equal(p.role, "explorer");
    assert.equal(p.depth, 1);
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
