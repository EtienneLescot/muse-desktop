/**
 * Contrast guard for the palette tokens in `src/App.css`.
 *
 * The light theme shipped `--muted: #78828a`, which measured **3.62:1** on the
 * sidebar background (`--side`, `#f5f6f8`) and **3.92:1** on a white surface —
 * below the 4.5:1 WCAG AA requires for body text. It affected the whole sidebar
 * navigation, the section labels, the status bar and the transcript metadata,
 * because they all resolve to that one token. The dark theme was already fine.
 *
 * Nothing in the build checks contrast, so this test does: it resolves the
 * tokens from the stylesheet and computes the real ratios. A future palette
 * tweak that drops secondary text below AA fails here instead of shipping, and
 * — like the `prefers-contrast` guard next to it — the numbers are recorded in
 * the failure message so the fix is obvious.
 *
 * `scripts/ux-contrast-audit.mjs` measures the *rendered* application, which
 * catches cases this test cannot (composited colours, inherited backgrounds).
 * This one runs in CI, where no application is available.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_CSS = new URL("../src/App.css", import.meta.url);
const AA_BODY = 4.5;

/**
 * Read the body of one style rule by balancing braces, ignoring braces inside
 * comments and strings.
 *
 * A plain `indexOf("body.dark")` is not enough: the marker also appears in the
 * file's header comment ("Dark palette switches through the `body.dark` class"),
 * which put the split *before* the light palette and made every light token read
 * as missing.
 */
function ruleBody(source: string, selector: string): string | null {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = code.indexOf(selector);
  if (start < 0) return null;
  const open = code.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, index);
    }
  }
  return null;
}

/** Parse `--name: value;` declarations out of one CSS block's text. */
function tokensIn(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

/** The light palette lives in `:root`, the dark one in `body.dark`. */
function palettes(source: string): { light: Record<string, string>; dark: Record<string, string> } {
  const root = ruleBody(source, ":root");
  const dark = ruleBody(source, "body.dark");
  assert.ok(root, "the light palette block `:root` is gone from src/App.css");
  assert.ok(dark, "the dark palette block `body.dark` is gone from src/App.css");
  return { light: tokensIn(root), dark: tokensIn(dark) };
}

function expand(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `not a 6-digit hex colour: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio between two opaque colours. */
function contrast(foreground: string, background: string): number {
  const a = luminance(expand(foreground));
  const b = luminance(expand(background));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const round = (value: number): number => Math.round(value * 100) / 100;

describe("palette contrast", () => {
  const source = readFileSync(APP_CSS, "utf8");
  const { light, dark } = palettes(source);

  it("resolves the tokens it needs in both themes", () => {
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["bg", "side", "surface", "text", "muted"]) {
        assert.ok(tokens[name], `the ${theme} palette no longer declares --${name}`);
      }
    }
  });

  for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
    /**
     * Secondary text sits on any of the three surfaces depending on the region,
     * so it has to clear AA on the worst of them — the lightest, for a light
     * theme, and the darkest otherwise. Checking only one surface is how the
     * original defect hid: it passed on white and failed on the sidebar.
     */
    it(`${theme}: secondary text (--muted) clears AA on every surface`, () => {
      const surfaces = ["bg", "side", "surface"] as const;
      const measured = surfaces.map((name) => ({
        surface: `--${name} (${tokens[name]})`,
        ratio: round(contrast(tokens.muted, tokens[name])),
      }));
      const worst = measured.reduce((a, b) => (a.ratio <= b.ratio ? a : b));

      assert.ok(
        worst.ratio >= AA_BODY,
        `--muted (${tokens.muted}) reaches only ${worst.ratio}:1 on ${worst.surface}, ` +
          `below the ${AA_BODY}:1 WCAG AA floor for body text. ` +
          `All surfaces: ${measured.map((m) => `${m.surface} = ${m.ratio}:1`).join(", ")}. ` +
          `Darken --muted in the ${theme} palette until the worst surface clears ${AA_BODY}:1.`,
      );
    });

    it(`${theme}: primary text (--text) clears AA comfortably`, () => {
      for (const name of ["bg", "side", "surface"] as const) {
        const ratio = contrast(tokens.text, tokens[name]);
        assert.ok(
          ratio >= AA_BODY,
          `--text (${tokens.text}) is only ${round(ratio)}:1 on --${name} (${tokens[name]})`,
        );
      }
    });

    it(`${theme}: borders (--line) stay visible without competing with text`, () => {
      // A border does not have to meet AA, but an invisible one is a defect and
      // one as strong as the text makes the layout noisy. 1.1:1 is the floor a
      // hairline needs to be perceivable at all.
      for (const name of ["bg", "side"] as const) {
        const ratio = contrast(tokens.line, tokens[name]);
        assert.ok(
          ratio >= 1.1,
          `--line (${tokens.line}) is invisible against --${name} (${tokens[name]}): ${round(ratio)}:1`,
        );
        assert.ok(
          ratio < AA_BODY,
          `--line (${tokens.line}) is as strong as text against --${name}: ${round(ratio)}:1`,
        );
      }
    });
  }
});
