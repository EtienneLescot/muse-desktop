import test from "node:test";
import assert from "node:assert/strict";
import { formatTerminalContext } from "../src/lib/terminalContext.ts";

test("terminal context is labelled, attributed and bounded", () => {
  const result = formatTerminalContext(
    { terminalId: "term-1", cwd: "C:\\repo<&", shell: "cmd\"" },
    "first\nsecond\nthird",
    8,
  );
  assert.match(result, /Terminal output/);
  assert.match(result, /C:\\repo&lt;&amp;/);
  assert.match(result, /cmd&quot;/);
  assert.match(result, /…/);
  assert.ok(result.length < 200);
});

test("empty terminal output keeps explicit context metadata", () => {
  const result = formatTerminalContext(
    { terminalId: "term-2", cwd: "/repo", shell: "/bin/sh" },
    "",
  );
  assert.match(result, /<terminal-output>\n\n<\/terminal-output>/);
});
