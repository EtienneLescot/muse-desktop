import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { terminalControlSequence } from "../src/lib/terminalShortcuts.ts";

describe("terminal keyboard controls", () => {
  it("maps interrupt, EOF and clear-screen controls", () => {
    assert.equal(terminalControlSequence("c", { ctrlKey: true }), "\x03");
    assert.equal(terminalControlSequence("D", { ctrlKey: true }), "\x04");
    assert.equal(terminalControlSequence("l", { ctrlKey: true }), "\x0c");
  });

  it("maps completion and escape controls", () => {
    assert.equal(terminalControlSequence("Tab"), "\t");
    assert.equal(terminalControlSequence("Escape"), "\x1b");
  });

  it("does not steal unrelated or browser-reserved shortcuts", () => {
    assert.equal(terminalControlSequence("x", { ctrlKey: true }), null);
    assert.equal(terminalControlSequence("c", { ctrlKey: true, altKey: true }), null);
    assert.equal(terminalControlSequence("v", { ctrlKey: true, metaKey: true }), null);
  });
});
