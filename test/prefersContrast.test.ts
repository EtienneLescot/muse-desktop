/**
 * Structural guard for the `prefers-contrast: more` block in `src/App.css`.
 *
 * The block is position-sensitive: at equal specificity, the later declaration
 * wins. It used to sit around line 2837, before the component styles, where
 * `.project-group-header { color: var(--muted) }` -- declared later -- beat its
 * `.muted { color: var(--text) }`. The rule was therefore inert on the sidebar
 * group headers: measured `rgb(146, 162, 173)` with and without the media
 * active. Moving the block to the end of the stylesheet fixed it, measured at
 * `rgb(233, 239, 243)` against the running application.
 *
 * Nothing in the build enforces that position, so this test does: it fails if a
 * rule that can override `.muted` is declared after the media block.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_CSS = new URL("../src/App.css", import.meta.url);
const MEDIA_QUERY = "@media (prefers-contrast: more)";

type Rule = { selector: string; start: number; inMedia: string | null; color: string | null };

/**
 * Locate every style rule with a brace-counting scan, remembering the enclosing
 * at-rule for each. Comments are stripped first so braces inside them cannot
 * skew the depth.
 */
function styleRules(source: string): Rule[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const atRuleStack: { name: string; depth: number }[] = [];
  let depth = 0;
  let header = "";
  let pending: { selector: string; bodyStart: number; depth: number } | null = null;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{") {
      depth += 1;
      const trimmed = header.trim();
      if (trimmed.startsWith("@")) {
        atRuleStack.push({ name: trimmed, depth });
      } else if (trimmed) {
        pending = { selector: trimmed, bodyStart: index + 1, depth };
      }
      header = "";
      continue;
    }
    if (char === "}") {
      if (pending && pending.depth === depth) {
        const body = code.slice(pending.bodyStart, index);
        const color = body.match(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/);
        const enclosing = atRuleStack.filter((entry) => entry.depth < pending.depth).pop();
        rules.push({
          selector: pending.selector,
          start: pending.bodyStart,
          inMedia: enclosing ? enclosing.name : null,
          color: color ? color[1].trim() : null,
        });
        pending = null;
      }
      while (atRuleStack.length && atRuleStack[atRuleStack.length - 1].depth === depth) atRuleStack.pop();
      depth -= 1;
      header = "";
      continue;
    }
    if (char === ";" && depth === 0) {
      header = "";
      continue;
    }
    header += char;
  }
  return rules;
}

describe("prefers-contrast block position", () => {
  const source = readFileSync(APP_CSS, "utf8");
  const rules = styleRules(source);

  it("declares exactly one prefers-contrast block", () => {
    const occurrences = source.split(MEDIA_QUERY).length - 1;
    assert.equal(occurrences, 1, `expected one ${MEDIA_QUERY} block, found ${occurrences}`);
  });

  it("keeps `.muted` in that block targeting the main text colour", () => {
    const muted = rules.find((rule) => rule.inMedia === MEDIA_QUERY && rule.selector === ".muted");
    assert.ok(muted, "the prefers-contrast block no longer sets .muted");
    assert.equal(muted.color, "var(--text)");
  });

  it("declares the block after every rule that can override .muted", () => {
    // A plain single-class rule declared later wins at equal specificity. The
    // earlier failure was exactly that: `.project-group-header` after `.muted`.
    const contrast = rules.find((rule) => rule.inMedia === MEDIA_QUERY && rule.selector === ".muted");
    assert.ok(contrast, "missing the .muted rule inside the media block");

    const laterOverriders = rules.filter(
      (rule) =>
        rule.inMedia === null &&
        rule.color === "var(--muted)" &&
        rule.start > contrast.start &&
        !/[\s>+~]/.test(rule.selector) &&
        /^[.#]/.test(rule.selector),
    );

    assert.deepEqual(
      laterOverriders.map((rule) => rule.selector),
      [],
      `declared after the prefers-contrast block, these can override it: ${laterOverriders
        .map((rule) => rule.selector)
        .join(", ")}. Move the block to the end of src/App.css.`,
    );
  });
});
