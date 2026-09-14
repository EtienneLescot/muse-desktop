import { test } from "node:test";
import assert from "node:assert/strict";
import { messageBlocks } from "../src/lib/messageBlocks.ts";
test("preserves text around fenced code and its language", () => {
  assert.deepEqual(messageBlocks("Bonjour\n```tsx\n<div/>\n```\nFin"), [
    { kind: "text", text: "Bonjour" },
    { kind: "code", text: "<div/>", language: "tsx" },
    { kind: "text", text: "Fin" },
  ]);
});
test("renders unfinished streamed fences as code without losing content", () => {
  assert.deepEqual(messageBlocks("```js\nconst x ="), [
    { kind: "code", language: "js", text: "const x =" },
  ]);
});
test("keeps HTML as literal text and inline backticks intact", () => {
  assert.deepEqual(messageBlocks('<img onerror="alert(1)"> et `code`'), [
    { kind: "text", text: '<img onerror="alert(1)"> et `code`' },
  ]);
});
