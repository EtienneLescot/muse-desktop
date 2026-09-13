/**
 * US-18 @-mentions: parsing, workspace resolution, scope fallback, and
 * enriched send payload. Pure helpers from src/lib/mentions.ts.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnrichedText,
  findMentionAt,
  interpretScopeVerdict,
  outOfScopeMessage,
  parseMentions,
  resolveMention,
  resolveMentions,
} from "../src/lib/mentions.ts";

const ROOT = "/home/etienne/proj";

describe("parseMentions", () => {
  it("finds a single mention with offsets", () => {
    const ts = parseMentions("look at @src/app.ts please");
    assert.equal(ts.length, 1);
    assert.equal(ts[0].query, "src/app.ts");
    assert.equal("look at @src/app.ts please".slice(ts[0].start, ts[0].end), "@src/app.ts");
  });

  it("finds several mentions in order", () => {
    const queries = parseMentions("@a.ts and @b/c.ts").map((t) => t.query);
    assert.deepEqual(queries, ["a.ts", "b/c.ts"]);
  });

  it("ignores email-like user@host", () => {
    assert.deepEqual(parseMentions("mail me at bob@example.com"), []);
  });

  it("keeps a trailing lone @ as an empty (typing) query", () => {
    const ts = parseMentions("see @");
    assert.equal(ts.length, 1);
    assert.equal(ts[0].query, "");
  });

  it("ignores a lone @ mid-text", () => {
    assert.deepEqual(parseMentions("a @ b"), []);
  });

  it("accepts . .. ~ + - inside queries", () => {
    const queries = parseMentions("@../up.ts @~/x @a-b_c+d").map((t) => t.query);
    assert.deepEqual(queries, ["../up.ts", "~/x", "a-b_c+d"]);
  });
});

describe("findMentionAt", () => {
  it("returns the token under the caret", () => {
    const text = "fix @src/a.ts now";
    const t = findMentionAt(text, 8);
    assert.ok(t);
    assert.equal(t.query, "src/a.ts");
  });

  it("matches at the token end (caret just after)", () => {
    const text = "fix @src/a.ts";
    const t = findMentionAt(text, text.length);
    assert.ok(t);
    assert.equal(t.query, "src/a.ts");
  });

  it("returns null outside any token", () => {
    assert.equal(findMentionAt("fix @src/a.ts now", 0), null);
    assert.equal(findMentionAt("plain text", 3), null);
  });
});

describe("resolveMention", () => {
  it("roots relative queries at the workspace", () => {
    const m = resolveMention(ROOT, "src/app.ts");
    assert.equal(m.absPath, "/home/etienne/proj/src/app.ts");
    assert.equal(m.relPath, "src/app.ts");
    assert.equal(m.inScope, true);
  });

  it("flags .. escapes as out of scope", () => {
    const m = resolveMention(ROOT, "../secret.txt");
    assert.equal(m.absPath, "/home/etienne/secret.txt");
    assert.equal(m.inScope, false);
  });

  it("flags absolute paths outside the root as out of scope", () => {
    const m = resolveMention(ROOT, "/etc/passwd");
    assert.equal(m.inScope, false);
    assert.equal(m.absPath, "/etc/passwd");
  });

  it("keeps absolute paths inside the root in scope", () => {
    const m = resolveMention(ROOT, "/home/etienne/proj/src/x.ts");
    assert.equal(m.inScope, true);
    assert.equal(m.relPath, "src/x.ts");
  });

  it("treats ~/ paths as out of scope", () => {
    const m = resolveMention(ROOT, "~/notes.md");
    assert.equal(m.inScope, false);
  });

  it("normalizes ./ and redundant separators", () => {
    const m = resolveMention(ROOT, "./src//a.ts");
    assert.equal(m.absPath, "/home/etienne/proj/src/a.ts");
    assert.equal(m.inScope, true);
  });

  it("rejects prefix-sibling roots (/proj-evil is not /proj)", () => {
    const m = resolveMention(ROOT, "/home/etienne/proj-evil/x.ts");
    assert.equal(m.inScope, false);
  });
});

describe("resolveMentions", () => {
  it("keeps token offsets", () => {
    const text = "see @a.ts";
    const ms = resolveMentions(ROOT, text);
    assert.equal(ms.length, 1);
    assert.equal(text.slice(ms[0].start, ms[0].end), "@a.ts");
    assert.equal(ms[0].absPath, "/home/etienne/proj/a.ts");
  });
});

describe("buildEnrichedText", () => {
  it("replaces in-scope mentions with backticked absolute paths", () => {
    const { text, mentions } = buildEnrichedText(ROOT, "read @src/a.ts!");
    assert.equal(text, "read `/home/etienne/proj/src/a.ts`!");
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].inScope, true);
  });

  it("leaves out-of-scope tokens verbatim", () => {
    const { text, mentions } = buildEnrichedText(ROOT, "read @/etc/passwd");
    assert.equal(text, "read @/etc/passwd");
    assert.equal(mentions[0].inScope, false);
  });

  it("passes text without mentions through untouched", () => {
    const { text, mentions } = buildEnrichedText(ROOT, "hello world");
    assert.equal(text, "hello world");
    assert.deepEqual(mentions, []);
  });
});

describe("interpretScopeVerdict", () => {
  it("accepts boolean true", () => {
    assert.equal(interpretScopeVerdict(true), true);
    assert.equal(interpretScopeVerdict(false), false);
  });

  it("accepts grant strings case-insensitively", () => {
    assert.equal(interpretScopeVerdict("allow"), true);
    assert.equal(interpretScopeVerdict("Granted"), true);
    assert.equal(interpretScopeVerdict("deny"), false);
  });

  it("reads the US-22 object shape without truthy-object confusion", () => {
    assert.equal(interpretScopeVerdict({ in_scope: true }), true);
    assert.equal(interpretScopeVerdict({ in_scope: false }), false);
    assert.equal(interpretScopeVerdict({ inScope: false }), false);
  });

  it("fails closed on unknown shapes", () => {
    assert.equal(interpretScopeVerdict(null), false);
    assert.equal(interpretScopeVerdict(undefined), false);
    assert.equal(interpretScopeVerdict({ unexpected: 1 }), false);
    assert.equal(interpretScopeVerdict(42), false);
  });
});

describe("outOfScopeMessage", () => {
  it("names the blocked paths", () => {
    const { mentions } = buildEnrichedText(ROOT, "x @/etc/a @../b");
    const msg = outOfScopeMessage(mentions);
    assert.match(msg, /\/etc\/a/);
    assert.match(msg, /blocked/);
  });
});
