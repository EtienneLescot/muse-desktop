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

  it("supports truecolor, italic, inverse and strike styles", () => {
    assert.deepEqual(parseAnsi("\x1b[3;7;9;38;2;12;34;56;48;2;200;210;220mrich\x1b[0mplain"), [
      {
        text: "rich",
        style: {
          color: "rgb(12, 34, 56)",
          backgroundColor: "rgb(200, 210, 220)",
          fontStyle: "italic",
          textDecoration: "line-through",
          filter: "invert(1)",
        },
      },
      { text: "plain", style: {} },
    ]);
  });

  it("turns off underline independently from strike-through", () => {
    assert.deepEqual(parseAnsi("\x1b[4;9munderstrike\x1b[24mstrike\x1b[29mplain"), [
      { text: "understrike", style: { textDecoration: "underline line-through" } },
      { text: "strike", style: { textDecoration: "line-through" } },
      { text: "plain", style: {} },
    ]);
  });
});
