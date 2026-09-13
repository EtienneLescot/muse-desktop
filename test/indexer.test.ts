/**
 * US-23 (w-index) opt-in local index: supported formats, exclusions,
 * .gitignore handling, mtime-based rescan, search hits, persistence.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  dropIndexData,
  emptyStore,
  extensionOf,
  INDEX_DATA_KEY,
  INDEX_ENABLED_KEY,
  isExcludedDir,
  isSupportedFile,
  loadIndexData,
  loadIndexEnabled,
  matchesGitignore,
  parseGitignore,
  parseContentLines,
  rescanIndex,
  saveIndexData,
  saveIndexEnabled,
  searchIndex,
  shouldIndexPath,
  SUPPORTED_EXTENSIONS,
  indexStats,
  type FileSnapshot,
} from "../src/lib/indexer.ts";

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

function snap(path: string, content: string, mtimeMs = 1000): FileSnapshot {
  return { path, mtimeMs, content };
}

describe("w-index supported formats", () => {
  it("lists exactly the implemented parsers", () => {
    assert.deepEqual([...SUPPORTED_EXTENSIONS], [
      ".ts",
      ".tsx",
      ".js",
      ".md",
      ".rs",
      ".json",
    ]);
  });

  it("accepts each supported extension", () => {
    assert.equal(isSupportedFile("src/a.ts"), true);
    assert.equal(isSupportedFile("src/a.tsx"), true);
    assert.equal(isSupportedFile("src/a.js"), true);
    assert.equal(isSupportedFile("docs/a.md"), true);
    assert.equal(isSupportedFile("src/a.rs"), true);
    assert.equal(isSupportedFile("data/a.json"), true);
  });

  it("matches extensions case-insensitively", () => {
    assert.equal(isSupportedFile("src/A.TS"), true);
    assert.equal(isSupportedFile("docs/NOTES.MD"), true);
  });

  it("rejects formats without an implemented parser", () => {
    for (const p of [
      "main.py",
      "style.css",
      "app.jsx",
      "lib.rs.bak",
      "README",
      ".gitignore",
      "photo.png",
      "font.woff2",
    ]) {
      assert.equal(isSupportedFile(p), false, p);
    }
  });

  it("parses content lines for every supported extension", () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const lines = parseContentLines(`f${ext}`, "one\ntwo\nthree");
      assert.deepEqual(lines, ["one", "two", "three"], ext);
    }
  });

  it("returns no lines for unsupported extensions", () => {
    assert.deepEqual(parseContentLines("main.py", "x\ny"), []);
  });

  it("extensionOf handles dotfiles and missing extensions", () => {
    assert.equal(extensionOf("README"), "");
    assert.equal(extensionOf(".gitignore"), "");
    assert.equal(extensionOf("a/b/c.rs"), ".rs");
  });
});

describe("w-index build-dir exclusions", () => {
  it("excludes common build/vendor dirs at any depth", () => {
    for (const d of [
      "node_modules",
      "dist",
      "build",
      "target",
      ".git",
      ".next",
      "out",
      "coverage",
      "__pycache__",
      ".venv",
      "venv",
    ]) {
      assert.equal(isExcludedDir(`${d}/a.ts`), true, d);
      assert.equal(isExcludedDir(`sub/${d}/a.ts`), true, `sub/${d}`);
    }
  });

  it("keeps ordinary source paths", () => {
    assert.equal(isExcludedDir("src/lib/indexer.ts"), false);
    assert.equal(isExcludedDir("src/distraction/main.ts"), false);
    assert.equal(isExcludedDir("builders/util.ts"), false);
  });
});

describe("w-index .gitignore handling", () => {
  it("drops blanks and comments, keeps order", () => {
    assert.deepEqual(
      parseGitignore("# comment\n\n*.log\ndist/\n  \n!keep.log\n"),
      ["*.log", "dist/", "!keep.log"],
    );
  });

  it("matches globs and directory prefixes", () => {
    assert.equal(matchesGitignore(["*.log"], "debug.log"), true);
    assert.equal(matchesGitignore(["*.log"], "sub/debug.log"), true);
    assert.equal(matchesGitignore(["*.log"], "debug.ts"), false);
    assert.equal(matchesGitignore(["dist/"], "dist/bundle.js"), true);
    assert.equal(matchesGitignore(["dist/"], "src/dist/x.ts"), true);
    assert.equal(matchesGitignore(["dist/"], "src/main.ts"), false);
  });

  it("lets later patterns override earlier ones (negation)", () => {
    assert.equal(
      matchesGitignore(["*.log", "!keep.log"], "keep.log"),
      false,
    );
    assert.equal(
      matchesGitignore(["*.log", "!keep.log"], "other.log"),
      true,
    );
  });

  it("shouldIndexPath combines format + build dirs + gitignore", () => {
    assert.equal(shouldIndexPath("src/a.ts", []), true);
    assert.equal(shouldIndexPath("src/a.py", []), false);
    assert.equal(shouldIndexPath("dist/a.js", []), false);
    assert.equal(shouldIndexPath("src/debug.log", ["*.log"]), false);
    assert.equal(shouldIndexPath(".gitignore", []), false);
  });
});

describe("w-index build", () => {
  it("indexes eligible files and skips the rest", () => {
    const store = buildIndex([
      snap("src/a.ts", "hello"),
      snap("main.py", "print(1)"),
      snap("dist/b.js", "bundled"),
      snap(".gitignore", "*.log"),
    ]);
    assert.deepEqual(Object.keys(store.files), ["src/a.ts"]);
    assert.equal(typeof store.builtAt, "number");
  });

  it("dedupes repeat paths, first snapshot wins", () => {
    const store = buildIndex([
      snap("a.ts", "first", 1),
      snap("a.ts", "second", 2),
    ]);
    assert.equal(store.files["a.ts"].lines[0], "first");
  });

  it("applies .gitignore patterns passed by the caller", () => {
    const store = buildIndex(
      [snap("debug.log.ts", "x"), snap("trace.ts", "y")],
      ["debug*"],
    );
    assert.deepEqual(Object.keys(store.files), ["trace.ts"]);
  });
});

describe("w-index mtime-based rescan", () => {
  it("reuses unchanged entries and reparses changed ones", () => {
    const prev = buildIndex([
      snap("same.ts", "v1", 100),
      snap("chg.ts", "v1", 100),
      snap("gone.ts", "bye", 100),
    ]);
    const sameEntry = prev.files["same.ts"];
    const { store, summary } = rescanIndex(prev, [
      snap("same.ts", "v1-CHANGED-CONTENT", 100),
      snap("chg.ts", "v2", 200),
      snap("new.md", "# hi", 50),
    ]);
    // Same mtime: old entry reused untouched (no reparse).
    assert.equal(store.files["same.ts"], sameEntry);
    assert.deepEqual(store.files["same.ts"].lines, ["v1"]);
    // New mtime: reparsed.
    assert.deepEqual(store.files["chg.ts"].lines, ["v2"]);
    assert.ok("new.md" in store.files);
    assert.ok(!("gone.ts" in store.files));
    assert.deepEqual(summary, {
      added: 1,
      updated: 1,
      removed: 1,
      unchanged: 1,
    });
  });

  it("drops entries that become ineligible", () => {
    const prev = buildIndex([snap("a.ts", "x", 1)]);
    const { store, summary } = rescanIndex(prev, [snap("a.ts", "x", 1)], [
      "a.ts",
    ]);
    assert.deepEqual(Object.keys(store.files), []);
    assert.equal(summary.removed, 1);
  });
});

describe("w-index search", () => {
  it("returns path + 1-based line hits, case-insensitively", () => {
    const store = buildIndex([
      snap("b.ts", "Hello world\nnothing here"),
      snap("a.ts", "say HELLO again\nhello once more"),
    ]);
    assert.deepEqual(searchIndex(store, "hello"), [
      { path: "a.ts", line: 1, text: "say HELLO again" },
      { path: "a.ts", line: 2, text: "hello once more" },
      { path: "b.ts", line: 1, text: "Hello world" },
    ]);
  });

  it("returns no hits for blank queries", () => {
    const store = buildIndex([snap("a.ts", "hello")]);
    assert.deepEqual(searchIndex(store, "   "), []);
  });

  it("caps hits at maxHits", () => {
    const store = buildIndex([
      snap("a.ts", "x\nx\nx\nx\nx"),
    ]);
    assert.equal(searchIndex(store, "x", 3).length, 3);
  });

  it("stats count files and lines", () => {
    const store = buildIndex([
      snap("a.ts", "one\ntwo"),
      snap("b.md", "# t"),
    ]);
    assert.deepEqual(indexStats(store), { files: 2, lines: 3 });
    assert.deepEqual(indexStats(emptyStore()), { files: 0, lines: 0 });
  });
});

describe("w-index persistence", () => {
  it("opt-in flag defaults to off", () => {
    fakeStorage();
    assert.equal(loadIndexEnabled(), false);
  });

  it("round-trips the enabled flag under its own key", () => {
    const m = fakeStorage();
    saveIndexEnabled(true);
    assert.equal(m.get(INDEX_ENABLED_KEY), "1");
    assert.equal(loadIndexEnabled(), true);
    saveIndexEnabled(false);
    assert.equal(m.has(INDEX_ENABLED_KEY), false);
    assert.equal(loadIndexEnabled(), false);
  });

  it("round-trips index data and drops it on delete", () => {
    const m = fakeStorage();
    const store = buildIndex([snap("a.ts", "hello", 7)]);
    saveIndexData(store);
    assert.ok(m.has(INDEX_DATA_KEY));
    const back = loadIndexData();
    assert.deepEqual(back.files["a.ts"], {
      path: "a.ts",
      mtimeMs: 7,
      lines: ["hello"],
    });
    dropIndexData();
    assert.equal(m.has(INDEX_DATA_KEY), false);
    assert.deepEqual(loadIndexData(), emptyStore());
  });

  it("falls back to an empty store on corrupt data", () => {
    const m = fakeStorage();
    m.set(INDEX_DATA_KEY, "not-json{{{");
    assert.deepEqual(loadIndexData(), emptyStore());
    m.set(INDEX_DATA_KEY, JSON.stringify({ files: { "a.ts": { junk: 1 } } }));
    assert.deepEqual(loadIndexData(), { files: {}, builtAt: null });
  });
});
