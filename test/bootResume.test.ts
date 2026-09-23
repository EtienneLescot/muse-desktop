import assert from "node:assert/strict";
import test from "node:test";
import { selectResumeOnOpen } from "../src/lib/bootResume.ts";
import type { StoredSession } from "../src/lib/persist.ts";

function row(overrides: Partial<StoredSession> & { session_id: string }): StoredSession {
  return {
    workspace: "C:\\repo",
    title: overrides.session_id,
    createdAt: 1,
    ...overrides,
  };
}

test("selectResumeOnOpen resumes only the open conversation, never the background rows", () => {
  const stored = Array.from({ length: 40 }, (_, i) => row({ session_id: `s${i}` }));
  assert.equal(
    selectResumeOnOpen({ stored, restoredIds: [], tombstonedIds: [], activeId: "s7" }),
    "s7",
  );
});

test("selectResumeOnOpen skips admitted, deleted, archived, ephemeral, and workspace-less rows", () => {
  const stored = [
    row({ session_id: "admitted" }),
    row({ session_id: "deleted" }),
    row({ session_id: "archived", archived: true }),
    row({ session_id: "ephemeral", session_durability: "ephemeral" }),
    row({ session_id: "EphemeralUpper", session_durability: "Ephemeral" }),
    row({ session_id: "noworkspace", workspace: "" }),
  ];
  for (const { session_id } of stored) {
    const got = selectResumeOnOpen({
      stored,
      restoredIds: new Set(["admitted"]),
      tombstonedIds: new Set(["deleted"]),
      activeId: session_id,
    });
    assert.equal(got, null, session_id);
  }
});

test("selectResumeOnOpen returns null without an open conversation", () => {
  const stored = [row({ session_id: "a" })];
  assert.equal(selectResumeOnOpen({ stored, restoredIds: [], tombstonedIds: null, activeId: null }), null);
  assert.equal(selectResumeOnOpen({ stored, restoredIds: [], tombstonedIds: undefined, activeId: "missing" }), null);
});
