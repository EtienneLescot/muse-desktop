import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consumeStorageIssues,
  exportStorageSnapshot,
  inspectStorageSnapshot,
  importStorageSnapshot,
  migrateLegacyStorage,
  readStorageJson,
  readStorageString,
  readSessionStorageString,
  removeStorageKey,
  removeSessionStorageKey,
  storageDataKind,
  storageSnapshotChecksum,
  subscribeStorageIssues,
  writeStorageJson,
  writeStorageString,
  writeSessionStorageString,
  RECOVERY_RAW_LIMIT,
} from "../src/lib/storage.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, String(value));
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    get length(): number {
      return values.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  return { storage, values };
}

function fakeSessionStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, String(value));
    },
    removeItem(key: string): void {
      values.delete(key);
    },
  };
  (globalThis as Record<string, unknown>).sessionStorage = storage;
  return { storage, values };
}

describe("defensive storage facade", () => {
  beforeEach(() => {
    fakeStorage();
    delete (globalThis as Record<string, unknown>).sessionStorage;
    consumeStorageIssues();
  });

  it("reports corrupt JSON while returning the caller fallback", () => {
    fakeStorage({ "muse-desktop.sessions.v1": "{broken" });
    assert.deepEqual(readStorageJson("muse-desktop.sessions.v1", []), []);
    const [issue] = consumeStorageIssues();
    assert.equal(issue?.kind, "corrupt");
    assert.equal(issue?.key, "muse-desktop.sessions.v1");
  });

  it("reports unavailable and quota failures without throwing", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    assert.equal(readStorageJson("muse-desktop.any.v1", "fallback"), "fallback");
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    const emptySnapshot = JSON.parse(exportStorageSnapshot()) as {
      entries: Record<string, unknown>;
    };
    assert.deepEqual(emptySnapshot.entries, {});
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).localStorage = failing;
    assert.equal(writeStorageJson("muse-desktop.full.v1", { ok: true }), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "quota");

    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("storage blocked", "SecurityError");
      },
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).localStorage = blocked;
    assert.equal(writeStorageJson("muse-desktop.blocked.v1", { ok: true }), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");
  });

  it("rejects undefined serialization and notifies mounted subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeStorageIssues(() => {
      seen.push(...consumeStorageIssues().map((issue) => issue.kind));
    });
    assert.equal(writeStorageJson("muse-desktop.invalid.v1", undefined), false);
    assert.deepEqual(seen, ["corrupt"]);
    unsubscribe();
  });

  it("exports valid and damaged namespaced entries for recovery", () => {
    const { values } = fakeStorage({
      "muse-desktop.sessions.v1": JSON.stringify([{ session_id: "s1" }]),
      "muse-desktop.corrupt.v1": "{broken",
      unrelated: "should not export",
    });
    const snapshot = JSON.parse(exportStorageSnapshot()) as {
      format: string;
      version: number;
      entries: Record<string, unknown>;
      metadata: Record<string, unknown>;
      checksum: string;
    };
    assert.equal(snapshot.format, "muse-desktop-storage");
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.checksum, storageSnapshotChecksum(snapshot.entries, snapshot.metadata));
    assert.deepEqual(snapshot.entries["muse-desktop.sessions.v1"], [{ session_id: "s1" }]);
    assert.deepEqual(snapshot.entries["muse-desktop.corrupt.v1"], {
      raw: "{broken",
      parseError: true,
    });
    assert.equal(snapshot.entries.unrelated, undefined);
    assert.equal(values.get("unrelated"), "should not export");
  });

  it("bounds oversized damaged values while marking them recoverable", () => {
    const oversized = "💥".repeat(RECOVERY_RAW_LIMIT + 25);
    fakeStorage({ "muse-desktop.corrupt.v1": oversized });
    const snapshot = JSON.parse(exportStorageSnapshot()) as {
      entries: Record<string, unknown>;
    };
    const entry = snapshot.entries["muse-desktop.corrupt.v1"] as {
      raw: string;
      parseError: boolean;
      truncated?: boolean;
    };
    assert.equal(entry.parseError, true);
    assert.equal(entry.truncated, true);
    assert.equal(Array.from(entry.raw).length, RECOVERY_RAW_LIMIT);
    assert.equal(entry.raw.endsWith("💥"), true);
  });

  it("removes a key through the same safe facade", () => {
    const { values } = fakeStorage({ "muse-desktop.tmp.v1": "1" });
    assert.equal(removeStorageKey("muse-desktop.tmp.v1"), true);
    assert.equal(values.has("muse-desktop.tmp.v1"), false);
  });

  it("round-trips scalar values without JSON coercion", () => {
    const { values } = fakeStorage({ "muse-desktop.theme.v1": "dark" });
    assert.equal(readStorageString("muse-desktop.theme.v1"), "dark");
    assert.equal(writeStorageString("muse-desktop.theme.v1", "light"), true);
    assert.equal(values.get("muse-desktop.theme.v1"), "light");
  });

  it("keeps session drafts behind the same defensive facade", () => {
    const { values } = fakeSessionStorage({ "muse-desktop.draft.s1": "hello" });
    assert.equal(readSessionStorageString("muse-desktop.draft.s1"), "hello");
    assert.equal(writeSessionStorageString("muse-desktop.draft.s1", "updated"), true);
    assert.equal(values.get("muse-desktop.draft.s1"), "updated");
    assert.equal(removeSessionStorageKey("muse-desktop.draft.s1"), true);
    assert.equal(values.has("muse-desktop.draft.s1"), false);
  });

  it("keeps ephemeral drafts usable in memory when session storage is unavailable", () => {
    assert.equal(readSessionStorageString("muse-desktop.draft.missing", "fallback"), "fallback");
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    (globalThis as Record<string, unknown>).sessionStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    assert.equal(writeSessionStorageString("muse-desktop.draft.full", "draft"), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "quota");
    assert.equal(removeSessionStorageKey("muse-desktop.draft.full"), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");
  });

  it("restores a snapshot without overwriting live data unless confirmed", () => {
    const { values } = fakeStorage({
      "muse-desktop.live.v1": JSON.stringify({ current: true }),
    });
    const snapshot = JSON.stringify({
      format: "muse-desktop-storage",
      version: 1,
      entries: {
        "muse-desktop.live.v1": { current: false },
        "muse-desktop.old.v1": { restored: true },
        "other": "ignored",
      },
    });
    const first = importStorageSnapshot(snapshot);
    assert.equal(first.imported, 1);
    assert.equal(first.skipped, 2);
    assert.deepEqual(JSON.parse(values.get("muse-desktop.live.v1") ?? "{}"), { current: true });
    assert.deepEqual(JSON.parse(values.get("muse-desktop.old.v1") ?? "{}"), { restored: true });
    const second = importStorageSnapshot(snapshot, "muse-desktop.", true);
    assert.equal(second.imported, 2);
    assert.deepEqual(JSON.parse(values.get("muse-desktop.live.v1") ?? "{}"), { current: false });
  });

  it("previews existing keys and restores only explicitly selected entries", () => {
    const { values } = fakeStorage({
      "muse-desktop.live.v1": JSON.stringify({ current: true }),
    });
    const snapshot = JSON.stringify({
      format: "muse-desktop-storage",
      version: 1,
      entries: {
        "muse-desktop.live.v1": { current: false },
        "muse-desktop.new.v1": { restored: true },
        "muse-desktop.corrupt.v1": { raw: "{broken", parseError: true },
        unrelated: "ignored",
      },
    });
    const preview = inspectStorageSnapshot(snapshot);
    assert.deepEqual(preview.entries, [
      { key: "muse-desktop.live.v1", existing: true, parseError: false, kind: "durable" },
      { key: "muse-desktop.new.v1", existing: false, parseError: false, kind: "durable" },
      { key: "muse-desktop.corrupt.v1", existing: false, parseError: true, kind: "durable" },
    ]);
    assert.match(preview.errors.join(" "), /non-namespaced/);

    const result = importStorageSnapshot(
      snapshot,
      "muse-desktop.",
      true,
      ["muse-desktop.new.v1"],
    );
    assert.equal(result.imported, 1);
    assert.equal(values.get("muse-desktop.live.v1"), JSON.stringify({ current: true }));
    assert.deepEqual(JSON.parse(values.get("muse-desktop.new.v1") ?? "{}"), { restored: true });
    assert.equal(values.has("muse-desktop.corrupt.v1"), false);
    assert.equal(result.skipped, 3);
  });

  it("rejects a damaged checksum before preview or restore", () => {
    const { values } = fakeStorage();
    const snapshot = JSON.stringify({
      format: "muse-desktop-storage",
      version: 1,
      entries: { "muse-desktop.sessions.v1": [{ session_id: "s1" }] },
      metadata: { "muse-desktop.sessions.v1": { kind: "durable" } },
      checksum: "fnv1a-00000000",
    });
    const preview = inspectStorageSnapshot(snapshot);
    assert.deepEqual(preview.entries, []);
    assert.match(preview.errors.join(" "), /checksum mismatch/);
    const imported = importStorageSnapshot(snapshot, "muse-desktop.", true);
    assert.equal(imported.imported, 0);
    assert.match(imported.errors.join(" "), /checksum mismatch/);
    assert.equal(values.size, 0);
  });

  it("accepts legacy recovery snapshots without a checksum", () => {
    const { values } = fakeStorage();
    const snapshot = JSON.stringify({
      format: "muse-desktop-storage",
      version: 1,
      entries: { "muse-desktop.sessions.v1": [{ session_id: "legacy" }] },
    });
    const imported = importStorageSnapshot(snapshot, "muse-desktop.", true);
    assert.equal(imported.imported, 1);
    assert.deepEqual(JSON.parse(values.get("muse-desktop.sessions.v1") ?? "[]"), [
      { session_id: "legacy" },
    ]);
  });

  it("classifies UI state so recovery does not resurrect stale pointers", () => {
    assert.equal(storageDataKind("muse-desktop.sessions.v1"), "durable");
    assert.equal(storageDataKind("muse-desktop.log.v1.session-1"), "durable");
    assert.equal(storageDataKind("muse-desktop.active.v1"), "ui");
    assert.equal(storageDataKind("muse-desktop.draft.session-1"), "ui");
    assert.equal(storageDataKind("muse-desktop.scheduler-lease.v1"), "ui");
  });

  it("reads kind metadata from exported snapshots and falls back for old files", () => {
    const { values } = fakeStorage({
      "muse-desktop.sessions.v1": JSON.stringify([{ session_id: "s1" }]),
      "muse-desktop.active.v1": JSON.stringify("s1"),
    });
    const snapshot = JSON.stringify({
      format: "muse-desktop-storage",
      version: 1,
      metadata: {
        "muse-desktop.custom.v1": { kind: "ui" },
      },
      entries: {
        "muse-desktop.custom.v1": { value: true },
        "muse-desktop.theme.v1": "dark",
      },
    });
    const preview = inspectStorageSnapshot(snapshot);
    assert.equal(preview.entries[0]?.kind, "ui");
    assert.equal(preview.entries[1]?.kind, "ui");
    const exported = JSON.parse(exportStorageSnapshot());
    assert.equal(exported.metadata["muse-desktop.sessions.v1"].kind, "durable");
    assert.equal(exported.metadata["muse-desktop.active.v1"].kind, "ui");
    assert.equal(values.size, 2);
  });

  it("copies known legacy keys without overwriting current data", () => {
    const { values } = fakeStorage({
      "muse.sessions.v1": JSON.stringify([{ session_id: "legacy" }]),
      "muse.log.legacy": JSON.stringify([{ id: "e1" }]),
      "muse-desktop.sessions.v1": JSON.stringify([{ session_id: "current" }]),
      "muse.workspace.v1": JSON.stringify("C:/legacy"),
      "muse.settings": "{broken",
    });
    const result = migrateLegacyStorage();
    assert.equal(result.migrated, 2);
    assert.equal(result.skipped, 2);
    assert.deepEqual(JSON.parse(values.get("muse-desktop.sessions.v1") ?? "{}"), [{ session_id: "current" }]);
    assert.deepEqual(JSON.parse(values.get("muse-desktop.log.v1.legacy") ?? "{}"), [{ id: "e1" }]);
    assert.equal(values.get("muse-desktop.workspace.v1"), JSON.stringify("C:/legacy"));
    assert.match(result.errors.join(" "), /corrupt/);
  });

  it("reports scalar read and write failures", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    assert.equal(readStorageString("muse-desktop.theme.v1", "light"), "light");
    assert.equal(consumeStorageIssues()[0]?.kind, "unavailable");

    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
    };
    assert.equal(writeStorageString("muse-desktop.theme.v1", "dark"), false);
    assert.equal(consumeStorageIssues()[0]?.kind, "quota");
  });
});
