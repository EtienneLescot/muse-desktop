import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkspaceFileContext } from "../src/lib/fileContext.ts";

test("workspace file context keeps provenance and clips content", () => {
  const context = formatWorkspaceFileContext({
    path: "src/<main>.ts",
    content: "const answer = 42;",
    size: 18,
    observedAt: Date.parse("2026-09-17T10:00:00.000Z"),
    truncated: false,
  }, 8);
  assert.match(context, /Workspace file/);
  assert.match(context, /src\/&lt;main&gt;\.ts/);
  assert.match(context, /const a…/);
  assert.match(context, /<workspace-file-data>/);
});

test("workspace file context refuses binary and marks a bounded preview", () => {
  assert.equal(formatWorkspaceFileContext({
    path: "image.png",
    content: null,
    size: 4,
    observedAt: 0,
    truncated: false,
  }), "");
  const context = formatWorkspaceFileContext({
    path: "README.md",
    content: "hello",
    size: 5,
    observedAt: 0,
    truncated: true,
  });
  assert.match(context, /\[preview clipped\]/);
});
