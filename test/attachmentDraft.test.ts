import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATTACHMENT_DRAFT_PAYLOAD_CHARS,
  loadAttachmentDraft,
  parseAttachmentDraft,
  saveAttachmentDraft,
  serializeAttachmentDraft,
} from "../src/lib/attachmentDraft.ts";
import type { ComposerAttachment } from "../src/lib/attachments.ts";

function installSessionStorage(): { values: Map<string, string>; restore: () => void } {
  const values = new Map<string, string>();
  const previous = (globalThis as Record<string, unknown>).sessionStorage;
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  (globalThis as Record<string, unknown>).sessionStorage = store;
  return {
    values,
    restore: () => { (globalThis as Record<string, unknown>).sessionStorage = previous; },
  };
}

test("attachment drafts preserve reusable text and image payloads", () => {
  const text: ComposerAttachment = {
    id: "text", name: "notes.md", mediaType: "text/markdown", size: 5,
    kind: "text", content: "hello",
  };
  const image: ComposerAttachment = {
    id: "image", name: "screen.png", mediaType: "image/png", size: 4,
    kind: "image", base64Data: "AQID", width: 2, height: 2,
  };
  const serialized = serializeAttachmentDraft([text, image]);
  assert.equal(serialized.truncated, false);
  const parsed = parseAttachmentDraft(serialized.raw);
  assert.deepEqual(parsed.attachments, [text, image]);
  assert.equal(parsed.truncated, false);
});

test("oversized payloads keep metadata and mark the row missing", () => {
  const image: ComposerAttachment = {
    id: "large", name: "large.png", mediaType: "image/png", size: 9,
    kind: "image", base64Data: "x".repeat(MAX_ATTACHMENT_DRAFT_PAYLOAD_CHARS + 1),
  };
  const serialized = serializeAttachmentDraft([image]);
  assert.equal(serialized.truncated, true);
  const parsed = parseAttachmentDraft(serialized.raw);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.attachments[0]?.name, "large.png");
  assert.equal(parsed.attachments[0]?.missing, true);
  assert.equal(parsed.attachments[0]?.base64Data, undefined);
});

test("session attachment drafts round-trip and clear after send", () => {
  const env = installSessionStorage();
  try {
    const attachment: ComposerAttachment = {
      id: "a", name: "a.txt", mediaType: "text/plain", size: 1,
      kind: "text", content: "a",
    };
    assert.equal(saveAttachmentDraft("session/1", [attachment]), true);
    assert.deepEqual(loadAttachmentDraft("session/1").attachments, [attachment]);
    assert.equal(saveAttachmentDraft("session/1", []), true);
    assert.deepEqual(loadAttachmentDraft("session/1"), { attachments: [], truncated: false });
    assert.equal(env.values.size, 0);
  } finally {
    env.restore();
  }
});
