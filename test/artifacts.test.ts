/**
 * US-12 + US-21: thread recap + versioned artifacts.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadRecap,
  dropArtifacts,
  extractBlocks,
  findVersionText,
  loadArtifacts,
  mergeAssistantBlocks,
  saveArtifacts,
  setVersionComment,
  type Artifact,
  type ArtifactLogEntry,
} from "../src/lib/artifacts.ts";

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

function entry(id: string, role: string, text: string): ArtifactLogEntry {
  return { id, role, text };
}

describe("extractBlocks", () => {
  it("extracts fenced code blocks with lang + title", () => {
    const blocks = extractBlocks(
      "voici :\n```ts\nconst x = 1;\n```\nfin",
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.kind, "code");
    assert.equal(blocks[0]?.lang, "ts");
    assert.equal(blocks[0]?.text, "const x = 1;");
    assert.match(blocks[0]?.title ?? "", /const x/);
  });

  it("classifies prose fences as doc", () => {
    for (const lang of ["", "md", "markdown", "txt"]) {
      const blocks = extractBlocks(`\`\`\`${lang}\n# Plan\n- step\n\`\`\``);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.kind, "doc");
    }
  });

  it("ignores unclosed fences and empty blocks", () => {
    assert.deepEqual(extractBlocks("```ts\nno close"), []);
    assert.deepEqual(extractBlocks("```\n   \n```"), []);
    assert.deepEqual(extractBlocks("no fences here"), []);
  });

  it("extracts several blocks in source order", () => {
    const blocks = extractBlocks(
      "```py\na = 1\n```\nentre\n```md\n# Doc\n```",
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["code", "doc"],
    );
  });
});

describe("mergeAssistantBlocks", () => {
  it("creates one artifact per block, then versions on same key", () => {
    const v1 = mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
    ]);
    assert.equal(v1.length, 1);
    assert.deepEqual(v1[0]?.versions.map((v) => v.v), [1]);

    const v2 = mergeAssistantBlocks(v1, "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
      { entryId: "e2", text: "mieux :\n```ts\nconst x = 2;\n```", ts: 20 },
    ]);
    assert.equal(v2.length, 1);
    assert.deepEqual(v2[0]?.versions.map((v) => v.v), [1, 2]);
    assert.equal(v2[0]?.versions[1]?.sourceEntryId, "e2");
  });

  it("is idempotent: re-merging adds no version", () => {
    const once = mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
    ]);
    const twice = mergeAssistantBlocks(once, "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
    ]);
    assert.deepEqual(twice, once);
  });

  it("versions same-language refinements, keeps other languages apart", () => {
    const merged = mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
      { entryId: "e2", text: "```ts\nconst x = 1;\n```", ts: 20 },
      { entryId: "e3", text: "```ts\nconst y = 9;\n```", ts: 30 },
      { entryId: "e4", text: "```py\nz = 3\n```", ts: 40 },
    ]);
    assert.equal(merged.length, 2);
    const ts = merged.find((a) => a.lang === "ts");
    const py = merged.find((a) => a.lang === "py");
    assert.deepEqual(ts?.versions.map((v) => v.v), [1, 2]);
    assert.deepEqual(py?.versions.map((v) => v.v), [1]);
  });

  it("never mutates its input", () => {
    const base = mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
    ]);
    const frozen = JSON.parse(JSON.stringify(base)) as Artifact[];
    mergeAssistantBlocks(base, "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
      { entryId: "e2", text: "```ts\nconst x = 2;\n```", ts: 20 },
    ]);
    assert.deepEqual(base, frozen);
  });
});

describe("version lookup + anchored comments", () => {
  function twoVersions(): Artifact[] {
    return mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
      { entryId: "e2", text: "```ts\nconst x = 2;\n```", ts: 20 },
    ]);
  }

  it("finds version text for the 1-click restore payload", () => {
    const arts = twoVersions();
    const id = arts[0]?.id ?? "";
    assert.equal(findVersionText(arts, id, 1), "const x = 1;");
    assert.equal(findVersionText(arts, id, 2), "const x = 2;");
    assert.equal(findVersionText(arts, id, 3), null);
    assert.equal(findVersionText(arts, "nope", 1), null);
  });

  it("anchors one comment per version without touching the rest", () => {
    const arts = twoVersions();
    const id = arts[0]?.id ?? "";
    const noted = setVersionComment(arts, id, 2, "revoir le typage");
    assert.equal(
      noted[0]?.versions.find((v) => v.v === 2)?.comment,
      "revoir le typage",
    );
    assert.equal(
      noted[0]?.versions.find((v) => v.v === 1)?.comment,
      "",
    );
    // input untouched (pure)
    assert.equal(
      arts[0]?.versions.find((v) => v.v === 2)?.comment,
      "",
    );
    // unknown ids are a no-op
    assert.deepEqual(setVersionComment(arts, "nope", 1, "x"), arts);
  });
});

describe("buildThreadRecap", () => {
  it("counts roles, lists files, picks decisions", () => {
    const recap = buildThreadRecap("s1", [
      entry("a", "user", "Modifie `src/lib/compact.ts` et README.md"),
      entry("b", "assistant", "```ts\nconst x = 1;\n```"),
      entry("c", "tool", "Approval requested: write src/theme.ts"),
      entry("d", "system", "Decision sent: allow (req-1)"),
    ]);
    assert.equal(recap.total, 4);
    assert.deepEqual(recap.counts, {
      user: 1,
      assistant: 1,
      subagent: 0,
      tool: 1,
      system: 1,
    });
    assert.ok(recap.filesMentioned.includes("src/lib/compact.ts"));
    assert.ok(recap.filesMentioned.includes("README.md"));
    assert.ok(recap.filesMentioned.includes("src/theme.ts"));
    assert.ok(recap.decisions.length >= 2);
  });

  it("dedupes files and handles an empty log", () => {
    const recap = buildThreadRecap("s", [
      entry("a", "user", "touche src/a.ts puis src/a.ts"),
    ]);
    assert.deepEqual(recap.filesMentioned, ["src/a.ts"]);
    const empty = buildThreadRecap("s", []);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.filesMentioned, []);
    assert.deepEqual(empty.decisions, []);
  });
});

describe("artifacts persistence", () => {
  beforeEach(() => {
    fakeStorage();
  });

  it("round-trips artifacts per thread under muse-desktop.* keys", () => {
    assert.deepEqual(loadArtifacts("s1"), []);
    const arts = mergeAssistantBlocks([], "s1", [
      { entryId: "e1", text: "```ts\nconst x = 1;\n```", ts: 10 },
    ]);
    const noted = setVersionComment(arts, arts[0]?.id ?? "", 1, "nb");
    saveArtifacts("s1", noted);
    assert.deepEqual(loadArtifacts("s1"), noted);
    // isolated per thread
    assert.deepEqual(loadArtifacts("s2"), []);
    dropArtifacts("s1");
    assert.deepEqual(loadArtifacts("s1"), []);
  });

  it("rejects corrupt payloads", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => "not json",
      setItem: () => {},
      removeItem: () => {},
    };
    assert.deepEqual(loadArtifacts("s1"), []);
  });
});
