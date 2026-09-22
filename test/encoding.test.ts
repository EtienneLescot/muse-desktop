import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard: no source file may carry a cp1252 round-trip artefact.
 *
 * The damage is easy to produce and hard to see. A UTF-8 file read through
 * Windows PowerShell's default ANSI decoder — `Get-Content -Raw` — then written
 * back as UTF-8 turns every non-ASCII character into a lead byte followed by the
 * cp1252 character for the next byte. An em dash, an ellipsis, a right arrow and
 * a fullwidth plus each become two or three such characters, and the result
 * still parses, still builds, and still passes every other test. It reached the
 * shipped UI: the composer placeholder on the welcome screen and the Attach
 * glyph were unreadable, and 126 further lines across eight files were mangled
 * by repeated rewrites.
 *
 * The signal is a lead byte *immediately followed by a non-ASCII character*,
 * which no French or English sentence produces — `l'écran d'accueil` and
 * `déjà choisie` are untouched. Fixtures are written as escapes so this file
 * never contains the artefact it forbids.
 */
const LEADS =
  "\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf" +
  "\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de" +
  "\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec" +
  "\u00ed\u00ee\u00ef";
const MOJIBAKE = new RegExp(`[${LEADS}][^\\x00-\\x7F]`);

/** This file names the artefact in its own fixtures, so it is not scanned. */
const SELF = "encoding.test.ts";
const ROOTS = ["src", "test", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".css", ".mjs", ".json", ".html"];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name === SELF) continue;
    const path = join(entry.parentPath ?? root, entry.name);
    if (EXTENSIONS.some((extension) => path.endsWith(extension))) found.push(path);
  }
  return found;
}

describe("source encoding", () => {
  it("recognizes the artefact and leaves real text alone", () => {
    // Pinned so a future edit cannot loosen the pattern into something that
    // never matches: the mojibake of an em dash, an ellipsis, a right arrow and
    // a fullwidth plus.
    assert.ok(MOJIBAKE.test("\u00e2\u20ac\u201d"), "em dash");
    assert.ok(MOJIBAKE.test("\u00e2\u20ac\u00a6"), "ellipsis");
    assert.ok(MOJIBAKE.test("\u00e2\u2020\u2019"), "right arrow");
    assert.ok(MOJIBAKE.test("\u00ef\u00bc\u2039"), "fullwidth plus");
    assert.ok(MOJIBAKE.test("\u00c3\u00a9"), "e acute");
    // Real text, including accents and the glyphs themselves.
    assert.ok(!MOJIBAKE.test("Runs in openscreen — the agent reads that folder's rules."));
    assert.ok(!MOJIBAKE.test("l'écran d'accueil, déjà choisie, où l'utilisateur écrit"));
    assert.ok(!MOJIBAKE.test("→ ↗ ✓ · … ＋"));
  });

  it("finds no cp1252 round-trip artefact in the sources", () => {
    const damaged: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (MOJIBAKE.test(line)) damaged.push(`${file}:${index + 1}  ${line.trim().slice(0, 80)}`);
          });
      }
    }
    assert.deepEqual(
      damaged,
      [],
      "these lines were written through a cp1252 round-trip; repair the text, and read sources with an explicit UTF-8 encoding",
    );
  });
});
