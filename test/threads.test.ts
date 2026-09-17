/**
 * US-5 threads sidebar: pure logic (sort / filter / archive / keyboard
 * cycling) plus the persisted `archived` flag round-trip.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countRunning,
  cycleThreadId,
  isArchived,
  moveThread,
  selectActiveThreads,
  selectArchivedThreads,
  withArchivedFlag,
  withPinnedFlag,
  withUnreadFlag,
  type ThreadLike,
} from "../src/lib/threads.ts";
import { loadSessions, saveSessions } from "../src/lib/persist.ts";

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

function thread(
  id: string,
  overrides: Partial<ThreadLike> = {},
): ThreadLike {
  return {
    session_id: id,
    title: `Thread ${id}`,
    createdAt: 1000,
    ...overrides,
  };
}

describe("US-5 thread sorting", () => {
  it("puts running threads first, then most recent", () => {
    const list = [
      thread("old-idle", { createdAt: 1000 }),
      thread("new-idle", { createdAt: 3000 }),
      thread("run-old", { createdAt: 500, running: true }),
      thread("run-new", { createdAt: 2000, running: true }),
    ];
    const ids = selectActiveThreads(list).map((s) => s.session_id);
    assert.deepEqual(ids, ["run-new", "run-old", "new-idle", "old-idle"]);
  });

  it("keeps at least two running threads visible on top", () => {
    const list = [
      thread("idle", { createdAt: 9999 }),
      thread("run-a", { createdAt: 100, running: true }),
      thread("run-b", { createdAt: 200, running: true }),
    ];
    const top2 = selectActiveThreads(list).slice(0, 2);
    assert.ok(top2.every((s) => s.running === true));
  });

  it("keeps pinned conversations ahead of running and recent rows", () => {
    const list = [
      thread("run", { running: true, createdAt: 500 }),
      thread("pinned", { pinned: true, createdAt: 100 }),
      thread("recent", { createdAt: 900 }),
    ];
    assert.deepEqual(selectActiveThreads(list).map((s) => s.session_id), [
      "pinned",
      "run",
      "recent",
    ]);
  });

  it("honours an explicit order within the same tier", () => {
    const list = [
      thread("a", { sortOrder: 2 }),
      thread("b", { sortOrder: 0 }),
      thread("c", { sortOrder: 1 }),
    ];
    assert.deepEqual(selectActiveThreads(list).map((s) => s.session_id), ["b", "c", "a"]);
  });
});

describe("US-5 pinning", () => {
  it("toggles one pinned row without mutating the input", () => {
    const list = [thread("a"), thread("b")];
    const next = withPinnedFlag(list, "b", true);
    assert.equal(next.find((s) => s.session_id === "b")?.pinned, true);
    assert.equal(list[1].pinned, undefined);
  });
});

describe("US-5 unread and manual order", () => {
  it("marks a response unread without mutating the source", () => {
    const list = [thread("a"), thread("b")];
    const next = withUnreadFlag(list, "b", true);
    assert.equal(next[1].unread, true);
    assert.equal(list[1].unread, undefined);
  });

  it("moves a conversation and assigns stable ranks", () => {
    const list = [thread("a"), thread("b"), thread("c")];
    const moved = moveThread(list, "b", -1);
    assert.deepEqual(selectActiveThreads(moved).map((s) => s.session_id), ["b", "a", "c"]);
    assert.equal(moved.find((s) => s.session_id === "b")?.sortOrder, 0);
  });
});

describe("US-5 archive partition", () => {
  it("splits active and archived lists", () => {
    const list = [
      thread("a", { createdAt: 1000 }),
      thread("b", { createdAt: 2000, archived: true }),
      thread("c", { createdAt: 3000, archived: true }),
    ];
    assert.deepEqual(
      selectActiveThreads(list).map((s) => s.session_id),
      ["a"],
    );
    assert.deepEqual(
      selectArchivedThreads(list).map((s) => s.session_id),
      ["c", "b"],
    );
  });

  it("treats missing or non-true archived flags as active", () => {
    const list = [thread("a"), thread("b", { archived: false })];
    assert.equal(isArchived(list[0]), false);
    assert.equal(selectActiveThreads(list).length, 2);
    assert.deepEqual(selectArchivedThreads(list), []);
  });

  it("excludes archived threads from the live count", () => {
    const list = [
      thread("a", { running: true }),
      thread("b", { running: true, archived: true }),
    ];
    assert.equal(countRunning(list), 1);
  });
});

describe("US-5 archive / restore", () => {
  it("archives one thread and preserves its title", () => {
    const list = [thread("a"), thread("b")];
    const next = withArchivedFlag(list, "a", true);
    assert.equal(next.find((s) => s.session_id === "a")?.archived, true);
    assert.equal(next.find((s) => s.session_id === "a")?.title, "Thread a");
    assert.equal(next.find((s) => s.session_id === "b")?.archived, undefined);
    // input untouched (new array)
    assert.equal(list[0].archived, undefined);
  });

  it("restores a thread back to the active list", () => {
    const list = [thread("a", { archived: true, title: "my auto title" })];
    const next = withArchivedFlag(list, "a", false);
    assert.equal(next[0].archived, false);
    assert.equal(next[0].title, "my auto title");
    assert.deepEqual(
      selectActiveThreads(next).map((s) => s.session_id),
      ["a"],
    );
  });

  it("persists the archived flag across save/load", () => {
    fakeStorage();
    saveSessions([
      { session_id: "a", workspace: "/w", title: "keep me", createdAt: 1 },
      { session_id: "b", workspace: "/w", title: "shelved", createdAt: 2, archived: true },
    ]);
    const back = loadSessions();
    assert.equal(back.find((s) => s.session_id === "a")?.archived, undefined);
    assert.equal(back.find((s) => s.session_id === "b")?.archived, true);
    assert.equal(back.find((s) => s.session_id === "b")?.title, "shelved");
  });

  it("persists the pinned flag across save/load", () => {
    fakeStorage();
    saveSessions([
      { session_id: "a", workspace: "/w", title: "pinned", createdAt: 1, pinned: true },
    ]);
    assert.equal(loadSessions()[0].pinned, true);
  });

  it("persists unread state and manual order across save/load", () => {
    fakeStorage();
    saveSessions([
      { session_id: "a", workspace: "/w", title: "unread", createdAt: 1, unread: true, sortOrder: 0 },
    ]);
    const restored = loadSessions()[0];
    assert.equal(restored.unread, true);
    assert.equal(restored.sortOrder, 0);
  });

  it("persists the host session durability posture across save/load", () => {
    fakeStorage();
    saveSessions([
      {
        session_id: "ephemeral",
        workspace: "/w",
        title: "saved transcript",
        createdAt: 1,
        session_durability: "ephemeral",
      },
    ]);
    assert.equal(loadSessions()[0].session_durability, "ephemeral");
  });
});

describe("US-5 keyboard cycling", () => {
  const ids = ["a", "b", "c"];

  it("moves forward and wraps around", () => {
    assert.equal(cycleThreadId(ids, "a", 1), "b");
    assert.equal(cycleThreadId(ids, "c", 1), "a");
  });

  it("moves backward and wraps around", () => {
    assert.equal(cycleThreadId(ids, "a", -1), "c");
    assert.equal(cycleThreadId(ids, "c", -1), "b");
  });

  it("returns null for an empty list and the single id alone", () => {
    assert.equal(cycleThreadId([], "a", 1), null);
    assert.equal(cycleThreadId(["only"], "elsewhere", -1), "only");
  });

  it("restarts from the direction edge on unknown selection", () => {
    assert.equal(cycleThreadId(ids, "gone", 1), "a");
    assert.equal(cycleThreadId(ids, "gone", -1), "c");
    assert.equal(cycleThreadId(ids, null, 1), "a");
  });
});
