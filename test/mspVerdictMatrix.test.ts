/**
 * Pure helpers of `scripts/msp-verdict-matrix.mjs`: the path scrubber that
 * keeps the evidence report path-free, and the cell classification the M0-06
 * comparison relies on. Importing the script spawns nothing (its entry point
 * only runs when it is executed directly).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOutcome, sandboxBlocked, scrub } from "../scripts/msp-verdict-matrix.mjs";

describe("verdict matrix path scrubbing", () => {
  const places: [string, string][] = [
    ["C:\\Users\\me\\AppData\\Local\\Temp", "<temp>"],
    ["C:\\Users\\me\\AppData\\Local\\Temp\\muse-matrix-root-1", "<root>"],
  ];

  it("labels the most specific place first, in any case and slash style", () => {
    assert.equal(
      scrub("wrote c:\\users\\me\\appdata\\local\\temp\\muse-matrix-root-1\\a.txt", places),
      "wrote <root>\\a.txt",
    );
    assert.equal(scrub("C:/Users/me/AppData/Local/Temp/x.txt", places), "<temp>/x.txt");
  });

  it("replaces any leftover drive path but keeps URLs", () => {
    assert.equal(scrub("D:\\elsewhere\\file.txt and https://example.com", places), "<path> and https://example.com");
  });

  it("drops non-strings", () => {
    assert.equal(scrub(undefined, places), undefined);
  });
});

describe("verdict matrix cell classification", () => {
  const call = (status: string, output = "") => ({ status, output });

  it("trusts an observed side effect over anything the host reports", () => {
    assert.equal(classifyOutcome({ sideEffect: true, toolCalls: [call("failed")], decisions: ["abort"], timedOut: true }), "completed");
  });

  it("separates a turn that never called the tool from one that hung", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: [], timedOut: false }), "noTool");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: [], timedOut: true }), "hung");
  });

  it("reports an aborted approval or a refusing status as denied", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [], decisions: ["abort"], timedOut: false }), "denied");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("failed")], decisions: ["allow_once", "abort"], timedOut: false }), "denied");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("denied")], decisions: [], timedOut: false }), "denied");
  });

  it("reports a failed status or an error in the output as failed", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("failed")], decisions: [], timedOut: false }), "failed");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("completed", "Access is denied")], decisions: [], timedOut: false }), "failed");
  });

  it("flags a clean run whose effect is missing, and a running call at timeout as hung", () => {
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("completed")], decisions: [], timedOut: false }), "noEffect");
    assert.equal(classifyOutcome({ sideEffect: false, toolCalls: [call("inProgress")], decisions: [], timedOut: true }), "hung");
  });
});

describe("verdict matrix sandbox fallback", () => {
  it("fires only when every allowed cell hung or failed, ignoring the refusal", () => {
    const refused = { decision: "abort", outcome: "denied" };
    assert.equal(sandboxBlocked([{ decision: "allow_once", outcome: "failed" }, { decision: "none", outcome: "hung" }, refused]), true);
    assert.equal(sandboxBlocked([{ decision: "none", outcome: "completed" }, { decision: "none", outcome: "hung" }]), false);
    assert.equal(sandboxBlocked([refused]), false);
  });
});
