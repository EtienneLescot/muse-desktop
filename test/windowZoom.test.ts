/**
 * M0-12 webview zoom guard: the main window must keep native zoom hotkeys
 * enabled (dogfood 20/09: Ctrl+Plus/Minus/0 and Ctrl+wheel had no effect
 * until `zoomHotkeysEnabled` was set).
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function mainWindowConfig(): { zoomHotkeysEnabled?: unknown } {
  const raw = readFileSync(
    resolve(repoRoot, "src-tauri", "tauri.conf.json"),
    "utf8",
  );
  const conf = JSON.parse(raw) as {
    app?: { windows?: Array<{ zoomHotkeysEnabled?: unknown }> };
  };
  assert.ok(Array.isArray(conf.app?.windows) && conf.app.windows.length > 0);
  return conf.app.windows[0];
}

describe("main window zoom hotkeys", () => {
  it("enables native zoom hotkeys on the main window", () => {
    assert.equal(mainWindowConfig().zoomHotkeysEnabled, true);
  });
});
