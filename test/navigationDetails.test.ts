/**
 * Wiring guard for the platform-aware navigation details (M0-11).
 *
 * `src/lib/a11y.ts` exports `primaryModifier()` and `zoomShortcutTitle()`, and
 * `src/lib/paths.ts` exports `displayPath()`. Their *behaviour* is covered by
 * `test/a11y.test.ts` and the error copy by `test/errorCopy.test.ts`.
 *
 * What none of those check is that the interface actually **calls** them. A
 * component could hard-code `Ctrl` in a tooltip, or print a raw native path,
 * and every existing test would still pass. This test locks the call sites that
 * the roadmap's M0-11 entry depends on.
 *
 * Add a call site here when a new surface starts presenting a shortcut hint or a
 * workspace path.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

/** Each entry: the file that must call the helper, and the helper it must call. */
const requiredCallSites: { file: string; call: string; why: string }[] = [
  {
    file: "../src/App.tsx",
    call: "primaryModifier()",
    why: "the composer shortcut hint must follow the OS, not a hard-coded Ctrl",
  },
  {
    file: "../src/App.tsx",
    call: "zoomShortcutTitle()",
    why: "the brand tooltip documents the zoom shortcut and is OS-dependent",
  },
  {
    file: "../src/App.tsx",
    call: "displayPath(",
    why: "the workspace path shown to the user must be the readable native form",
  },
  {
    file: "../src/components/SessionSidebar.tsx",
    call: "primaryModifier()",
    why: "the sidebar shortcut hint switches conversations and is OS-dependent",
  },
  {
    file: "../src/components/InputPanel.tsx",
    call: "primaryModifier()",
    why: "the send-answer tooltip advertises Cmd+Enter on Apple platforms",
  },
];

describe("platform-aware navigation details", () => {
  for (const { file, call, why } of requiredCallSites) {
    it(`${file} calls ${call}`, () => {
      assert.ok(
        read(file).includes(call),
        `${file} no longer calls ${call} — ${why}`,
      );
    });
  }

  it("imports the helpers instead of re-declaring them locally", () => {
    // A local copy would drift from the tested implementation.
    for (const { file, call } of requiredCallSites) {
      const source = read(file);
      const name = call.replace(/\($/, "").replace(/\(\)$/, "");
      assert.equal(
        new RegExp(`function\\s+${name}\\b`).test(source),
        false,
        `${file} declares its own ${name}; import it from src/lib instead`,
      );
    }
  });

  it("keeps the error copy centralised in src/lib/errorCopy.ts", () => {
    // The OSS surfaces that report failures must route through the shared
    // formatter, which is the one tested by test/errorCopy.test.ts.
    const surfaces = [
      "../src/components/Composer.tsx",
      "../src/components/FilesPanel.tsx",
      "../src/components/ProjectsPanel.tsx",
      "../src/components/SettingsPanel.tsx",
      "../src/components/SidecarErrorPanel.tsx",
      "../src/components/WindowControls.tsx",
    ];
    for (const file of surfaces) {
      assert.ok(
        read(file).includes("userFacingError("),
        `${file} no longer routes its failures through userFacingError`,
      );
    }
  });
});
