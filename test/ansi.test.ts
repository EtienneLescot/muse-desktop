import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnsi } from "../src/lib/ansi.ts";

describe("terminal ANSI rendering", () => {
  it("keeps plain output as an accessible text chunk", () => {
    assert.deepEqual(parseAnsi("hello\nworld"), [{ text: "hello\nworld", style: {} }]);
  });

  it("translates common SGR styles and resets them", () => {
    assert.deepEqual(parseAnsi("\x1b[1;31merror\x1b[0mok"), [
      { text: "error", style: { color: "#ef4444", fontWeight: "600" } },
      { text: "ok", style: {} },
    ]);
  });

  it("strips cursor and title control sequences without exposing them", () => {
    assert.deepEqual(parseAnsi("a\x1b[2Kb\x1b]0;title\x07c"), [
      { text: "abc", style: {} },
    ]);
  });

  it("supports indexed 256-color SGR values", () => {
    assert.deepEqual(parseAnsi("\x1b[38;5;196mred\x1b[39m"), [
      { text: "red", style: { color: "rgb(255, 0, 0)" } },
    ]);
  });
});

