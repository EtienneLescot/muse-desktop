/**
 * Truncation caps in the persistence layer.
 *
 * `persist.ts` bounds two unbounded-by-nature collections:
 *
 *   - the per-session log, capped at `MAX_LOG_ENTRIES` (applied in three places:
 *     `loadLog`, `appendLog`, `saveLog`);
 *   - the approval allowlist, capped at `MAX_ALLOWLIST_RULES` (applied in two:
 *     `loadAllowlist`, `saveAllowlist`).
 *
 * Neither constant had a test. The risk is quiet: a broken cap does not throw,
 * it lets history grow without limit, and the transcript renderer mounts a
 * bounded window precisely because a huge log is slow to display. A cap that
 * silently kept the *oldest* entries instead of the newest would also lose the
 * recent conversation while appearing to work.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ALLOWLIST_RULES,
  MAX_LOG_ENTRIES,
  appendLog,
  loadAllowlist,
  loadLog,
  saveAllowlist,
  saveLog,
  type LogEntry,
} from "../src/lib/persist.ts";

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

/**
 * A log entry must satisfy `isValidEntry`, which requires a string `id`, a
 * numeric `ts`, a known `role` and a string `text`. Entries missing `id` are
 * silently dropped on read — which is how this fixture was first written wrong.
 */
const entry = (n: number): LogEntry =>
  ({ id: `e-${n}`, role: "user", text: `entry-${n}`, ts: n }) as LogEntry;

beforeEach(() => {
  fakeStorage();
});

describe("log truncation", () => {
  it("keeps at most MAX_LOG_ENTRIES on append", () => {
    const session = "s-append";
    appendLog(session, Array.from({ length: MAX_LOG_ENTRIES + 250 }, (_, i) => entry(i)));
    assert.equal(loadLog(session).length, MAX_LOG_ENTRIES);
  });

  it("drops the OLDEST entries, not the newest", () => {
    const session = "s-order";
    appendLog(session, Array.from({ length: MAX_LOG_ENTRIES + 5 }, (_, i) => entry(i)));
    const kept = loadLog(session);
    // The last appended entry must survive; the first ones must not.
    assert.equal(kept[kept.length - 1]?.text, `entry-${MAX_LOG_ENTRIES + 4}`);
    assert.equal(kept[0]?.text, "entry-5");
  });

  it("does not truncate a log exactly at the cap", () => {
    const session = "s-exact";
    appendLog(session, Array.from({ length: MAX_LOG_ENTRIES }, (_, i) => entry(i)));
    assert.equal(loadLog(session).length, MAX_LOG_ENTRIES);
  });

  it("caps across successive appends, not only within one call", () => {
    const session = "s-successive";
    for (let i = 0; i < MAX_LOG_ENTRIES + 40; i += 1) appendLog(session, [entry(i)]);
    const kept = loadLog(session);
    assert.equal(kept.length, MAX_LOG_ENTRIES);
    assert.equal(kept[kept.length - 1]?.text, `entry-${MAX_LOG_ENTRIES + 39}`);
  });

  it("bounds loadLog even when storage already holds more than the cap", () => {
    // Simulates a log written by an older build, or a corrupt/huge history.
    const session = "s-preexisting";
    const huge = Array.from({ length: MAX_LOG_ENTRIES + 300 }, (_, i) => entry(i));
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      `muse-desktop.log.v1.${session}`,
      JSON.stringify(huge),
    );
    const kept = loadLog(session);
    assert.equal(kept.length, MAX_LOG_ENTRIES);
    assert.equal(kept[kept.length - 1]?.text, `entry-${MAX_LOG_ENTRIES + 299}`);
  });

  it("bounds saveLog the same way", () => {
    const session = "s-save";
    saveLog(session, Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, i) => entry(i)));
    assert.equal(loadLog(session).length, MAX_LOG_ENTRIES);
  });
});

describe("legacy host-internal child lanes", () => {
  const subagent = (over: Partial<LogEntry>): LogEntry =>
    ({ id: "a-1", role: "subagent", text: "", ts: 1, ...over }) as LogEntry;
  const seed = (session: string, entries: LogEntry[]): void => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      `muse-desktop.log.v1.${session}`,
      JSON.stringify(entries),
    );
  };

  it("flags a legacy reminder child so its block is never rendered", () => {
    seed("s-legacy-internal", [subagent({ objective: "Reminder child session" })]);
    assert.equal(loadLog("s-legacy-internal")[0]?.subagentInternal, true);
  });

  it("matches the host label on the first text line, case and spacing included", () => {
    seed("s-legacy-text", [subagent({ text: "  Reminder   Child Session \nbody" })]);
    assert.equal(loadLog("s-legacy-text")[0]?.subagentInternal, true);
  });

  it("leaves a real sub-agent alone", () => {
    seed("s-real", [
      subagent({ objective: "Summarise the roadmap" }),
      { id: "u-1", role: "user", text: "Reminder child session", ts: 2 } as LogEntry,
    ]);
    const kept = loadLog("s-real");
    assert.equal(kept[0]?.subagentInternal, undefined);
    // The label only means "internal" on a sub-agent lane, never on a message.
    assert.equal(kept[1]?.subagentInternal, undefined);
  });

  it("never un-flags an entry that already carries the flag", () => {
    seed("s-flagged", [subagent({ subagentInternal: true, objective: "whatever" })]);
    assert.equal(loadLog("s-flagged")[0]?.subagentInternal, true);
  });
});

describe("allowlist truncation", () => {
  const rule = (n: number) => ({
    id: `id-${n}`,
    pattern: `tool-${n}`,
    scope: "",
    decision: "allow" as const,
    createdAt: n,
  });

  it("keeps at most MAX_ALLOWLIST_RULES on save", () => {
    saveAllowlist(Array.from({ length: MAX_ALLOWLIST_RULES + 30 }, (_, i) => rule(i)));
    assert.equal(loadAllowlist().length, MAX_ALLOWLIST_RULES);
  });

  it("keeps the most recent rules when truncating", () => {
    saveAllowlist(Array.from({ length: MAX_ALLOWLIST_RULES + 3 }, (_, i) => rule(i)));
    const kept = loadAllowlist();
    assert.equal(kept[kept.length - 1]?.pattern, `tool-${MAX_ALLOWLIST_RULES + 2}`);
    // The three oldest are the ones dropped.
    assert.equal(kept[0]?.pattern, "tool-3");
  });

  it("bounds loadAllowlist when storage already holds too many rules", () => {
    const many = Array.from({ length: MAX_ALLOWLIST_RULES + 60 }, (_, i) => rule(i));
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      "muse-desktop.allowlist.v1",
      JSON.stringify(many),
    );
    assert.equal(loadAllowlist().length, MAX_ALLOWLIST_RULES);
  });

  it("leaves a list below the cap untouched", () => {
    const five = Array.from({ length: 5 }, (_, i) => rule(i));
    saveAllowlist(five);
    assert.deepEqual(
      loadAllowlist().map((r) => r.pattern),
      five.map((r) => r.pattern),
    );
  });
});
