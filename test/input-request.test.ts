/**
 * Regression test: suspended input prompts are answerable (no more stuck
 * "[input_requested]" turns). Covers the pure pieces: payload parsing and
 * wire-answer building. The live round-trip needs a running sidecar.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnswers,
  parseInputRequest,
  type InputQuestion,
} from "../src/lib/input.ts";

const SINGLE: InputQuestion = {
  id: "q1",
  header: "Format",
  question: "Which format?",
  mode: "single",
  options: [
    { label: "Short", description: "under 100 words" },
    { label: "Long", description: "" },
  ],
};

const MULTI: InputQuestion = {
  id: "q2",
  header: "Topics",
  question: "Pick topics",
  mode: "multiple",
  minSelections: 1,
  maxSelections: 2,
  options: [
    { label: "A", description: "" },
    { label: "B", description: "" },
  ],
};

function wirePayload(): string {
  return JSON.stringify({
    request_id: "ui-7",
    inputId: "ui-7",
    toolName: "ask",
    itemId: "item-9",
    questions: [
      {
        id: "q1",
        header: "Format",
        question: "Which format?",
        mode: "single",
        options: [{ label: "Short", description: "under 100 words" }, { label: "Long" }],
      },
      {
        id: "q2",
        header: "Topics",
        question: "Pick topics",
        mode: "multiple",
        minSelections: 1,
        maxSelections: 2,
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
  });
}

describe("parseInputRequest", () => {
  it("parses ids, modes, options", () => {
    const req = parseInputRequest("sess-1", wirePayload());
    assert.ok(req !== null);
    assert.equal(req.session_id, "sess-1");
    assert.equal(req.input_id, "ui-7");
    assert.equal(req.questions.length, 2);
    assert.equal(req.questions[0].mode, "single");
    assert.equal(req.questions[0].options[0].description, "under 100 words");
    assert.equal(req.questions[1].maxSelections, 2);
  });

  it("returns null on garbage, missing id, or no questions", () => {
    assert.equal(parseInputRequest("s", "not json"), null);
    assert.equal(parseInputRequest("s", JSON.stringify({ questions: [] })), null);
    assert.equal(
      parseInputRequest("s", JSON.stringify({ inputId: "x", questions: [{ id: "", mode: "single" }] })),
      null,
    );
  });

  it("drops unknown modes and labelless options", () => {
    const req = parseInputRequest(
      "s",
      JSON.stringify({
        inputId: "x",
        questions: [
          { id: "bad", mode: "ranked", options: [] },
          { id: "ok", mode: "single", options: [{ label: "" }, { label: "Yes" }] },
        ],
      }),
    );
    assert.ok(req !== null);
    assert.equal(req.questions.length, 1);
    assert.equal(req.questions[0].id, "ok");
    assert.deepEqual(
      req.questions[0].options.map((o) => o.label),
      ["Yes"],
    );
  });
});

describe("buildAnswers", () => {
  it("single takes the first valid label", () => {
    const out = buildAnswers([SINGLE], { q1: { labels: ["Long", "Short"], text: "" } });
    assert.deepEqual(out, [{ questionId: "q1", selectedLabel: "Long" }]);
  });

  it("multiple takes all valid labels", () => {
    const out = buildAnswers([MULTI], { q2: { labels: ["A", "B", "Z"], text: "" } });
    assert.deepEqual(out, [{ questionId: "q2", selectedLabels: ["A", "B"] }]);
  });

  it("falls back to capped free text", () => {
    const out = buildAnswers([SINGLE], { q1: { labels: [], text: "  custom answer  " } });
    assert.deepEqual(out, [{ questionId: "q1", freeText: "custom answer" }]);
    const long = buildAnswers([SINGLE], { q1: { labels: [], text: "x".repeat(600) } });
    assert.equal((long[0].freeText as string).length, 500);
  });

  it("throws when a question has no answer", () => {
    assert.throws(() => buildAnswers([SINGLE], {}), /needs an answer/);
  });
});
