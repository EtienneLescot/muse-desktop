/**
 * Persistent theme helpers (src/lib/theme.ts): the stored choice wins, the
 * OS preference is the fallback, and only "light"/"dark" are accepted.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_KEY,
  nextTheme,
  parseTheme,
  resolveTheme,
} from "../src/lib/theme.ts";

describe("theme persistence", () => {
  it("uses a stable storage key", () => {
    assert.equal(THEME_KEY, "muse-desktop.theme.v1");
  });

  it("accepts only light/dark stored values", () => {
    assert.equal(parseTheme("light"), "light");
    assert.equal(parseTheme("dark"), "dark");
    assert.equal(parseTheme(null), null);
    assert.equal(parseTheme(undefined), null);
    assert.equal(parseTheme(""), null);
    assert.equal(parseTheme("DARK"), null);
    assert.equal(parseTheme("system"), null);
  });

  it("prefers the stored choice over the OS preference", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("falls back to the OS preference when nothing valid is stored", () => {
    assert.equal(resolveTheme(null, true), "dark");
    assert.equal(resolveTheme(null, false), "light");
    assert.equal(resolveTheme("garbage", true), "dark");
    assert.equal(resolveTheme(undefined, false), "light");
  });

  it("toggles between light and dark", () => {
    assert.equal(nextTheme("light"), "dark");
    assert.equal(nextTheme("dark"), "light");
  });
});
