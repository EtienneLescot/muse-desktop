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
 * - M0-05: a double-click on Send answer answered twice; the host refused
 *   the second answer and the banner said the answer had failed.
 * - M0-05: a question left open when the app closed left no line after the
 *   restart, where an approval said it was cancelled.
 * - M0-05: after that restart, the conversation stayed "Muse may still be
 *   working": 1.4.2 replays the cancelled turn's items after the resume.
 * - M0-05: a window reload or a restart while a question waited lost its
 *   "Input requested" line: on screen, never in the stored log.
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
 * - M3-02 (06/10/2026, isolated instance, local bearer server): a probe under
 *   the connector's name to another URL, token field empty, sent the stored
 *   bearer there and marked the working entry in error; Reconnect after
 *   Forget token read "rejected or expired" though no token was sent; a
 *   session the server ended (404) disconnected instead of starting a new
 *   one; the panel said the bearer "stays in memory" while Credential
 *   Manager held it.
 *
 * Both are layout/lifecycle facts that the pure-logic tests cannot see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isConnectorError } from "../src/lib/errorCopy.ts";
import { statusLogText } from "../src/lib/statusLog.ts";

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
    assert.equal(asked, 5, "the move, the archive delete, both host restarts and the posture restart ask");

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
    // M0-13 check: from the posture the running host was started with, not the
    // project's current settings, which only a restart applies.
    assert.match(app, /const activePosture = active === null\s*\? null\s*: hostPostureNotice\(\s*hostSandboxForSession\(active\.session_id\),\s*hostSandboxConfigForProject\(sandbox, activeProject\),\s*\);/);
    assert.match(app, /runThroughMuseBlocked=\{userShellBlocked\(active\) \?\? activePosture\?\.blocked \?\? null\}/, "Run in Muse is off, with the reason");
    const note = app.indexOf("{activePosture?.note != null && (");
    assert.ok(note > 0 && note < app.indexOf("<Composer", note) && app.indexOf("<Composer", note) - note < 1200, "the note sits right above the composer");
    assert.match(app.slice(note, app.indexOf("<Composer", note)), /activePosture\.restart && \([\s\S]*reconnectSession\(active\.session_id, \{ reload: true \}\)/, "a changed posture offers the restart that applies it");
    const hostSide = read("../src/hooks/useMuseSessions.ts");
    for (const at of ["const meta = await invoke<BackendSessionMeta>(\"start_session\"", "const meta = await invoke<BackendSessionMeta>(\"resume_session\""]) {
      const from = hostSide.indexOf(at);
      assert.ok(from > 0, at);
      assert.match(hostSide.slice(from, from + 1600), /setHostSandboxBySession\(\(cur\) => \(\{ \.\.\.cur, \[(meta\.session_id|id)\]: meta\.sandbox \}\)\);/, `${at} records the host's posture`);
    }
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

  it("sends one answer per question card, however often it is pressed", () => {
    // M0-05: a double-click on Send answer (or Ctrl+Enter twice) answered
    // twice; the host refused the second answer and the banner said it failed.
    const panel = read("../src/components/InputPanel.tsx").replaceAll("\r\n", "\n");
    for (const action of ["submit();", "onSkip(request.session_id, request.input_id);\n"]) {
      const click = panel.lastIndexOf("onClick={(e) => {", panel.lastIndexOf(action));
      assert.ok(click > 0, `${action.trim()} is a button's click`);
      assert.match(panel.slice(click), /^onClick=\{\(e\) => \{\s*if \(e\.detail > 1\) return;/, `${action.trim()}: a double-click acts once`);
    }
    const hook = read("../src/hooks/useMuseSessions.ts");
    for (const [name, command] of [["answerInput", "answer_input"], ["cancelInput", "cancel_input"]]) {
      const start = hook.indexOf(`const ${name} = useCallback(`);
      const body = hook.slice(start, hook.indexOf(" = useCallback(", start + 30));
      const once = body.indexOf("if (answeredInputsRef.current.has(key)) return;");
      assert.ok(once > 0 && once < body.indexOf("answeredInputsRef.current.add(key);"), `${name}: a question answered or being answered is not sent again`);
      assert.ok(body.indexOf("answeredInputsRef.current.add(key);") < body.indexOf(`invoke("${command}"`), `${name}: marked before the call`);
      // Released only when the host refuses: the card stays for a corrected answer.
      assert.match(body, /catch \(e\) \{\s*answeredInputsRef\.current\.delete\(key\);/, `${name}: released on refusal`);
    }
  });

  it("keeps a conversation resumed with no turn idle while the engine replays the dead turn's items", () => {
    // M0-05: after a restart with a question pending, the resume reported the
    // turn cancelled, then 1.4.2 replayed its in-flight items: the
    // conversation stayed "Muse may still be working", with Stop and Guide.
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf("if (isItemStartKind(kind)) {");
    const block = hook.slice(start, hook.indexOf("ensurePlaceholder(sid, itemId, agentId, itemRole", start));
    assert.match(block, /if \(\(itemRole !== "tool" \|\| modelToolCall\) && !noLiveTurnRef\.current\.has\(sid\)\) \{\s*setSessions\(/);
  });

  it("stores a log line once its update is applied, after any whole-log save queued before it", () => {
    // M0-05: the question's line was appended to the stored log, then
    // overwritten by an item update queued earlier in the same poll; a
    // reload or a restart while the question waited lost it.
    const hook = read("../src/hooks/useMuseSessions.ts");
    const start = hook.indexOf("function pushLog(sessionId: string, entries: LogEntry[]): void {");
    const body = hook.slice(start, hook.indexOf("appendLog(sessionId, entries);", start));
    assert.match(body, /setLogs\(\(cur\) => \{\s*const next = \[\.\.\.\(cur\[sessionId\] \?\? \[\]\), \.\.\.entries\];\s*saveLog\(sessionId, next\);/);
  });

  it("says a question left open when the app closed was cancelled, as for an approval", () => {
    // M0-05: the boot line covered approvals only.
    assert.equal(statusLogText("input_cancelled_by_restart"), "Input cancelled: Muse closed before you answered.");
    const hook = read("../src/hooks/useMuseSessions.ts");
    assert.match(hook, /savePendingCardSessions\("input", inputRequests\.map\(\(r\) => r\.session_id\)\)/, "open questions are written for the next boot");
    const start = hook.indexOf('await invoke<BackendSessionMeta[]>("restore_sessions")');
    const boot = hook.slice(start, hook.indexOf("connectedRestoredIds(restored)", start));
    assert.match(boot, /for \(const kind of \["approval", "input"\] as const\)/, "the boot reads both kinds");
    assert.match(boot, /statusLogText\(`\$\{kind\}_cancelled_by_restart`\)/);
  });

  it("keeps a remote connector's stored bearer with its URL and says what happened to it", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    const probe = hook.slice(hook.indexOf("const probeRemoteMcp = useCallback("), hook.indexOf("const callRemoteMcp = useCallback("));
    // F7: refused before any request.
    const refused = probe.indexOf("const tooLong = token.trim() ? bearerTokenProblem(endpoint, token) : null;");
    assert.ok(refused > 0 && refused < probe.indexOf("probeRemoteMcpTransport("), "a token no store or header can take is refused up front");
    assert.match(probe, /if \(tooLong !== null\) return null;/);
    // F1: stored with its URL, read for that URL only.
    assert.match(probe, /const stored = storedBearerFor\(await invoke<string \| null>\("secure_store_get", \{ key \}\), endpoint\);/, "re-read for the URL it was saved with only");
    assert.match(probe, /if \(token\.trim\(\) && isTauriRuntime\(\)\) \{\s*try \{\s*await invoke\("secure_store_set", \{ key, secret: encodeStoredBearer\(endpoint, token\) \}\);/, "a typed token is saved with its URL");
    const failedSave = probe.slice(probe.indexOf("secret: encodeStoredBearer("), probe.indexOf("return result;"));
    assert.match(failedSave, /\} catch \{[\s\S]*const removed = await invoke\("secure_store_remove", \{ key \}\)\.then\(\(\) => true, \(\) => false\);/, "a failed save drops what stays stored");
    assert.doesNotMatch(probe, /reconnect after restart will require the token again/, "the notice says what Reconnect can still do");
    assert.match(probe, /\} else if \(!effectiveToken\.trim\(\) && existing\?\.kind === "remote" && existing\.url !== endpoint && isTauriRuntime\(\)\) \{[^}]*secure_store_remove/, "moved without a token: the old bearer goes");
    assert.match(probe, /entry\.id === id && entry\.kind === "remote" && entry\.url === endpoint/, "a failed probe of another URL leaves the entry");
    assert.match(probe, /const message = remoteMcpFailureMessage\(.*, effectiveToken, noToken\);/, "a refusal without a token says so, and why");
    const call = hook.slice(hook.indexOf("const callRemoteMcp = useCallback("), hook.indexOf("const setSkillEnabledByName"));
    assert.match(call, /if \(isRemoteMcpSessionExpired\(message\) \|\| \(isRemoteMcpAuthenticationError\(message\) && session\.token\.trim\(\)\)\) \{/, "an ended session gets the one re-handshake");
    assert.match(call, /setRemoteNotice\(message\);\s*dropRemoteSession\(id\);/, "a failed call keeps its own message");
    const panel = read("../src/components/ConnectorPanel.tsx");
    assert.doesNotMatch(panel, /stays in\s+memory and is cleared when you disconnect or close the app/, "the bearer is stored, not only in memory");
    assert.match(panel, /saved in\s+your system's credential store/);
    assert.doesNotMatch(read("../src/lib/remoteMcp.ts"), /bearer tokens and the MCP session id deliberately stay in the\s+caller's memory/);
  });

  // M3-02 check (F3, F8), 06/10/2026.
  it("sends a typed token once, to the URL it was typed for, and forgets nothing while a probe runs", () => {
    const panel = read("../src/components/ConnectorPanel.tsx");
    const reconnect = panel.slice(panel.indexOf("async function reconnectRemote("), panel.indexOf("return (", panel.indexOf("async function reconnectRemote(")));
    assert.match(reconnect, /const token = reconnectToken\(remoteTokenUrl, remoteToken, entry\.url\);/);
    assert.match(reconnect, /setRemoteToken\(""\);[\s\S]*await onProbeRemote\(entry\.name, entry\.url, token\);/, "cleared before the probe, sent once");
    assert.match(panel, /const token = remoteToken;\s*setRemoteToken\(""\);\s*const result = await onProbeRemote\(/, "the form's probe clears it too");
    assert.match(panel, /setRemoteToken\(ev\.target\.value\);\s*setRemoteTokenUrl\(remoteUrl\);/, "bound to the URL shown when typed");
    const forget = panel.match(/<button[^>]*?(?:disabled=\{[^}]*\}[^>]*?)?onClick=\{\(\) => void onForgetRemoteCredential\(entry\.id\)\}/g) ?? [];
    assert.equal(forget.length, 2, "both Forget token buttons");
    for (const button of forget) assert.match(button, /disabled=\{remoteBusy !== null\}/, "Forget token waits for the probe");
  });

  // M3-02 proof and check (F2), 06/10/2026.
  it("tells the conversations still holding a remote's bearer, whatever took it away in Extensions", () => {
    const hook = read("../src/hooks/useMuseSessions.ts");
    const body = (head: string): string => {
      const start = hook.indexOf(head);
      assert.ok(start > 0, head);
      return hook.slice(start, hook.indexOf(" = useCallback(", start + head.length));
    };
    assert.match(body("const forgetRemoteMcpCredential = useCallback("), /noteHeldBearer\(id, "its token was forgotten"\)/);
    assert.match(body("const disconnectRemoteMcp = useCallback("), /noteHeldBearer\(id, "disconnected"\)/);
    assert.match(body("const uninstallConnectorById = useCallback("), /noteHeldBearer\(id, "removed"\)/);
    assert.match(body("const setConnectorEnabledById = useCallback("), /noteHeldBearer\(id, "disabled"\)/);
    assert.match(body("const setConnectorUseInMuseById = useCallback("), /noteHeldBearer\(id, "Use in Muse turned off"\)/);
    assert.match(hook, /remoteHandedRef\.current\[meta\.session_id\] = mcp\?\.remoteIds \?\? \[\];/, "a start records what it handed");
    assert.match(hook, /remoteHandedRef\.current\[id\] = reload\s*\? mcp\?\.remoteIds \?\? \[\]/, "a reload replaces the record, a plain resume only adds");
  });

  // M0-13 check, 06/10/2026: "Reconnect with current connectors" returned at
  // once for a conversation its host had loaded, and applied nothing.
  it("reloads the conversation's host when asked for the current connectors", () => {
    const app = read("../src/App.tsx");
    assert.match(app, /onReconnectActive=\{\(sessionId\) => reconnectSession\(sessionId, \{ reload: true \}\)\}/);
    const hook = read("../src/hooks/useMuseSessions.ts");
    const resume = hook.slice(hook.indexOf('const meta = await invoke<BackendSessionMeta>("resume_session"'), hook.indexOf("if (tombstoned.current?.has(id)) return;", hook.indexOf('invoke<BackendSessionMeta>("resume_session"')));
    assert.match(resume, /\s+reload,\s/, "resume_session gets the reload flag");
    const rust = read("../src-tauri/src/main.rs");
    const inner = rust.slice(rust.indexOf("async fn resume_session_inner("), rust.indexOf("#[tauri::command]", rust.indexOf("async fn resume_session_inner(")));
    assert.match(inner, /if let Some\(meta\) = attached_session\(state, &session_id, &root\)\? \{\s*if !reload \{\s*return Ok\(meta\);\s*\}[\s\S]*replace_idle_host\(/, "a loaded conversation gets a fresh host");
  });
});
