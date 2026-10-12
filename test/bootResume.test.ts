import assert from "node:assert/strict";
import test from "node:test";
import { connectedRestoredIds, selectResumeOnOpen } from "../src/lib/bootResume.ts";
import { MSP_ERROR_SESSION_NOT_LOADED, mspErrorCode } from "../src/lib/msp.ts";
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

test("a restored conversation the host has not loaded is not connected, and gets resumed when opened", () => {
  // M0-06: after a window reload, 7 listed but unloaded conversations were
  // marked connected and each refused setApprovalMode with -32024.
  const restored = [
    { session_id: "loaded", loaded: true },
    { session_id: "listed", loaded: false },
    { session_id: "older-host" },
  ];
  const connected = connectedRestoredIds(restored);
  assert.deepEqual(connected, ["loaded", "older-host"]);
  const stored = restored.map(({ session_id }) => row({ session_id }));
  const open = (activeId: string) =>
    selectResumeOnOpen({ stored, restoredIds: connected, tombstonedIds: [], activeId });
  assert.equal(open("listed"), "listed");
  assert.equal(open("loaded"), null);
  // A posture refusal that slips through reads as "not loaded", not as a failure.
  assert.equal(
    mspErrorCode("MSP error -32024: session s is not loaded on this host [sessionNotLoaded] [retryable=false]"),
    MSP_ERROR_SESSION_NOT_LOADED,
  );
});

test("selectResumeOnOpen returns null without an open conversation", () => {
  const stored = [row({ session_id: "a" })];
  assert.equal(selectResumeOnOpen({ stored, restoredIds: [], tombstonedIds: null, activeId: null }), null);
  assert.equal(selectResumeOnOpen({ stored, restoredIds: [], tombstonedIds: undefined, activeId: "missing" }), null);
});
