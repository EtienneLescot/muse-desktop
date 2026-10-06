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

  it("attaches a branch to its source's project", () => {
    // Unattached, a branch of a read-only project resumed at the global posture.
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf("const forkSession = useCallback(");
    const body = hook.slice(start, hook.indexOf(" = useCallback(", start + 30));
    assert.match(body, /const sourceProject = threadProjectsRef\.current\[sourceId\];/);
    assert.match(body, /attachThreadRow\(threadProjectsRef\.current, projectsRef\.current, meta\.session_id, sourceProject\)/);
    assert.ok(body.indexOf("setThreadProjects(next)") > 0, "the attachment is kept");
  });

  it("records the folder a reconnect resumed, for the banner's restart", () => {
    // A moved conversation resumed on its host's folder while the banner kept
    // the other one, so "Restart workspace host" restarted the wrong folder.
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf("const reconnectSession = useCallback(");
    const body = hook.slice(start, hook.indexOf('invoke<BackendSessionMeta>("resume_session"', start) + 200);
    assert.match(body, /const resumedFolder = session\.host_workspace \?\? session\.workspace;/);
    assert.match(body, /host = \{ workspace: resumedFolder, sandbox: sandboxConfig \};/);
    assert.match(body, /workspacePath: resumedFolder,/);
  });

  it("speaks of one global level, with no dead defaults editor nor g: hint", () => {
    // "Grant it to a workspace you trust" read as a per-workspace grant.
    const settings = read("../src/components/SettingsPanel.tsx");
    assert.doesNotMatch(settings, /Grant it to a workspace you trust/);
    assert.match(settings, /It reaches every project that does not restrict it\./);
    const panel = read("../src/components/ProjectsPanel.tsx");
    assert.doesNotMatch(panel, /project-global|onSetGlobal|hideGlobalSettings/, "the hidden defaults editor drove nothing");
    assert.doesNotMatch(panel, / g:/);
    assert.match(panel, /<small> Default: \{formatSetting\(settingKey, globalValue\)\}<\/small>/);
  });
});
