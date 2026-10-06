/**
 * Wiring guard for two failures the 05/10/2026 native audits measured
 * (docs/evidence/2026-10-05-roadmap-closure/):
 *
 * - M0-13: a refused MCP probe or bundle on Extensions set the global error,
 *   but the banner was rendered only beside the conversation, so the click
 *   produced nothing visible. The banner must render on Settings and on every
 *   destination page as well.
 * - M2-01: a failed start (a moved project folder) remounts the welcome screen;
 *   the draft survived in session storage but the chosen environment and the
 *   worktree switch fell back to the defaults, so a retry ran elsewhere.
 * - M1-05: after any tab change, the terminal's Close reopened a shell at once;
 *   otherwise it left "Terminal unavailable" with no way to open a new one.
 * - M3-02: a failed remote call disconnected the session, but the "Connected
 *   to …" block stayed on screen beside "Disconnected".
 * - M4-07: a remote conversation with its own Muse path
 *   (`ssh://…/folder?muse=/…/muse-bin-1.3.0`) was titled after the binary.
 * - M0-13: after a refused local MCP probe, a later successful probe or call
 *   still showed the old failure: no connector action cleared the banner.
 * - M0-05: when a host died with the app open, its approval and question
 *   cards stayed answerable, and every answer could only fail.
 * - M0-05: the engine that resumes such a conversation still lists and
 *   re-issues the dead turn's question (1.4.2), so Reconnect brought the card
 *   back, and every answer was refused (-32057, then -32603 after a restart).
 * - M0-05: each question was written twice to the transcript (the host's
 *   userInput/request and its userInput/requested twin).
 * - M2-05: every window.confirm question was skipped in the app: the dialog
 *   plugin's replacement calls a command the plugin no longer has, and its
 *   Promise read as a yes.
 * - M0-13 (06/10/2026, isolated instance): a failed computer-use level change
 *   left the panel on "Granted" with no service running, and its failure
 *   stayed on screen through the next revoke and level change.
 * - M0-13: in a Read only project, "Run in Muse" was offered (1.4.2 still
 *   grants userShell) and the host refused the command after the click; the
 *   composer said nothing. A refused command or tool call closed as an
 *   ordinary collapsed row.
 * - M0-13: a share snapshot of a conversation with no messages created no
 *   bundle and said nothing.
 *
 * Both are layout/lifecycle facts that the pure-logic tests cannot see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isConnectorError } from "../src/lib/errorCopy.ts";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("visible failures", () => {
  it("renders the error banner in the conversation, on Settings and on destination pages", () => {
    const app = read("../src/App.tsx");
    assert.equal(app.match(/className="error-banner"/g)?.length, 1, "one banner definition");
    const uses = app.match(/\{errorBanner\}|: errorBanner\}/g) ?? [];
    assert.equal(uses.length, 3, "conversation + Settings + destination pages");
    const settings = app.indexOf("<h1>Settings</h1>");
    assert.ok(settings > 0 && app.indexOf("{errorBanner}", settings) - settings < 120, "banner right under the Settings title");
    const destination = app.indexOf('className="destination-page"', settings);
    const projects = app.indexOf('page === "projects" && (', destination);
    assert.ok(app.slice(destination, projects).includes("{errorBanner}"), "banner before the destination panels");
  });

  it("keeps the welcome environment and worktree choice with the draft until a start succeeds", () => {
    const screen = read("../src/components/EmptySessionScreen.tsx");
    for (const key of ["welcomeEnvironmentKey", "welcomeWorktreeKey"]) {
      assert.match(screen, new RegExp(`readSessionStorageString\\(${key}\\)`), `${key} restored on mount`);
      assert.match(screen, new RegExp(`writeSessionStorageString\\(${key},`), `${key} written on change`);
      assert.match(screen, new RegExp(`removeSessionStorageKey\\(${key}\\)`), `${key} cleared after a successful start`);
    }
  });

  it("keeps a closed terminal closed and offers to open a new one", () => {
    const panel = read("../src/components/TerminalPanel.tsx");
    assert.match(panel, /if \(terminal\) \{\s*attemptedSession\.current = sessionId;\s*return;\s*\}/, "a mount on a live terminal counts as the attempt");
    assert.match(panel, /<button type="button" onClick=\{open\}>Open terminal<\/button>/, "the empty state opens a new terminal");
    assert.doesNotMatch(panel, /Terminal unavailable/);
  });

  it("shows the remote connection block only while that connector is connected", () => {
    const panel = read("../src/components/ConnectorPanel.tsx");
    assert.match(panel, /\{remoteProbe && remoteConnectedIds\.includes\(remoteId\) && \(/);
    assert.match(panel, /connectorId: remoteId,/, "the call targets the same connector id");
  });

  it("names a remote conversation after its folder, not its Muse path", () => {
    const app = read("../src/App.tsx");
    assert.doesNotMatch(app, /active\.workspace\.split\(/);
    assert.equal(app.match(/folderName\(active\.workspace\)/g)?.length, 2, "breadcrumb and eyebrow");
  });

  it("clears a connector failure when the next connector action starts", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    for (const action of [
      "probeLocalMcp", "callLocalMcp", "registerLocalConnectorByProbe", "installMcpPackage",
      "startLocalMcp", "refreshLocalMcp", "stopLocalMcp", "callRegisteredLocalMcp", "rollbackLocalMcp",
      "installConnectorById", "uninstallConnectorById", "setConnectorEnabledById",
      "setConnectorUseInMuseById", "probeRemoteMcp", "callRemoteMcp",
    ]) {
      const head = `const ${action} = useCallback(`;
      const start = hook.indexOf(head);
      assert.ok(start > 0, `${action} is declared`);
      const body = hook.slice(start, hook.indexOf(" = useCallback(", start + head.length));
      const clear = body.indexOf("clearConnectorError();");
      const acts = body.search(/setError\(|invoke\b|await /);
      assert.ok(clear > 0 && (acts === -1 || clear < acts), `${action} clears before it acts`);
      // Each failure the action raises is one the next action clears.
      for (const [, message] of body.matchAll(/setError\(\s*[`"]([^`"$]*)/g)) {
        assert.ok(isConnectorError(message), `${action}: "${message}" is a connector failure`);
      }
    }
    // Another surface's failure stays on screen.
    for (const other of ["send_input failed: offline", "approve failed: gone", "restore_sessions failed: x", null]) {
      assert.equal(isConnectorError(other), false, String(other));
    }
  });

  it("asks every confirmation through the plugin's OK/Cancel box and waits for it", async () => {
    // M2-05: in the app, window.confirm is the dialog plugin's replacement,
    // which calls a `confirm` command plugin 2.7 no longer has: it always
    // failed, and read without await its Promise counted as a yes. The move,
    // the archive delete and both host restarts ran with no question.
    const sources = (dir: string): string[] =>
      readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? sources(`${dir}${entry.name}/`) : /\.tsx?$/.test(entry.name) ? [`${dir}${entry.name}`] : []);
    let asked = 0;
    for (const file of sources("../src/").filter((f) => !f.endsWith("/lib/env.ts"))) {
      const text = read(file);
      assert.doesNotMatch(text, /window\.confirm\(/, `${file} calls window.confirm`);
      const calls = text.match(/confirmAction\(/g)?.length ?? 0;
      assert.equal(text.match(/await confirmAction\(/g)?.length ?? 0, calls, `${file} awaits confirmAction`);
      asked += calls;
    }
    assert.equal(asked, 4, "the move, the archive delete and both host restarts ask");

    const { confirmAction } = await import("../src/lib/env.ts");
    const calls: unknown[] = [];
    const answers = ["Ok", "Cancel"];
    const host = globalThis as { window?: unknown };
    host.window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: unknown) => (calls.push([cmd, args]), answers.shift()) } };
    try {
      assert.equal(await confirmAction("Move?"), true);
      assert.equal(await confirmAction("Move?"), false);
    } finally {
      delete host.window;
    }
    assert.deepEqual(calls[0], ["plugin:dialog|message", { message: "Move?", title: "Muse-Desktop", kind: "warning", buttons: "OkCancel" }]);
  });

  it("drops an exited host's approval and question cards and says so", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf('if (kind === "host_exited") {');
    const block = hook.slice(start, hook.indexOf('if (kind === "output")', start));
    assert.match(block, /hostExitNotices\(sid, approvals, inputRequests\)/);
    assert.match(block, /setApprovals\(\(cur\) => cur\.filter\(\(a\) => a\.session_id !== sid\)\)/);
    assert.match(block, /setInputRequests\(\(cur\) => cur\.filter\(\(r\) => r\.session_id !== sid\)\)/);
  });

  it("brings back no question or approval of a turn that died with its engine", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf("const reconnectSession = useCallback(");
    const body = hook.slice(start, hook.indexOf("}, [globalSettings", start));
    const guard = body.indexOf("noLiveTurnRef.current.add(id);");
    assert.ok(guard > 0 && guard < body.indexOf('invoke<BackendSessionMeta>("resume_session"'), "guarded before the resume");
    assert.match(body, /if \(meta\.running\) noLiveTurnRef\.current\.delete\(id\);/);
    assert.match(body, /const pending = meta\.running\s*\? await invoke<unknown>\("list_pending_requests"[^)]*\)\s*: \{\};/);
    const events = hook.slice(hook.indexOf("function handleEvent(evt: MuseEvent)"), hook.indexOf('if (kind === "workspace_changed")'));
    assert.match(events, /if \(kind === "started"\) noLiveTurnRef\.current\.delete\(sid\);/);
    assert.match(events, /if \(\(kind === "input_request" \|\| kind === "tool_request"\) && noLiveTurnRef\.current\.has\(sid\)\) return;/);
  });

  it("clears a computer-use failure at the next action and shows the service as it is after one", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    for (const action of ["setComputerLevel", "setComputerAttach", "disableComputerUse"]) {
      const head = `const ${action} = useCallback(`;
      const start = hook.indexOf(head);
      assert.ok(start > 0, `${action} is declared`);
      const body = hook.slice(start, hook.indexOf(" = useCallback(", start + head.length));
      const clear = body.indexOf("clearComputerError();");
      assert.ok(clear > 0 && clear < body.indexOf("invoke<unknown>("), `${action} clears before it acts`);
      const failure = body.slice(body.indexOf("} catch (error) {"));
      assert.match(failure, /setComputerError\(userFacingError\(/, `${action} records its failure as computer use's`);
      assert.match(failure, /await refreshComputerUse\(\);/, `${action} re-reads the service after a failure`);
      assert.doesNotMatch(body, /\bsetError\(/, `${action} raises no failure the next action cannot clear`);
    }
  });

  it("says before the click what a Read only project's host refuses, and marks a refused item", () => {
    const app = read("../src/App.tsx");
    assert.match(app, /const activeRefusal =\s*activeProject === null \? null : postureRefusal\(hostSandboxConfigForProject\(sandbox, activeProjectSettings\)\);/);
    assert.match(app, /runThroughMuseBlocked=\{userShellBlocked\(active\) \?\? activeRefusal\}/, "Run in Muse is off, with the reason");
    const note = app.indexOf("{activeRefusal !== null && (");
    assert.ok(note > 0 && note < app.indexOf("<Composer", note) && app.indexOf("<Composer", note) - note < 400, "the note sits right above the composer");
    const hook = read("../src/hooks/useMuseSessions.ts");
    const done = hook.slice(hook.indexOf('if (kind === "item_done") {'), hook.indexOf("refreshAutoShare(sid);", hook.indexOf('if (kind === "item_done") {')));
    assert.match(done, /failed = itemId !== undefined && obj\.status === "failed";/);
    assert.match(done, /closeOpenBlocks\(sid, itemId, turnId, failed\);/);
    const stream = read("../src/components/StreamView.tsx");
    assert.match(stream, /e\.role === "tool" && e\.failed === true && <strong className="tool-failed">Failed<\/strong>/);
    assert.match(stream, /<details className="tool-call" open=\{e\.failed === true\}>/);
  });

  it("says why a share snapshot created nothing", () => {
    const panel = read("../src/components/SharePanel.tsx");
    assert.equal(panel.match(/onClick=\{\(\) => snapshot\("(?:markdown|json)"\)\}/g)?.length, 2, "both snapshot buttons");
    assert.match(panel, /const created = onShareSession\(activeSessionId, format\);/);
    assert.match(panel, /"Nothing to snapshot: this conversation has no messages yet\."/);
    assert.match(panel, /role="status">\{snapshotRefusal\}/);
  });

  it("writes one transcript line per question, though the host delivers it twice", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf('if (kind === "input_request") {');
    const block = hook.slice(start, hook.indexOf('if (kind === "input_settled")', start));
    const known = block.indexOf("if (loggedInputsRef.current.has(logged)) return;");
    assert.ok(known > 0 && known < block.indexOf("Input requested:"), "a question already written returns before its line");
  });
});
