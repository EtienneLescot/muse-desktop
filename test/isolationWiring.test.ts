/**
 * Wiring guard for project isolation (M0-06, decision of 06/10/2026: a
 * project follows the Isolation level of Settings unless its own preferences
 * restrict it). The rule itself is tested in settings.test.ts; these lock the
 * call sites a review of 06/10 found reading the wrong value.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("project isolation wiring", () => {
  it("labels Follow Settings with the level each project really runs at", () => {
    // Read only with Network on Follow Settings showed "(Elevated access)"
    // while the engine ran Workspace only.
    const panel = read("../src/components/ProjectsPanel.tsx");
    assert.match(panel, /isolationLabel=\{sandboxModeLabel\(hostSandboxConfigForProject\(sandbox, p\)\.mode\)\}/);
    assert.match(panel, /a running\s+engine keeps its posture until it restarts/);
  });
});
