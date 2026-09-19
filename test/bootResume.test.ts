import assert from "node:assert/strict";
import test from "node:test";
import { selectBootResumeCandidates } from "../src/lib/bootResume.ts";
import type { StoredSession } from "../src/lib/persist.ts";

function row(overrides: Partial<StoredSession> & { session_id: string }): StoredSession {
  return {
    workspace: "C:\\repo",
    title: overrides.session_id,
    createdAt: 1,
    ...overrides,
  };
}

test("selectBootResumeCandidates puts the active session first", () => {
  const got = selectBootResumeCandidates({
    stored: [row({ session_id: "a" }), row({ session_id: "b" }), row({ session_id: "c" })],
    restoredIds: [],
    tombstonedIds: [],
    activeId: "c",
  });
  assert.deepEqual(got, ["c", "a", "b"]);
});

test("selectBootResumeCandidates skips admitted, deleted, archived, ephemeral, and workspace-less rows", () => {
  const got = selectBootResumeCandidates({
    stored: [
      row({ session_id: "admitted" }),
      row({ session_id: "deleted" }),
      row({ session_id: "archived", archived: true }),
      row({ session_id: "ephemeral", session_durability: "ephemeral" }),
      row({ session_id: "EphemeralUpper", session_durability: "Ephemeral" }),
      row({ session_id: "noworkspace", workspace: "" }),
      row({ session_id: "keep" }),
    ],
    restoredIds: new Set(["admitted"]),
    tombstonedIds: new Set(["deleted"]),
    activeId: "keep",
  });
  assert.deepEqual(got, ["keep"]);
});

test("selectBootResumeCandidates never resurrects an ineligible active session", () => {
  const got = selectBootResumeCandidates({
    stored: [row({ session_id: "tombstoned-active" }), row({ session_id: "other" })],
    restoredIds: [],
    tombstonedIds: ["tombstoned-active"],
    activeId: "tombstoned-active",
  });
  assert.deepEqual(got, ["other"]);
});

test("selectBootResumeCandidates dedupes repeated ids and tolerates a missing active id", () => {
  const dup = row({ session_id: "dup" });
  const got = selectBootResumeCandidates({
    stored: [dup, { ...dup }],
    restoredIds: [],
    tombstonedIds: null,
    activeId: "missing",
  });
  assert.deepEqual(got, ["dup"]);
});

test("selectBootResumeCandidates returns empty when every stored session was admitted", () => {
  const got = selectBootResumeCandidates({
    stored: [row({ session_id: "a" })],
    restoredIds: ["a"],
    tombstonedIds: undefined,
    activeId: "a",
  });
  assert.deepEqual(got, []);
});
