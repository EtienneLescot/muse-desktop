/**
 * Wiring guard for project isolation (M0-06, decision of 06/10/2026: a
 * project follows the Isolation level of Settings unless its own preferences
 * restrict it). The rule itself is tested in settings.test.ts; these lock the
 * call sites a review of 06/10 found reading the wrong value.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectOfFolder, type Project } from "../src/lib/projects.ts";

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
    assert.match(body, /host = \{ workspace: resumedFolder, sandbox: sandboxConfig(, projectId: [^}]+)? \};/);
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

  it("restarts a project's folder and retries a project's start with that project's request", () => {
    // Settings' restart applied the global posture to a folder a project owns,
    // and the sidecar panel's Retry started in the default folder, no project.
    const projects: Project[] = [{ id: "p", name: "p", createdAt: 1, workspace: "G:\\work\\proj", settings: { sandbox: "read-only" } }];
    assert.equal(projectOfFolder(projects, "\\\\?\\G:\\work\\proj\\")?.id, "p", "native spelling");
    assert.equal(projectOfFolder(projects, "g:/WORK/proj")?.id, "p", "separators and case");
    assert.equal(projectOfFolder(projects, "G:\\work\\other"), undefined);
    const hook = read("../src/hooks/useMuseSessions.ts");
    const restart = hook.slice(hook.indexOf("const restartHost = useCallback("), hook.indexOf("const projectPosture = useCallback("));
    assert.match(restart, /requested \?\? hostSandboxConfigForProject\(sandbox, projectOfFolder\(projects, target\)\)/);
    assert.match(hook, /host = \{ workspace: ws, sandbox: sandboxConfig, projectId: project\?\.id \};/);
    const app = read("../src/App.tsx");
    const retry = app.slice(app.indexOf("onRetry={() => {"), app.indexOf("onPickWorkspace={setWorkspace}"));
    assert.match(retry, /const failed = errorHost;/);
    assert.match(retry, /startSessionInWorkspace\(\s*failed\.workspace,[\s\S]*failed\.projectId,\s*\)/);
  });
});
