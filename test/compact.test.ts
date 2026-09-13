/**
 * US-4 thread compaction: `/compact` trigger, entry-count thresholds,
 * and local extractive summaries (no model call).
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_AUTO_ENTRIES,
  COMPACT_WARN_ENTRIES,
  buildSummary,
  dropSummary,
  formatSummaryText,
  formatUsage,
  isCompactCommand,
  loadSummary,
  needsAutoCompaction,
  needsCompaction,
  parseContextUsage,
  saveSummary,
  suggestsServerCompaction,
} from "../src/lib/compact.ts";
import type { LogEntry } from "../src/lib/persist.ts";

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

function entry(role: LogEntry["role"], text: string): LogEntry {
  return { id: `id-${role}-${text.length}`, ts: 1, role, text };
}

describe("/compact trigger", () => {
  it("matches the bare command with any casing or outer whitespace", () => {
    assert.equal(isCompactCommand("/compact"), true);
    assert.equal(isCompactCommand("  /compact  "), true);
    assert.equal(isCompactCommand("/COMPACT"), true);
    assert.equal(isCompactCommand("/Compact now"), true);
  });

  it("rejects lookalikes and embedded occurrences", () => {
    assert.equal(isCompactCommand(""), false);
    assert.equal(isCompactCommand("/compacted"), false);
    assert.equal(isCompactCommand("/foo"), false);
    assert.equal(isCompactCommand("please /compact"), false);
    assert.equal(isCompactCommand("/compa"), false);
  });
});

describe("compaction thresholds", () => {
  it("suggests compaction at 1500 entries, not before", () => {
    assert.equal(needsCompaction(COMPACT_WARN_ENTRIES - 1), false);
    assert.equal(needsCompaction(COMPACT_WARN_ENTRIES), true);
  });

  it("auto-compacts at 2000 entries (persisted-log cap), not before", () => {
    assert.equal(needsAutoCompaction(COMPACT_AUTO_ENTRIES - 1), false);
    assert.equal(needsAutoCompaction(COMPACT_AUTO_ENTRIES), true);
  });
});

describe("extractive summary", () => {
  it("structures decisions, context and todos without a model", () => {
    const log = [
      entry("user", "Add dark mode to the settings page"),
      entry("assistant", "I will start with the theme tokens."),
      entry("tool", "Approval requested: write src/theme.ts"),
      entry("system", "Decision sent: allow (req-1)"),
      entry("assistant", "Done.\n- [ ] verify contrast in CI"),
    ];
    const s = buildSummary("session-abcdef", log);
    assert.equal(s.sourceSessionId, "session-abcdef");
    assert.equal(s.entryCount, 5);
    assert.equal(s.firstUser, "Add dark mode to the settings page");
    assert.match(s.lastAssistant, /verify contrast/);
    assert.deepEqual(s.context, ["Add dark mode to the settings page"]);
    assert.ok(s.decisions.length >= 2);
    assert.ok(s.decisions.some((d) => /Approval requested/.test(d)));
    assert.deepEqual(s.todos, ["- [ ] verify contrast in CI"]);
  });

  it("caps sections and clips long lines", () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => entry("user", `question ${i} ` + "x".repeat(500)),
    );
    const s = buildSummary("s", log);
    assert.equal(s.context.length, 8);
    assert.ok(s.context.every((c) => c.length <= 201));
  });

  it("handles an empty log", () => {
    const s = buildSummary("s", []);
    assert.deepEqual(
      { ...s, createdAt: 0 },
      {
        sourceSessionId: "s",
        createdAt: 0,
        entryCount: 0,
        decisions: [],
        context: [],
        todos: [],
        firstUser: "",
        lastAssistant: "",
      },
    );
    assert.equal(formatSummaryText(s).length > 0, true);
  });

  it("formats a re-openable structured prefill", () => {
    const s = buildSummary("session-abcdef", [
      entry("user", "Ship it"),
      entry("system", "Decision sent: allow (req-1)"),
      entry("assistant", "TODO: changelog entry"),
    ]);
    const text = formatSummaryText(s);
    assert.match(text, /Suite du thread session-/);
    assert.match(text, /Contexte/);
    assert.match(text, /Décisions/);
    assert.match(text, /À faire/);
  });
});

describe("summary persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("round-trips a summary per source session", () => {
    assert.equal(loadSummary("nope"), null);
    const s = buildSummary("abc", [entry("user", "hi")]);
    saveSummary(s);
    assert.deepEqual(loadSummary("abc"), s);
    dropSummary("abc");
    assert.equal(loadSummary("abc"), null);
  });
});

describe("server context usage (US-4 server half)", () => {
  it("parses a full triple, keeps host pressure verbatim", () => {
    const u = parseContextUsage({
      pressure: "warning",
      usedTokens: 1200000,
      windowTokens: 2000000,
    });
    assert.ok(u !== null);
    assert.equal(u.pressure, "warning");
    assert.equal(u.usedTokens, 1200000);
    assert.equal(u.windowTokens, 2000000);
  });

  it("defaults unknown pressure, drops non-objects", () => {
    assert.equal(parseContextUsage(null), null);
    assert.equal(parseContextUsage("x"), null);
    const u = parseContextUsage({});
    assert.ok(u !== null);
    assert.equal(u.pressure, "unknown");
    assert.equal(u.usedTokens, null);
    const bad = parseContextUsage({ pressure: "warning", usedTokens: "lots" });
    assert.ok(bad !== null);
    assert.equal(bad.usedTokens, null);
  });

  it("suggests from warning up, never on unknown", () => {
    assert.equal(suggestsServerCompaction(null), false);
    assert.equal(
      suggestsServerCompaction({ pressure: "unknown", usedTokens: null, windowTokens: null }),
      false,
    );
    assert.equal(
      suggestsServerCompaction({ pressure: "normal", usedTokens: 1, windowTokens: 2 }),
      false,
    );
    assert.equal(
      suggestsServerCompaction({ pressure: "warning", usedTokens: 1, windowTokens: 2 }),
      true,
    );
    assert.equal(
      suggestsServerCompaction({ pressure: "blocked", usedTokens: 1, windowTokens: 2 }),
      true,
    );
  });

  it("formats occupancy compactly", () => {
    assert.equal(
      formatUsage({ pressure: "warning", usedTokens: 1200000, windowTokens: 2000000 }),
      "1.2M / 2.0M tokens · warning",
    );
    assert.equal(
      formatUsage({ pressure: "normal", usedTokens: null, windowTokens: null }),
      "? / ? tokens · normal",
    );
  });
});
