import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeRules,
  formatRuleBytes,
  governingRule,
  parseHarnessRules,
  ruleStatusLabel,
  RULE_STATUSES,
  type HarnessRules,
} from "../src/lib/harnessRules.ts";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-agents",
    scope: "project",
    name: "AGENTS.md",
    path: "C:\\work\\AGENTS.md",
    present: true,
    status: "governs",
    bytes: 2048,
    preview: "# Project rules",
    truncated: false,
    detail: "Governs sessions started here.",
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    workspace: "C:\\work",
    files: [row()],
    governing: "project-agents",
    observedAt: 1,
    ...overrides,
  };
}

describe("harness rules", () => {
  it("parses the native payload", () => {
    const rules = parseHarnessRules(payload());
    assert.ok(rules);
    assert.equal(rules.workspace, "C:\\work");
    assert.equal(rules.files.length, 1);
    assert.equal(governingRule(rules)?.name, "AGENTS.md");
  });

  it("refuses a payload it cannot fully trust", () => {
    assert.equal(parseHarnessRules(null), null);
    assert.equal(parseHarnessRules("AGENTS.md"), null);
    assert.equal(parseHarnessRules(payload({ files: "nope" })), null);
    // An unknown status is not repaired into a known one: the row is dropped,
    // because inventing a status would misreport what the host loads.
    assert.equal(parseHarnessRules(payload({ files: [row({ status: "loaded" })] })), null);
    assert.equal(parseHarnessRules(payload({ files: [row({ scope: "global" })] })), null);
    assert.equal(parseHarnessRules(payload({ files: [row({ bytes: "2 KB" })] })), null);
    assert.equal(parseHarnessRules(payload({ observedAt: undefined })), null);
  });

  it("never reports a governing file that is not in the payload", () => {
    const rules = parseHarnessRules(payload({ governing: "project-claude" }));
    assert.ok(rules);
    assert.equal(rules.governing, null, "a dangling id must not become a phantom rule");
    assert.equal(governingRule(rules), null);
  });

  it("keeps the order the backend sent, because it is the precedence order", () => {
    const rules = parseHarnessRules(
      payload({
        files: [
          row({ id: "user-claude", scope: "user", name: "CLAUDE.md", status: "fallback" }),
          row(),
        ],
        governing: "project-agents",
      }),
    );
    assert.ok(rules);
    assert.deepEqual(rules.files.map((file) => file.id), ["user-claude", "project-agents"]);
  });

  it("describes the governing file, and says so honestly when there is none", () => {
    assert.equal(describeRules(null), "Rules have not been read yet.");

    const governed = parseHarnessRules(payload());
    assert.ok(governed);
    assert.equal(describeRules(governed), "AGENTS.md in this folder governs the session (2.0 KB).");

    const personalOnly = parseHarnessRules(
      payload({
        files: [
          row({ id: "user-claude", scope: "user", status: "fallback", present: true }),
          row({ present: false, status: "absent", bytes: 0, preview: "" }),
        ],
        governing: null,
      }),
    );
    assert.ok(personalOnly);
    assert.equal(
      describeRules(personalOnly),
      "No rules file in this folder; 1 personal rule file applies as a fallback.",
    );

    const twoPersonal = parseHarnessRules(
      payload({
        files: [
          row({ id: "user-claude", scope: "user", status: "fallback" }),
          row({ id: "user-codex", scope: "user", status: "fallback" }),
        ],
        governing: null,
      }),
    );
    assert.ok(twoPersonal);
    assert.equal(
      describeRules(twoPersonal),
      "No rules file in this folder; 2 personal rule files apply as a fallback.",
    );

    const nothing = parseHarnessRules(
      payload({
        files: [row({ present: false, status: "absent", bytes: 0, preview: "" })],
        governing: null,
      }),
    );
    assert.ok(nothing);
    assert.equal(
      describeRules(nothing),
      "No rules file in this folder, and none in your personal rules.",
    );
  });

  it("never shows a wire value to the user", () => {
    for (const status of RULE_STATUSES) {
      const label = ruleStatusLabel(status);
      assert.ok(label.length > 0);
      assert.notEqual(label, status);
    }
  });

  it("formats sizes without inventing precision", () => {
    assert.equal(formatRuleBytes(0), "0 B");
    assert.equal(formatRuleBytes(Number.NaN), "0 B");
    assert.equal(formatRuleBytes(512), "512 B");
    assert.equal(formatRuleBytes(23552), "23.0 KB");
  });

  it("survives a round trip through JSON, as the bridge does", () => {
    const rules: HarnessRules = parseHarnessRules(JSON.parse(JSON.stringify(payload())))!;
    assert.deepEqual(rules.files[0], row());
  });
});
