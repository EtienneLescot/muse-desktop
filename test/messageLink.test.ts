import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLink } from "../src/lib/messageLink.ts";

const ws = "C:\\repos\\app";

test("web links go to the browser", () => {
  assert.deepEqual(classifyLink("https://example.com/a?b#c", ws), { kind: "web", url: "https://example.com/a?b#c" });
  assert.deepEqual(classifyLink("mailto:a@b.c", ws), { kind: "web", url: "mailto:a@b.c" });
});

test("files the agent names open relative to the conversation's folder", () => {
  assert.deepEqual(classifyLink("review-2.0.0-2.1.0.md", ws), { kind: "file", path: "review-2.0.0-2.1.0.md" });
  assert.deepEqual(classifyLink("./src/a%20b.ts:12:3", ws), { kind: "file", path: "src/a b.ts" });
  assert.deepEqual(classifyLink("src/a.ts#L4", ws), { kind: "file", path: "src/a.ts" });
  assert.deepEqual(classifyLink("C:\\repos\\app\\docs\\x.md", ws), { kind: "file", path: "docs/x.md" });
  assert.deepEqual(classifyLink("file:///C:/repos/app/docs/x.md", ws), { kind: "file", path: "docs/x.md" });
});

test("anything outside the folder or of another scheme is not followed", () => {
  assert.deepEqual(classifyLink("C:\\other\\x.md", ws), { kind: "none" });
  assert.deepEqual(classifyLink("../secret.md", ws), { kind: "none" });
  assert.deepEqual(classifyLink("javascript:alert(1)", ws), { kind: "none" });
  assert.deepEqual(classifyLink("x.md", null), { kind: "file", path: "x.md" });
  assert.deepEqual(classifyLink("/etc/passwd", null), { kind: "none" });
});
