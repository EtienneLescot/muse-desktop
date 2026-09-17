import assert from "node:assert/strict";
import test from "node:test";
import { attachmentKey, buildTurnInputParts, isTextAttachment, type ComposerAttachment } from "../src/lib/attachments.ts";

test("attachment detection accepts text MIME and known code extensions", () => {
  assert.equal(isTextAttachment({ name: "notes.txt", type: "" }), true);
  assert.equal(isTextAttachment({ name: "main.ts", type: "application/octet-stream" }), true);
  assert.equal(isTextAttachment({ name: "photo.png", type: "image/png" }), false);
  assert.equal(isTextAttachment({ name: "archive.zip", type: "application/zip" }), false);
});

test("buildTurnInputParts preserves prompt order and labels text attachments", () => {
  const attachments: ComposerAttachment[] = [
    { id: "a", name: "main.ts", mediaType: "text/plain", size: 8, kind: "text", content: "const x = 1;" },
    { id: "b", name: "screen.png", mediaType: "image/png", size: 4, kind: "image", base64Data: "AQID" },
  ];
  assert.deepEqual(buildTurnInputParts("Review this", attachments), [
    { type: "text", text: "Review this" },
    {
      type: "text",
      text: '\n\n<attached-file name="main.ts" media-type="text/plain">\nconst x = 1;\n</attached-file>',
    },
    { type: "image", mediaType: "image/png", base64Data: "AQID" },
  ]);
});

test("buildTurnInputParts supports an attachment-only turn", () => {
  const image: ComposerAttachment = {
    id: "image",
    name: "screen.png",
    mediaType: "image/png",
    size: 4,
    kind: "image",
    base64Data: "AQID",
  };
  assert.deepEqual(buildTurnInputParts("", [image]), [
    { type: "image", mediaType: "image/png", base64Data: "AQID" },
  ]);
});

test("attachment keys are stable for draft preservation", () => {
  const a = { id: "one", name: "a.txt", mediaType: "text/plain", size: 1, kind: "text" as const };
  const b = { id: "two", name: "b.txt", mediaType: "text/plain", size: 1, kind: "text" as const };
  assert.equal(attachmentKey([a, b]), "one|two");
});
