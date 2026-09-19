/**
 * w-collab (US-27 + US-28 + US-34): sharing bundles + channel stub + config
 * import. Pure logic lives in ../src/lib/sharing.ts and
 * ../src/lib/importConfig.ts (zero imports); this file only checks the
 * contract through them, including the localStorage round-trips.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function fakeStorage(): void {
  const m = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

import {
  describeChannel,
  emptyShareState,
  listSessionBundles,
  loadShareState,
  resolveBundle,
  revokeBundle,
  saveShareState,
  setShareMode,
  shareThread,
  shouldAutoShare,
  MAX_SHARE_ENTRIES,
  MAX_SHARE_ENTRY_CHARS,
  type ShareState,
} from "../src/lib/sharing.ts";
import {
  dismissImportedSession,
  isKnownConfigPath,
  loadImportedSessions,
  mergeImportedSessions,
  parseImportPayload,
  saveImportedSessions,
} from "../src/lib/importConfig.ts";

const LOG = [
  { role: "user", text: "hello", ts: 1 },
  { role: "assistant", text: "hi there", ts: 2 },
];

describe("sharing modes (US-27)", () => {
  it("defaults to manual, which never auto-shares", () => {
    const s = emptyShareState();
    assert.equal(s.mode, "manual");
    assert.equal(shouldAutoShare(s), false);
  });

  it("auto mode allows auto-share, disabled refuses share calls", () => {
    const auto = setShareMode(emptyShareState(), "auto");
    assert.equal(shouldAutoShare(auto), true);
    const shared = shareThread(auto, "s1", "T", LOG, "markdown", { now: 7, rand: () => 0.5 });
    assert.ok(shared !== null);

    const off = setShareMode(emptyShareState(), "disabled");
    assert.equal(shouldAutoShare(off), false);
    assert.equal(shareThread(off, "s1", "T", LOG, "markdown"), null);
  });

  it("refuses to share an empty log", () => {
    assert.equal(shareThread(emptyShareState(), "s1", "T", [], "markdown"), null);
  });
});

describe("share bundles (US-27)", () => {
  it("builds markdown and json bodies", () => {
    const md = shareThread(emptyShareState(), "sess-1", "My thread", LOG, "markdown", {
      now: 7,
      rand: () => 0.1,
    });
    assert.ok(md !== null);
    assert.match(md.bundle.body, /# My thread/);
    assert.match(md.bundle.body, /## user/);
    assert.ok(md.bundle.bundleId.startsWith("share-"));

    const js = shareThread(emptyShareState(), "sess-1", "My thread", LOG, "json", {
      now: 7,
      rand: () => 0.2,
    });
    assert.ok(js !== null);
    const parsed = JSON.parse(js.bundle.body) as { entries: unknown[] };
    assert.equal(parsed.entries.length, 2);
  });

  it("un-share revokes: resolve returns null (local 404)", () => {
    const one: ShareState = emptyShareState();
    const shared = shareThread(one, "s1", "T", LOG, "markdown", { now: 1, rand: () => 0.3 });
    assert.ok(shared !== null);
    assert.equal(resolveBundle(shared.state, shared.bundle.bundleId)?.bundleId, shared.bundle.bundleId);
    const revoked = revokeBundle(shared.state, shared.bundle.bundleId);
    assert.equal(resolveBundle(revoked, shared.bundle.bundleId), null);
    assert.equal(listSessionBundles(revoked, "s1").length, 0);
    // unknown ids: revoke is a no-op, resolve is null
    assert.equal(revokeBundle(revoked, "share-nope"), revoked);
    assert.equal(resolveBundle(revoked, "share-nope"), null);
  });

  it("persists mode + bundles under muse-desktop.* keys", () => {
    fakeStorage();
    const shared = shareThread(setShareMode(emptyShareState(), "auto"), "s1", "T", LOG, "json", {
      now: 3,
      rand: () => 0.4,
    });
    assert.ok(shared !== null);
    saveShareState(shared.state);
    const raw = (globalThis as Record<string, Record<string, string>>).localStorage.getItem(
      "muse-desktop.sharing.v1",
    );
    assert.ok(raw !== null);
    const loaded = loadShareState();
    assert.equal(loaded.mode, "auto");
    assert.equal(resolveBundle(loaded, shared.bundle.bundleId)?.format, "json");
  });

  it("redacts credential-shaped values and records export safeguards", () => {
    const shared = shareThread(emptyShareState(), "s1", "T", [
      { role: "user", text: "Authorization: Bearer top-secret-value", ts: 1 },
      { role: "tool", text: "token=abc123", ts: 2 },
      { role: "assistant", text: "sk-live-1234567890abcdef", ts: 3 },
    ], "json", { now: 4, rand: () => 0.5 });
    assert.ok(shared !== null);
    assert.equal(shared.bundle.redacted, true);
    assert.match(shared.bundle.body, /\[redacted\]/);
    assert.doesNotMatch(shared.bundle.body, /top-secret-value/);
    assert.doesNotMatch(shared.bundle.body, /sk-live-1234567890abcdef/);
    const parsed = JSON.parse(shared.bundle.body) as { safeguards: { redacted: boolean } };
    assert.equal(parsed.safeguards.redacted, true);
  });

  it("bounds large snapshots without dropping the newest entry", () => {
    const log = Array.from({ length: MAX_SHARE_ENTRIES + 2 }, (_, i) => ({
      role: "assistant",
      text: `entry-${i}`,
      ts: i,
    }));
    log.push({ role: "assistant", text: "x".repeat(MAX_SHARE_ENTRY_CHARS + 100), ts: 9999 });
    const shared = shareThread(emptyShareState(), "s1", "T", log, "json", {
      now: 8,
      rand: () => 0.6,
    });
    assert.ok(shared !== null);
    assert.equal(shared.bundle.truncated, true);
    assert.ok((shared.bundle.omittedEntries ?? 0) >= 2);
    const parsed = JSON.parse(shared.bundle.body) as {
      safeguards: { truncated: boolean };
      entries: Array<{ text: string }>;
    };
    assert.equal(parsed.safeguards.truncated, true);
    assert.match(parsed.entries.at(-1)?.text ?? "", /entry truncated/);
  });
});

describe("channel stub (US-28)", () => {
  it("is disabled by default and never connected when enabled", () => {
    const off = describeChannel(false);
    assert.equal(off.connected, false);
    assert.equal(off.status, "disabled");
    const on = describeChannel(true);
    assert.equal(on.enabled, true);
    assert.equal(on.connected, false);
    assert.equal(on.status, "not connected");
  });
});

describe("config import (US-34)", () => {
  it("knows the documented config paths", () => {
    assert.equal(isKnownConfigPath("~/.muse/config.json"), true);
    assert.equal(isKnownConfigPath("~/.codex/sessions/rollout-1.jsonl"), true);
    assert.equal(isKnownConfigPath("~/.config/zed/settings.json"), true);
    assert.equal(isKnownConfigPath("/tmp/random.txt"), false);
    assert.equal(isKnownConfigPath(""), false);
  });

  it("parses JSON payloads into resumable sessions, never throws", () => {
    const sum = parseImportPayload(
      "~/.muse/config.json",
      JSON.stringify({ sessions: [{ session_id: "abc123", title: "Old work", workspace: "/tmp/w" }] }),
    );
    assert.equal(sum.sessions.length, 1);
    assert.equal(sum.sessions[0].id, "abc123");
    assert.equal(sum.sessions[0].workspace, "/tmp/w");

    const bad = parseImportPayload("x", "not json at all {{{");
    assert.equal(bad.sessions.length, 0);
    assert.ok(bad.notes.length > 0);

    const empty = parseImportPayload("x", "   ");
    assert.equal(empty.sessions.length, 0);
  });

  it("merge never overwrites: existing + live ids win", () => {
    const cur = [{ id: "a", title: "Local", source: "local" }];
    const incoming = [
      { id: "a", title: "Imported-A", source: "cli" },
      { id: "b", title: "Imported-B", source: "cli" },
      { id: "live-1", title: "Imported-L", source: "cli" },
    ];
    const merged = mergeImportedSessions(cur, incoming, ["live-1"]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].title, "Local");
    assert.equal(merged[1].id, "b");
    const after = dismissImportedSession(merged, "b");
    assert.equal(after.length, 1);
    assert.equal(dismissImportedSession(after, "nope"), after);
  });

  it("persists imported sessions under muse-desktop.import.v1", () => {
    fakeStorage();
    saveImportedSessions([{ id: "z1", title: "Z", source: "cli" }]);
    assert.equal(loadImportedSessions().length, 1);
  });
});
