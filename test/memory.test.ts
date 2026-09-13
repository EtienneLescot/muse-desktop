/**
 * US-20 memory + anti-drift: dated/sourced entries, 30-day stale boundary,
 * `@mem/` mention expansion (stale flagged, never silent), SCAN nudge,
 * and localStorage persistence.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMemory,
  ageDays,
  ageLabel,
  buildScanNudge,
  createMemory,
  expandMemoryMentions,
  findMemoryByPrefix,
  isStale,
  loadLastScan,
  loadMemories,
  MAX_MEMORIES,
  memoryChipLabel,
  memoryMentionQuery,
  parseMemoryMentions,
  removeMemory,
  saveLastScan,
  saveMemories,
  SCAN_INTERVAL_MS,
  shouldScanNudge,
  staleMemories,
  STALE_AFTER_MS,
  type MemoryEntry,
} from "../src/lib/memory.ts";

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

function fakeStorage(): Map<string, string> {
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
  return m;
}

function entry(daysOld: number, text = "remember the deploy flag"): MemoryEntry {
  return {
    id: `mtest${daysOld}${text.length}`,
    text,
    source: "user",
    createdAt: NOW - daysOld * DAY,
  };
}

describe("createMemory / addMemory", () => {
  it("stores text, source and date", () => {
    const e = createMemory("prefers pnpm", "slack", NOW);
    assert.notEqual(e, null);
    assert.equal(e?.text, "prefers pnpm");
    assert.equal(e?.source, "slack");
    assert.equal(e?.createdAt, NOW);
  });

  it("rejects blank text", () => {
    assert.equal(createMemory("   ", "user", NOW), null);
    assert.deepEqual(addMemory([], "  \n ", "user", NOW), []);
  });

  it("defaults an empty source to user", () => {
    assert.equal(createMemory("x", "  ", NOW)?.source, "user");
  });

  it("appends and caps the store", () => {
    let list: MemoryEntry[] = [];
    for (let i = 0; i < MAX_MEMORIES + 10; i++) {
      list = addMemory(list, `fact ${i}`, "user", NOW + i);
    }
    assert.equal(list.length, MAX_MEMORIES);
    assert.equal(list[list.length - 1].text, `fact ${MAX_MEMORIES + 9}`);
  });
});

describe("stale boundary (30 days)", () => {
  it("29 days is fresh, 31 days is stale", () => {
    assert.equal(isStale(entry(29), NOW), false);
    assert.equal(isStale(entry(31), NOW), true);
  });

  it("exactly 30 days is not yet stale (strictly older)", () => {
    assert.equal(NOW - entry(30).createdAt === STALE_AFTER_MS, true);
    assert.equal(isStale(entry(30), NOW), false);
  });

  it("age labels badge fresh vs stale", () => {
    assert.equal(ageLabel(entry(0), NOW), "aujourd'hui");
    assert.equal(ageLabel(entry(12), NOW), "12 j");
    assert.match(ageLabel(entry(45), NOW), /45 j · stale/);
  });

  it("future-dated entries clamp to today", () => {
    const future: MemoryEntry = { ...entry(0), createdAt: NOW + DAY };
    assert.equal(ageDays(future, NOW), 0);
    assert.equal(isStale(future, NOW), false);
  });

  it("staleMemories returns only the stale, oldest first", () => {
    const stale = staleMemories([entry(40), entry(5), entry(90)], NOW);
    assert.deepEqual(
      stale.map((e) => ageDays(e, NOW)),
      [90, 40],
    );
  });
});

describe("memoryChipLabel / memoryMentionQuery", () => {
  it("clips long text to one line", () => {
    const label = memoryChipLabel(entry(0, `line one\nline two ${"x".repeat(60)}`));
    assert.ok(!label.includes("\n"));
    assert.ok(label.endsWith("…"));
  });

  it("mention query addresses the entry id", () => {
    const e = entry(0);
    assert.equal(memoryMentionQuery(e), `mem/${e.id.slice(0, 8)}`);
  });
});

describe("parseMemoryMentions", () => {
  it("finds @mem/ tokens with offsets", () => {
    const ts = parseMemoryMentions("use @mem/mabc1234 please");
    assert.equal(ts.length, 1);
    assert.equal(ts[0].idPrefix, "mabc1234");
    assert.equal("use @mem/mabc1234 please".slice(ts[0].start, ts[0].end), "@mem/mabc1234");
  });

  it("ignores email-like a@mem/x", () => {
    assert.deepEqual(parseMemoryMentions("mail bob@mem/x"), []);
  });

  it("finds several tokens in order", () => {
    const ids = parseMemoryMentions("@mem/aaa and @mem/bbb").map((t) => t.idPrefix);
    assert.deepEqual(ids, ["aaa", "bbb"]);
  });
});

describe("findMemoryByPrefix", () => {
  it("matches by id prefix, empty prefix never matches", () => {
    const list = [entry(0)];
    assert.equal(findMemoryByPrefix(list, list[0].id.slice(0, 8)), list[0]);
    assert.equal(findMemoryByPrefix(list, "zzz"), null);
    assert.equal(findMemoryByPrefix(list, ""), null);
  });
});

describe("expandMemoryMentions", () => {
  it("inlines source + age, flags stale (never silent)", () => {
    const fresh = { ...entry(3, "use pnpm"), id: "mfresh001" };
    const stale = { ...entry(45, "old flag --force"), id: "mstale002" };
    const { text, used, missing } = expandMemoryMentions(
      `do @mem/${fresh.id.slice(0, 8)} not @mem/${stale.id.slice(0, 8)}`,
      [fresh, stale],
      NOW,
    );
    assert.ok(text.includes("[mémoire user · 3 j] use pnpm"));
    assert.ok(text.includes("[mémoire user · 45 j · stale] old flag --force"));
    assert.ok(text.includes("⚠ stale (> 30 j)"));
    assert.equal(used.length, 2);
    assert.deepEqual(missing, []);
  });

  it("leaves unknown prefixes verbatim and reports them", () => {
    const { text, used, missing } = expandMemoryMentions("try @mem/zzz9 now", [], NOW);
    assert.equal(text, "try @mem/zzz9 now");
    assert.deepEqual(used, []);
    assert.deepEqual(missing, ["zzz9"]);
  });

  it("is a no-op without tokens", () => {
    const { text, used } = expandMemoryMentions("plain text", [entry(0)], NOW);
    assert.equal(text, "plain text");
    assert.deepEqual(used, []);
  });
});

describe("SCAN nudge", () => {
  it("never nudges an empty store", () => {
    assert.equal(shouldScanNudge(0, null, NOW), false);
  });

  it("nudges when never scanned, then respects the interval", () => {
    assert.equal(shouldScanNudge(2, null, NOW), true);
    assert.equal(shouldScanNudge(2, NOW, NOW), false);
    assert.equal(shouldScanNudge(2, NOW - SCAN_INTERVAL_MS, NOW), true);
    assert.equal(shouldScanNudge(2, NOW - SCAN_INTERVAL_MS + 1, NOW), false);
  });

  it("nudge text is lightweight and points at the stale backlog", () => {
    const nudge = buildScanNudge([entry(5), entry(60)], NOW);
    assert.ok(nudge.includes("2 entrée(s)"));
    assert.ok(nudge.includes("1 entrée(s) stale"));
    assert.ok(nudge.length < 300, "stays a lightweight nudge");
  });

  it("clean store nudges with nothing to review", () => {
    assert.ok(buildScanNudge([entry(1)], NOW).includes("aucune entrée stale"));
  });
});

describe("persistence (muse-desktop.memory.*)", () => {
  it("round-trips entries and the scan stamp", () => {
    fakeStorage();
    saveMemories([entry(2), entry(40)]);
    saveLastScan(NOW);
    assert.equal(loadMemories().length, 2);
    assert.equal(loadLastScan(), NOW);
  });

  it("filters invalid rows and non-array blobs", () => {
    const m = fakeStorage();
    m.set("muse-desktop.memory.v1", JSON.stringify([{ nope: 1 }, entry(1), "x"]));
    assert.equal(loadMemories().length, 1);
    m.set("muse-desktop.memory.v1", JSON.stringify({ nope: 1 }));
    assert.deepEqual(loadMemories(), []);
    m.set("muse-desktop.memory.scan.v1", JSON.stringify("soon"));
    assert.equal(loadLastScan(), null);
  });
});

describe("removeMemory", () => {
  it("removes by id, unknown id is a no-op", () => {
    const list = [entry(1), entry(2)];
    assert.equal(removeMemory(list, list[0].id).length, 1);
    assert.equal(removeMemory(list, "nope"), list);
  });
});
