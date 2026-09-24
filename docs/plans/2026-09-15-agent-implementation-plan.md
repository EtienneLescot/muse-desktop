# Implementation plan for coding agents

Reference: [operational roadmap](../ROADMAP.md). This plan specifies **how to deliver the rest**, without changing the delivery statuses. Observed base: `main` after PR #98; explicit resume, MCPB, the secret store, the review-comment queue, extractive run summaries and skill-invocation progress are already merged. Before any change, check which PRs are merged and read their current code. Do not reimplement `hosts.rs`, `resume.rs` or Reconnect if they are already present.

The command, module and structure names proposed below are **contracts to implement**, not capabilities already available. MSP methods must be confirmed in the installed schema and on the served binary; never invent an RPC to satisfy a mockup. Features that depend on a remote service start with an architecture decision and a proof of feasibility.

## How to use this plan and split deliveries

1. Pick a roadmap ID, read its entry below, its dependencies and the audit's evidence. Check the Git tree and the local instructions before changing anything.
2. Describe in the PR the before/after scenario, the exact scope and the criteria left out of the batch. Keep a single observable result per PR when possible.
3. Re-read the relevant source code: the line numbers from historical audits may have changed. The paths in the entries are entry points, not an exhaustive list.
4. Define the success/loading/empty/error/recovery UX states before wiring the action. Reuse the tokens from `design/system/tokens.css` and the conventions of `src/Desktop.css`; keep the product in English.
5. Pass the relevant checks, attach reproducible evidence and update the roadmap's four axes. An interface alone does not move "Function" to "Wired".

No implicit launch of several agents: this document prepares transferable tasks; it does not on its own authorise delegation. The central files `App.tsx`, `useMuseSessions.ts`, `main.rs` and the migrations must have a single change owner at a time.

### Code map

| Responsibility | Existing code to read | Proposed direction |
|---|---|---|
| Shell/navigation | `src/App.tsx`, `src/Desktop.css`, `SessionSidebar.tsx`, `WindowControls.tsx` | Extract per feature when the batch requires it; avoid a global rewrite |
| Conversations | `src/hooks/useMuseSessions.ts`, `src/lib/persist.ts`, `poll.ts`, `messageBlocks.ts` | Separate connection state, history and actions; keep the server identity |
| Transport/supervision | `src-tauri/src/main.rs`, `msp.rs`, `hosts.rs`, `resume.rs` | Testable service modules; thin Tauri commands |
| Context and rendering | `Composer.tsx`, `StreamView.tsx`, `MessageContent.tsx`, `ArtifactsPane.tsx` | Distinguish text, files, tools, events and real artefacts |
| Projects/extensions | `src/lib/projects.ts`, `skills.ts`, `connectors.ts`, `schedules.ts` | Gradually adapt the local registries to the real services |
| Verification | `test/*.test.ts`, built-in Rust tests | Add MSP fixtures, UI tests and a native smoke test, kept separate from the tests that use the real engine |

### Cross-cutting contracts to respect

- Distinct identities: `projectId`, `workspaceId`, server `sessionId`, `hostGeneration`, `requestId`, `runId`. Never route a session action through the globally selected folder.
- An asynchronous operation carries its target and its state; a view change does not change its destination. Refuse a stale result after a deletion, an engine replacement or a generation change.
- Separate a command's admission, execution and termination. An MSP acknowledgement does not mean the turn or the tool has finished.
- In-memory locks do not cross an `await`, except an asynchronous mutex expressly meant to serialise the cycle concerned. Document the lock order; test concurrent operations.
- Run Git/shell through structured arguments, not through command concatenation. Paths are validated/canonicalised on the Rust side. Secrets go neither into localStorage, nor into logs, nor into fixtures.
- Preserve uncommitted work and local data. Migrations are versioned, testable and recoverable; storage failures must be visible.

### Shared validation

Current commands: `npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml --bin muse-desktop --quiet`. Native Windows build if the runtime/packaging changes: `npm run tauri -- build --bundles nsis` with the sidecar configured.

Create minimal fixtures for success, refusal, timeout, interleaved events and host shutdown. A browser test with simulated IPC checks the UI; a direct engine test checks the protocol; **neither one alone counts as a Tauri E2E**. For each native scenario, record the OS, the app/bridge/engine versions, the steps, the result, and any use of a model turn. Do not invent evidence for the other OSes.

## Recommended sequence

1. Finish the evidence and failure paths of M0-01/02; deliver M0-03/04/05 with the M0-14 test foundation.
2. M0-06/07/08/09/10; then close M0 with M0-11/12/13. The M0-07 privacy fixes can be delivered immediately.
3. M1-01 → 02/03/04; M1-05 → 06; M1-07 → 08; then 09/10/11/12/13.
4. M2-01/02 → 03/04 → 05/06; 07 → 08 after real isolation.
5. M3-01/02 → 03; 04 → 05; M3-06/07 → 08/09 on the M2 environments.
6. M4 through proofs of feasibility, without presenting them as already achieved.

## M0 — Recovery and reliability

### M0-01 — Isolation: finish the validation

**Code:** `hosts.rs`, `msp.rs`, `main.rs`, the sessions hook. Reuse the registry added in PR #13.

**Work:** add a Tauri scenario with two temporary folders, two sessions and interleaved streams. Interrupt/kill B while A is working; check the send/model/approval/input/subagent routes, deleted sessions and late events from an old generation. Also handle the stdout channel closing with no Terminated event, and a failure during initialize. The opt-in `npm run smoke:native` check now covers the real Windows pre-flight (two `muse serve`, handshake, sessions and `model/list`) with cleanup and a bounded JSON output; `--exercise-isolation` kills B and checks that a read-only request on A is still served, while `--exercise-cut-during-turn` closes B after a turn is admitted and checks that A survives. The complete run of 18 September 2026 confirmed two distinct workspaces/hosts, two interruptions, four structured errors, the capped approvals, the user shell, the queue/resume, the bounded compaction and A's survival after B's failure. These checks remain a transport/isolation pre-flight and do not replace the complete Tauri scenario.

**Acceptance:** A keeps its identity, its requests and its stream; only B becomes disconnected; no process/consumer remains after closing. Dependency: the M0-14 harness. Do not close with the "two model/list" smoke test alone.

### M0-02 — Complete resume and reconciliation

**Code:** `resume.rs`, `resume_session`, `reconnectSession`, `persist.ts`, `poll.ts`. Keep PR #14's identity/folder/durability validation.

**Work:** define `ConnectionState = disconnected | connecting | connected | error` per session and generation. Persist the last server cursor observed when the protocol guarantees it; use resume/history/view-page to recover the missing suffix. Deduplicate by the items' server identity, not by their text. Reconcile re-emitted approval requests and questions; keep drafts. Do not reattach a non-recoverable ephemeral profile. Adapt Windows/WSL paths explicitly, without assuming every mount is identical.

**Delivered slice:** `read_session_history` calls `session/read` with `excludeItems:false` after `session/resume`. `src/lib/history.ts` normalises inline or snapshot items into the thread's lanes, including nested MSP wrappers and snake_case aliases (`item_id`, `turn_id`, `command_text`, `output_ref`), replaces partial blocks with their durable version through `itemId`, and keeps local notes and old user echoes. If `session/read` is absent, `readHistoryEntries` falls back to `page_session_history`/`view/page`, walks at most eight pages of 500 events and folds lifecycle items onto their highest revision before the same merge. Responses with no inline history remain compatible: the reconnection succeeds and the local transcript is kept. `restore_sessions` now also walks the `session/list` pages, attaches the rows to the host instance that served them and creates the renderer metadata for unknown durable sessions after a restart, without taking over an identity already held by another host. The hook also exposes live activity per session; `StreamView` renders a discreet health state, a counter since the last event and reconnect/stop actions when the host goes silent. That indication stays advisory: it does not replace `running` and closes no turn. The `initialize.sessionDurability` response is now propagated per workspace and persisted in the metadata; an explicitly `ephemeral` host shows the local transcript but removes the reconnect action after a restart, while an absent value keeps the compatibility path. Durable resume now first checks `session/read` (`excludeItems:true`), validates the identity, the path and the workspace, then sends `session/resume` with a fresh `commandId` without replaying the local transcript; a Rust test checks the sequence, the status/posture/durability projection and the route cleanup on error.

**Resume failure with no ghost conversation:** an invalid or rejected `session/resume` response now removes both the host route and the provisional `SessionMeta` metadata; the MCP configuration is validated before any state is inserted. A Tauri test checks that an envelope with no conversation leaves no residual attachment.

**Native pre-flight on 18 September 2026:** `node scripts/native-smoke.mjs --exercise-reconnect` attempts both reconciliation reads (`session/read` and `approval/listPending`) on each Windows sidecar. Muse Code 1.3.0 answers `methodNotFound` for both methods; the smoke test records it as `unsupported` and carries on, so as to tell a missing contract apart from a transport failure. The same complete run also confirms `session/list` available but `view/page` absent, and receives no history projection or shell item on that sidecar. Live resume therefore stays wired on the renderer side but is not demonstrated by this binary; no durable status must be shown without a host that exposes these methods.

**Acceptance:** close after a message, reopen and send in the same session; resume after a failure with a suffix and no duplicate on a durable host; a pending request visible once; refusing an incorrect lease/folder preserves the messages; an `ephemeral` host flagged with no misleading reconnect action. Depends on M0-01/08/09. Metadata-only reconnection and resume on the 1.3.0 sidecar remain partial.

**Liveness/connection sub-ticket (delivered):** define a pure `classifyStreamHealth` with a bounded threshold (15 s), priority to action requests, and `waiting-host`/`stalled` states. Touch the activity on each event and on the actions that restart the turn (`send`, approval, question, guidance). Show the signal inline in `StreamView`, keep the reasoning details collapsible, and check the threshold boundary, the explicit states and the rendering with no backend. In parallel the hook exposes a `SessionConnectionState` per identity; `host_exited`, reconnection and resume failure update that cycle without touching the history. The thread also shows the duration of the reasoning phase and an allowlisted label for the last event observed; no payload or arbitrary transport name is injected into the user's text. Chunks accept the `text`, `delta`, `content`, `message` and `summary` shapes, including inside a nested item, so that the Thinking disclosure stays informative without showing the host's JSON envelopes. **Sync now** re-reads the history and the pending requests idempotently without replacing the host, and only restores liveness when a durable item proves progress. After the same silence threshold, the hook runs a single silent automatic reconciliation for accepted decisions; it never removes the `resuming` bridge without durable proof. An authorisation resolution observed after reconnection recreates the placeholder and the resume bridge only for an explicitly accepted decision. Clicked decisions are resolved from the current snapshot bounded to the session, so that a known refusal is never treated as a resume. Legacy hosts that omit `updated` on a later approval step no longer close the lane while the resume bridge is active; the decision stays synchronised in a ref to cover the race between the IPC and the next poll. When a host emits `turn/retryScheduled`, the same live state shows the countdown, the attempt and the reason, correlates the events carrying a `turnId` with the current turn and ignores delayed notifications from a finished turn, then exposes **Stop retry** during the backoff and renders the recovery actions if no resume arrives after the delay. If the host does not expose the durable recovery RPCs, or if the read fails, `recoveryNotice` shows a bounded explanation outside the transcript and a **Try again** button; that notice fabricates no progress and disappears at the next real event. Qualifying a real host that stays silent must remain a separate native proof.

### M0-03 — Lossless send and retry

**Code:** `Composer.tsx`, the `sendInput` hook, `persist.ts`, `EmptySessionScreen.tsx`.

**Work:** make the send action return an explicit result. Add an outgoing message with `clientMessageId`, the original text, the target, a `sending/accepted/failed` state, the error and an idempotency key. Only clear the draft on acknowledgement, or keep a durable retryable message. After an ambiguous timeout, check the server state before retransmitting; reuse the same key for the same logical send. Skill/project expansions must stay reproducible without doubling the text.

**State on 18 September 2026:** the renderer outbox already keeps the exact expansion, the stable `commandId`, ambiguous failures and the verified retry. In a Tauri build it is now mirrored atomically under `app_data/outbox/outbox.json` (envelope `muse-desktop.native-outbox.v1`, 4 MiB), then merged by `clientMessageId` and `updatedAt` at startup; a native copy left in `sending` is recovered as ambiguous, while a more recent `accepted` state removes an old retry. Mirror writes are serialised and coalesced so that a slow `invoke` does not reinstall a stale state; the sidebar also exposes the number of sends kept across all conversations and opens the target conversation to handle them. The E2E proof with a real engine cut during the send remains open.

**Acceptance:** network/host cut, server refusal, double click, close/reload, conversation change and first-prompt failure: the text is recoverable and a single turn is accepted. Depends on M0-02/09; also test IME and typing while waiting.

### M0-04 — Reliable stop

**Code:** `cancel_session`, `interrupt_session`, `phase.ts`, `StreamView.tsx`.

**Work:** separate `interruptRequested` from the confirmed terminal state. Do not announce stopped because a call was attempted. Map the "already finished" error with no false failure; keep the stream until the terminal event or an identified disconnection.

**Acceptance:** stop before the first token, during a tool, after the end, with a late response and a double click. Stopping A does not affect B; the final state matches the engine. Depends on M0-01/03.

**State on 18 September 2026:** the cancellation request is kept in a renderer-only state until a terminal `turn/completed`, `turn/retracted` or `turn/stopped` is received (or a disconnection), with a `Stopping Muse` badge, a button disabled against double clicks and a transcript not closed prematurely. The bridge now forwards the observed `turnId` when available, while keeping the untargeted payload for older hosts. If the acknowledgement stays without an event during the liveness window, the thread shows a recovery state and an explicit close instead of spinning forever. The native qualification of races and late responses remains to be produced.
**Native pre-flight on 17 September 2026:** `node scripts/native-smoke.mjs --exercise-control --exercise-errors --exercise-approval --exercise-isolation` admits in parallel then immediately interrupts a synthetic turn on two distinct Windows sidecars, checks the `accepted` acknowledgement, the preservation of the `turnId`s, the error categories, the authorisation ceiling and A's survival after B stops. `--exercise-cut-during-turn` adds B's failure after a turn is admitted and checks that A still answers, without presenting a missing terminal notification as a success. The report tells the interruption acknowledgement apart from a terminal notification actually received; the Muse Code 1.3.0 sidecar tested publishes none of the `turn/completed`, `turn/retracted` or `turn/stopped` shapes, so the check stays explicitly `terminalNotification: unsupported`. `--exercise-terminal` enforces that requirement to qualify a later host. Closing also terminates the Windows process tree with a bounded fallback, to release the temporary workspaces. `--report <file>` keeps exactly the bounded JSON produced by the smoke test, to attach it to a validation, with no workspace path or transcript. The base report exposes `initialize.sessionDurability` to avoid presenting a reconnection as available on an ephemeral host. This proof covers the command contract and transport isolation, not the UI race between a first token, a tool, a confirmed terminal event and a late response.

### M0-05 — Pending requests

**Code:** `ApprovalPanel.tsx`, `InputPanel.tsx`, MSP routing, the approval tables.

**Work:** index by session + identifier + generation, keep the server's opaque token, remove only on confirmed settlement. Reconcile the snapshot and the resume notifications; old decisions must not act on a new request. Keep the edited answer if validation is refused.

**Delivered slice:** after `session/resume`, the hook calls `list_pending_requests` (`approval/listPending`) and replaces only the cards of the session concerned. The approval and user-input payloads go back through the existing parsers; the opaque tokens stay in the Rust registry and the events re-emitted by the host stay idempotent on the UI side. The resolution bridge also relays a bounded `turnId`, including in the snake_case and nested variants, so that the renderer attaches the resume to the turn that was waiting for the authorisation.

**Observed native limit:** the Windows 1.3.0 sidecar used by the smoke test does not serve `approval/listPending` (`methodNotFound`). The panel keeps the events received and shows the bounded error during an explicit sync; the real re-emission of a request after an incident needs a qualified host version or a documented compatibility contract.

**Acceptance:** the same ID in two sessions, a re-emitted request, a stale token, an error after a click, a restart and a double answer. A choice is only sent to its target. Depends on M0-02/04/08.

### M0-06 — Effective permissions

**Code:** `SettingsPanel.tsx`, `settings.ts`, `allowlist.ts`, `scope.ts`, the host spawn.

**Work:** establish a matrix of capabilities/preferences/applied posture from the real engine. Define how a change affects existing hosts: applied, next start, or not supported. Do not turn a local preference into an implicit engine authorisation. Show the origin and the scope; disable the options with no verified contract.

**Acceptance:** read/write outside the root, a symlink, the network and a refused command; the engine's verdict matches the UI text. Depends on M0-01/08; profiles tested without widening the user's real permissions.

**Native pre-flight on 17 September 2026:** `--exercise-approval` creates a session with no imposed preference, records the host's `approvalMode` projection, then tries `onRequest`, `promptUnmatched` and `allowAll`. The 1.3.0 sidecar observed accepts the current `promptUnmatched` posture and refuses the other two with `commandRejected/approval_mode_ceiling`. That limit is now explicit in the report; the UI must not turn a refused local preference into an effective permission.

**Continuity under a ceiling:** if a persisted local preference is refused at `session/start` for `approval_mode_ceiling`, the bridge removes only that field and retries with the host's default posture. The response exposes `approval_mode` when available. `reconnectSession` then keeps the history and the composer usable if `session/setApprovalMode` is refused, keeping the observed projection and suspending auto-approval until confirmation.

**Stdout pump:** `pump_stdout` delegates to `ingest_stdout_chunk`, an asynchronous boundary tested with an injected child and with a real system child process. The end-to-end test covers a request written by the production `ChildTransport`, a response and a notification split into real `CommandEvent::Stdout`s, correlation by identifier and the pump's controlled termination. What remains is wiring a packaged webview and the complete native A/B scenario into the M0-14g check.

The startup contract is also covered without a webview: an `approval_mode_ceiling` error on the first `session/start` triggers a second call without `approvalMode`, while a different error stays blocking. The session then receives the host's effective projection (`approval_mode`) so that the renderer SSOT does not confuse a local preference with an applied permission.

### M0-07 — Diagnostics

**Code:** `wire_log`, `push_stderr`, `msp.rs`, the errors displayed.

**Work:** remove raw capture in normal use. If diagnostics are enabled: structured events, minimal metadata, masking, bounded rotation and retention; an explicit export with a preview. Use truncation that respects UTF-8 boundaries.

**State on 17 September 2026:** Settings offers a bounded local JSON export (`muse-desktop.diagnostics.v1`) containing the platform, the backend, session/event counters and the last redacted error. The Tauri bridge also exposes `collect_diagnostics` (`muse-desktop.native-diagnostics.v1`) to add the native counters for workspace, hosts, sessions, approvals and the event buffer; the web preview keeps a renderer fallback. `turn/completed` events now keep the structured MSP terminal error (`kind`, `message`, `retryable`, duration/reason), persisted in the log and rendered in a readable disclosure; a retryable error offers **Retry turn** from the previous user prompt. Hosts with no envelope fall back to a bounded, redacted reason. No workspace path or conversation content is exported; common secrets are masked. The `--exercise-errors` native pre-flight now confirms that the `methodNotFound` and `invalidParams` categories cross the transport on two isolated hosts; qualifying the detailed errors of a real turn remains open.

**Acceptance:** multibyte Unicode at the limit, a long error, a synthetic secret, a high volume. No raw prompt or secret written by default; no panic. A standalone deliverable, with no need to wait for the other batches.

### M0-08 — Engine contract

**Code:** `lib/msp.ts`, `msp-conformance.test.ts`, `main.rs`, the pinned SDK.

**Work:** list the RPCs actually sent, including models/compaction/subagents/resume. Check the registry against the implementation rather than against a constant number. Store the handshake's capabilities and version; define incompatible vs compatible addition. Centralise the useful error codes and hide unsupported actions.

**Acceptance:** an RPC missing from the registry fails the check; an incompatible schema produces a usable error; an unknown additive notification does not stop the stream. Deliver anonymised fixtures of known versions.

**Native pre-flight on 17 September 2026:** the Muse 1.3.0 binary answers the expected handshake and returns structured JSON-RPC errors for an unknown method and for an interruption with no parameters, on each of the smoke test's two hosts. The combined check adds two correlated interruptions, six posture attempts with the observed `approval_mode_ceiling` ceiling, and B's isolated stop while A keeps answering. This proof does not yet cover the version matrix or the errors produced during a model turn.

### M0-09 — Persistence

**Code:** `persist.ts` and every module using localStorage/sessionStorage.

**Work:** an inventory of the keys and retention policies. The versioned `lib/storage.ts` facade is now the entry point for every known `localStorage` reader/writer, including scalar values. It validates JSON reads, keeps the old values when a write fails, bounds the diagnostics and exports a recovery snapshot. The `v1` formats stay unchanged; **Migrate legacy data** now copies the `muse.*` aliases and the readable historical logs to the current keys that are absent, keeping the sources and the errors visible. Exports also carry an additive `durable`/`ui` classification: new imports select the durable data, while interface pointers, drafts and leases stay explicitly opt-in. The export's deterministic checksum is verified before the preview and the restore; older snapshots with no checksum remain compatible. External formats, tombstones and quotas with no resurrection remain to be qualified.

**Delivered slice:** the exported snapshot can be re-imported from Settings. The import checks the format/version and limits the keys to the `muse-desktop.*` namespace. A preview lists the recoverable keys, whether they are currently present and the damaged raw values; only new entries are ticked by default. Confirmation then restores the chosen list of keys, including the explicit replacement of an existing key, and the reload follows the normal boot to avoid a partially restored React state.

**Acceptance:** an old schema, log aliases, corrupted JSON, a modified checksum, unavailable/full storage, an interrupted migration and reopening. No silent erasure; a rescue export is accessible. The migrations come before the M0-02/03 and M2 format changes.

### M0-10 — Windows first launch

**Code:** the WSL bridge, `SidecarErrorPanel.tsx`, sidecar resolution, the README.

**Work:** a secret-free diagnostic of WSL/distribution, binary, version, accessible folder and authentication. Show correction steps and a Retry button. Distinguish the native Windows UI from the WSL engine; no uncontrolled implicit installation.

**State on 18 September 2026:** `probe_startup` runs a read-only, bounded native probe (sidecar, WSL, `~/.local/bin/muse`, workspace), available explicitly in Settings and reused by the recovery panel after a failure or a retry. It no longer runs automatically on each folder change, so it does not clutter the welcome screen. The result stays structured per check and reads no credential; the existing guidance keeps the manual fix. The recovery panel and Settings now show a text label for each state so that understanding does not depend on colour (`Ready`, `Needs attention`, `Blocked`, `Not verified`); the normal welcome screen does not show these diagnostics. Windows UTF-16 console outputs are decoded and control/replacement characters are cleaned up before display, with a second pass on the renderer side for older sidecars and preview mode, including residual UTF-16 strings with interleaved NULs.

**Delivered addition:** on Windows, `npm run dev:clean:windows` calls `scripts/dev-clean.ps1`. It only terminates the process trees whose executable or command line belongs to this checkout, purges the local Vite cache and runs `tauri dev` with the renderer attached. That makes the relaunch path reproducible without turning the packaged binary into a development server.

**Acceptance:** a clean machine, Muse absent, auth absent, a path with spaces/Unicode, an incompatible bridge. The first turn is reachable with exact instructions. Depends on M0-08.

### M0-11 — English and navigation polish

**Code:** components, `App.tsx`, messages produced by the hook, `WindowControls`.

**Work:** an inventory of the labels and errors generated by the app, conversation/project/run consistency, Ctrl/Cmd shortcuts and focus states. `primaryModifier()` now provides the OS label for the global, sidebar and input tooltips. Centralise reused texts if useful; do not translate user or engine content.

**State on 17 September 2026:** `userFacingError` centralises the calm English copy for technical errors on the global banner, files, projects, settings, input requests, folder pickers, the composer, the Git review, the skills scan, the model catalogue and the window controls. The skills scan now also handles an asynchronous rejection; attachment errors stay named but use the same bounded copy. Details stay bounded and masked, while user and engine texts are kept as they are. The final native checklist of titles and errors still has to be replayed in the packaged webview.

**Acceptance:** a checklist of welcome/conversation/archives/settings/extensions and errors; no regression of the fixed profile, the themes or the drag area. Light/dark captures at the target desktop sizes.

### M0-12 — Accessibility

**Code:** `a11y.ts`, dialogs, question panels, the sidebar, the composer and the stream.

**Work:** initial/return focus, group navigation, closing with Escape, labels and non-repetitive live announcements. Check contrast and zoom; announce the end/a needed action rather than each token. The controls also add a Windows forced-contrast path (`Highlight`, `ButtonText`, `LinkText`) without changing the normal rendering.

**State on 19 September 2026:** the approval and question cards take focus on arrival, offer arrow-key navigation between choices, a Tab loop confined to the active card, as well as Ctrl+Enter to answer and Escape to dismiss. The transcript now receives focus and exposes Home/End/PageUp/PageDown with bounded targets; End reuses the jump back to the last message, and loading older pages stays triggered by scrolling. The stylesheet also adds a `prefers-contrast: more` mode that strengthens focus, the active conversation and secondary messages without changing the default palette. The pure navigation and announcement tests stay green; verification with a real screen reader, 200 % zoom, native contrast and reduced motion remains to be carried out.

**Acceptance:** a complete path with no mouse, a real screen reader, 200 % zoom, reduced motion. Automated tests complement this verification but do not replace it.

### M0-13 — Honest capability states

**Code:** the Settings/Connector/Browser/Share/Orchestration panels, shared components.

**Work:** define a shared `available/local/manual/unavailable` presentation with a reason and a next action. The shared component is now applied to connectors, channels, exports, worktrees, the local index and the CLI/IDE import; badges stay limited to the surfaces whose capability could be mistaken for a real connection. Replace "installed/connected/restored" promises when only a registry or a prefill changes. Do not add a permanent badge to every working element.

**State on 18 September 2026:** the shared badge also exposes a complete accessible name (`state: reason`) so that a capability's scope does not depend on hovering or on colour. It is now present on the Browser and Desktop control surfaces: the embedded preview is explicitly local, while the native window, the capture and the host's actions stay conditioned on the runtime, the capability announcements and consent. The visual vocabulary and the assistive label still come from the same pure helper.

**Acceptance:** a click → real effect audit on each action; no fictitious confirmation. Test a missing backend and refused capabilities. Depends on the M0-08 inventory.

### M0-14 — Harness and CI

**Code:** new integration tests, scripts and `.github/workflows/`.

**Work:** an MSP fixture server with controlled scenarios and an injectable transport; start the isolated app with temporary storage/folders. Separate unit, simulated UI, supervisor integration and optional live tests. CI with no credentials: build, Node, Rust, fixture scenarios. Publish reports/captures on failure, with no user data.

**State on 16 September 2026:** `scripts/msp-fixture.mjs` is a deterministic JSON-RPC server launched as a child process by `test/msp-fixture.test.ts`. The scenarios cover initialisation/catalogue/a successful call, an interleaved `notifications/tools/list_changed` notification, a tool refusal, a request kept open to simulate a timeout, and stdout closing to simulate a failure. The test checks the bytes actually exchanged with `Content-Length` framing and reads no user file; it is included in `npm test`, and therefore in the Node CI job.

**State on 17 September 2026:** the frontend and Rust CI jobs now keep, only on failure, a bounded report (the last 250/300 lines), after masking the runner's paths and the common shapes of secrets. The artefacts are retained for seven days and contain neither a user workspace nor a transcript.

**Delivered injection foundation:** the MSP transport now depends on a minimal child interface, with a `CommandChild` adapter in production. The Rust tests drive request correlation, A/B isolation, per-session lanes and waking up pending calls with a deterministic child, without starting a model engine. That boundary prepares the supervisor's fixture driver; it does not yet make up the complete Tauri scenario.

**Supervisor driver delivered on 17 September 2026:** `send_input_for_state` is shared by the Tauri command and the tests. Two injected clients on distinct workspaces validate the `turn/start` payload, out-of-order responses and the isolation of the `running` state; a child write in error stays bounded and does not mark a turn as started. The driver still has no model provider.

**Remaining:** the injection now covers the real `CommandEvent` loop, including partial stdout chunks, final fragments with no line break, shell errors and the receiver closing, which wakes the client. The Tauri `send_input`, `approve` and `answer_input` handlers are also exercised through the mocked invoke with a real session state, including two sessions sharing an approval identifier. What remains is qualifying the call from a packaged webview and the native A/B scenario with approvals. These tests stay separate from a real model turn.
**Integrated A/B Tauri flow:** a mocked-invoke test sends two turns on distinct sessions, receives the acknowledgements out of sequence, presents an identical authorisation in both sessions, then decides only A's. B's request and both `running` states stay intact. This proof closes the IPC race on the supervisor side; it does not yet replace a packaged webview or a real host with approval.

**Muse approval/resume fixture delivered (18 September 2026):** `scripts/muse-fixture.mjs` reproduces the Muse sidecar's newline JSON-RPC framing and keeps a durable in-memory store. `test/muse-fixture.test.ts` launches a real child process, checks `initialize` with `sessionDurability: durable`, creates a session, suspends `turn/start` on `approval/requested`, decides with the exact `currentRequirementId`, then observes `approval/resolved`, the items and `turn/completed`. A second scenario re-reads the transcript through `session/read`, checks there are no duplicates, resumes through `session/resume` and lists the session again. This layer closes the deterministic contract of M0-01c/M0-02c without claiming a native UI proof; it also covers a nested MSP `item/updated` snapshot (`analysis/done` then `userShell/succeeded`) to check that the reasoning/shell lanes close after approval; qualifying the real sidecar stays separate.

**Native pre-flight:** the Windows smoke test now shares this command with `--exercise-control` to check the `turn/start` → `turn/interrupt` control on two real hosts. Its report separates the interruption acknowledgement from a terminal notification; `--exercise-terminal` makes the latter mandatory for a host that supports it. Its `--exercise-errors` option also checks the `methodNotFound` and `invalidParams` categories on both transports, without exposing the raw frames; it does not replace fault injection in the Tauri supervisor.

**Acceptance:** from a clean clone, `npm test` runs the MCP and Muse fixtures with no external dependency; deliberately detect a wrong A/B route and a lost send as soon as the isolated Tauri driver is added. Choose the Tauri driver according to the platforms' real support, and record any limit in the ADR. The Muse fixture is only validated for the protocol contract; it does not close the webview/sidecar E2E.

## M1 — Daily development

### M1-01 — Git status and diff

**Code:** a new Rust Git service, a new Review panel; reuse only the mockup's style, not its data. Depends on M0-01/14.

**Work:** proposed commands `git_status(sessionId)` and `git_diff(sessionId, scope, baseRef?)`. Resolve the repository through the owning workspace, parse safe outputs with NUL separators, return files/hunks and the observed revision. Staged/unstaged/branch scopes; "last turn" requires an explicit snapshot, not an assumption.

**Delivered slice (19 September 2026):** the renderer captures the `git_status` observation just before each newly admitted turn and keeps it in the per-conversation SSOT with its `clientMessageId`, its `turnId` when provided and its admission state. The baseline is persisted under a dedicated namespace, restored on restart and deleted with the conversation. The probe is bounded to 1.5 seconds so that a stuck Git cannot make the composer wait. The Review panel then compares that observation with the current status and exposes the paths whose state really changed, as well as a HEAD or fingerprint change, without fabricating a patch. A capture failure never blocks a send in a non-Git workspace; a missing baseline stays visible through the card's absence, never as a false result.

**Acceptance:** a clean/dirty repo, rename/delete/untracked/binary/Unicode, outside Git, a missing branch and external changes; results compared with real Git.

### M1-02 — Review comments

**Code:** the Review panel, the composer, a new `ReviewAnchor` model. Depends on M1-01.

**Work:** an anchor containing the repo, the revision/base, the path, the side and the line/hunk. Turn the comment into explicit context for the conversation; flag an anchor that has become stale rather than moving it silently.

**Acceptance:** a comment delivered on the right line/side; a file renamed or a diff changed between selection and sending; no confusion between two repositories.

**State on 17 September 2026:** the foundation was delivered, then completed with a bounded comment queue persisted per conversation (`muse-desktop.review-comments.v1.<sessionId>`). An identical anchor updates the draft instead of duplicating it; the panel lets you select a note, send it alone, send the ready notes in sequence, remove a note or clear the notes already sent. Each send re-reads the status and the diff; notes whose anchor is no longer observable move to `stale` and stay recoverable until explicitly deleted. The native suite with a live engine and collaborative sending to a forge remain to be qualified.

### M1-03 — Stage and revert

**Code:** the Git service and Review. Depends on M1-01.

**Work:** file actions, then hunk actions, with the expected version of the diff. Refuse if the disk/index state has changed; a proportionate confirmation for discard. Do not use reset --hard as a shortcut.

**State on 16 September 2026:** file stage, unstage and discard are delivered in the session-scoped Git service. `git_apply_hunk` extracts a hunk from the observed patch and applies a partial Stage, Unstage or Discard with the same HEAD/status/diff guard; binary files, untracked files and truncated patches are refused. The panel also accepts multiple file selection and applies a grouped mutation with the same expectations; the actions require the panel's observation and return the refreshed state. Native qualification remains to be completed.

**Acceptance:** partial staging, a stale hunk, a user file modified between two clicks, a binary and a Git failure. Untargeted changes stay intact.

### M1-04 — Commit, push, PR

**Code:** the Git service + a forge adapter to create, UI dialogs. Depends on M1-03/06 and an authenticated environment.

**Work:** commit on the real index, result/hash; push to an explicit remote/branch; detect auth/rejection/hooks. Choose a GitHub CLI or API integration through an ADR, with credentials outside web storage. PR creation returns a verified URL; no automatic merge.

**Acceptance:** a test repository, a failed hook, nothing to commit, a branch with no upstream, a rejected push and an existing PR. No push to another branch through an implicit default.

**State on 16 September 2026:** commit, push and GitHub PR creation are wired in the session-scoped Git service. The commit is protected by the index observation; the push uses an explicit refspec and `gh pr create` reuses the local authentication with no web credential. Live hooks/auth, remote rejections, existing PRs and native qualification remain to be covered with a controlled test repository.

**Addition on 17 September 2026:** repository sync is now available in the same Review source of truth. **Fetch** runs an explicit remote with no pruning and reports the refreshed status. **Pull latest** requires an explicit remote and branch, checks HEAD and the complete fingerprint of the observed status, refuses dirty worktrees and limits the operation to `git pull --ff-only`; divergences and conflicts are therefore still to be resolved explicitly. The Rust tests cover a missing remote, a stale observation, a dirty worktree and a real local fast-forward.

**Addition on 17 September 2026 — idempotent PR:** before creating a PR, the service queries `gh pr list` with the base/head pair and the `open` state. An existing URL is returned with `existing: true`, which makes the button re-entrant and avoids errors or duplicates on a second click. The parser refuses invalid JSON responses and non-HTTP(S) URLs; the forge stays the authority for authentication and rejection cases.

### M1-05 — PTY terminal

**Code:** a new Rust PTY service and a Terminal panel. Depends on M0-01/14.

**Work:** create/write/resize/close contracts with `terminalId`, session, cwd, shell and generation. Bounded output, controlled closing, processes independent of the tab. Choose a PTY library compatible with the announced OSes; do not confuse a command runner with an interactive terminal.

**Acceptance:** interactive input, ANSI, resize, a long-running server, a view change, close/restart and Unicode; no orphan process.

**State on 16 September 2026:** the foundation was delivered in the M1-05 PR. `portable-pty` provides a native Windows/Unix shell in a persistent Rust registry; the Terminal panel opens/reuses the conversation's terminal, drains a bounded output, writes the input, resizes and explicitly closes the process. The view now translates the usual and advanced ANSI SGR styles (16/256/24-bit, bold, dim, italic, underline, strikethrough, inverse) without interpreting the content as HTML; the Ctrl+C/Ctrl+D/Ctrl+L/Tab/Escape shortcuts are forwarded to the PTY. Interactive native validation remains to be carried out separately.

### M1-06 — Terminal as context

**Code:** the PTY, a tools/context adapter. Depends on M1-05 and a verified engine capability.

**Work:** read a bounded snapshot with an identifier, cwd and offset; expose it to the engine through a real tool or an explicitly labelled insertion. Do not send the whole history on each turn.

**Acceptance:** a failing build command, the output available to the right agent; terminal B not reachable through a target mix-up; non-blocking capture.

**State on 18 September 2026:** **Add output to prompt** stays the bounded, attributed manual fallback. The handshake now explicitly requests the `userShell` capability; when it is granted, **Run in Muse** sends `session/userShell` with a UUIDv7 `commandId`, and the host is ready to return the command and its output in a tool entry of the transcript. The bridge also accepts a complete `item/completed`/`item/updated` with no delta: it recreates the appropriate lane, injects `visibleOutput`/`summary`/`text` once, then closes the item by its identifier. The items' `outputRef` references are now kept in the history; **Load full output** calls `item/readOutput` in 64 KiB blocks with a bounded offset and lets you load the rest without persisting the content in the log. History reconciliation now keeps `$ command` with the output for `userShell` items. The Windows `--exercise-user-shell` smoke test checks the grant and the admission on two sessions, but the 1.3.0 sidecar tested emits no transcript item on that minimal connection; the UI rendering therefore remains a missing proof. A host with no grant keeps the action disabled and the manual insertion available. What remains is native qualification on the three OSes, long outputs and interrupting a command.

### M1-07 — Real files

**Code:** a new files service, a Files panel, `ArtifactsPane`, scope. Depends on M0-06.

**Work:** lazy listing, bounded read, binary detection, external open/preview and an explicit handoff of the text preview to the composer; symlinks and authorised roots. Distinguish a file on disk from an excerpt in a response. A watcher or an explicit refresh with a stale state.

**Acceptance:** a large repository, a vanished/renamed file, out of scope and a large file; show the content really on disk without blocking the UI.

**State on 17 September 2026:** a local slice delivered on `feat/m1-real-files`: session-scoped `files_list`/`file_read` commands, a root and symlink guard, bounded listing/reading, binary detection and image/PDF previews in the **Files** tab. The tab periodically re-reads the current folder and shows the snapshot's time. The **Open in app** button calls `file_open(sessionId, path)`; Rust re-canonicalises the entry and only delegates to the default system handler a file or folder proved to be inside the workspace. `workspace_watch` now adds a native watcher per session, limited to relative paths, which marks the view stale without reading the content or silently refreshing the transcript; the user confirms the new snapshot with **Refresh**. **Add to prompt** then reuses the bounded text preview with its path, its size and its observation timestamp through the hook's SSOT. Multi-platform E2E qualification, large repositories, renames, deleted roots and rich formats remain open.

### M1-08 — Attachments

**Code:** Composer, `mentions.ts`, the files service, TurnInputPart adaptation. Depends on M1-07 and on the M0-08 verification of engine capabilities.

**State on 17 September 2026:** attached images detect their dimensions through the `Image` API when it is available, show them in the composer chip with a local thumbnail, then pass them as optional fields of the MSP part. The fallback with no DOM keeps the previous payload. Attachment drafts are restored within the webview session: bounded payloads stay reusable, while large items keep their metadata and expose **Reselect** before sending. Live qualification on image models remains open.

**Work:** define a structured reference with type/MIME/size/name/source, image drag/drop/paste, removal before sending, limits and errors. Use the format Muse accepts; if it is not supported, show the unavailability, not a fake file name in the prompt.

**Acceptance:** an image really received, a text file, a limit exceeded, a deleted file, cancellation and retry with no orphan attachment.

**State on 16 September 2026:** a stable contract verified from the bundled binary (`TurnInputPart` = `text|image|skill`). The composer sends text files and images through structured parts, with picker/drag-and-drop/paste ingestion, bounds and removal before sending; the outbox keeps the exact payload for retries. Session persistence of drafts is delivered with a bound and an explicit re-selection of large payloads. Live tests per image model and native qualification remain open.

### M1-09 — Server fork

**Code:** sessions, conversation actions, MSP session/fork. Depends on M0-02/08.

**Work:** choose the starting point among the supported anchors; return the new server ID, keep the provenance and the workspace; import its history without sharing drafts.

**Acceptance:** an independent branch, an unchanged source, an invalid point, an active source and a failure; never substitute a summary for the requested fork.

**State on 18 September 2026:** `session/fork` is wired in the supervisor, and the header action creates a new server conversation in the same workspace, with local continuity of the finished entries. Items now keep their `turnId`, and finished messages offer **Fork from here**, passed as `cutPoint.lastTurnId`; the header button stays the shortcut to the last finished turn. An anchor that has become unavailable now produces recoverable guidance towards forking the last turn, with no implicit retry on another point. Live qualification and resume after a reload remain open.

### M1-10 — Steering and message queue

**Code:** Composer, `phase.ts`, sessions/MSP. Depends on M0-03/04/08.

**Work:** map the real turn/steer, cancel and unqueue possibilities; a pending-message model with state/order/target. Distinguish sending after the turn from guiding the current turn; stable cancel actions.

**Acceptance:** two pending messages, removing the second, the turn ending at the same time, a server refusal and a reboot; order verified in the engine.

**State on 18 September 2026:** the order of admitted turns is persisted under `muse-desktop.queued-turns.v1`. A restore marks them as to be verified and lets you remove the local reminder without replaying them. When `session/read` really serves `history.snapshot.queuedTurns`, the hook reconciles that list, keeps the known local texts and flags the new identifiers to verify; an inline or absent response leaves the local queue intact. The Windows `--exercise-queue` smoke test admits two synthetic turns on each of two sessions, observes `disposition: queued` on the second and confirms `turn/unqueue` is accepted; this transport proof does not yet replace the UI race, the restart and the durable snapshot. Host admission stays the only source of truth until that observation.

### M1-11 — Models and compaction

**Code:** SettingsPanel, CompactBar, the existing RPCs. Depends on M0-08.

**Work:** keep the live catalogue and the fallback separate; confirm the effective model after a change; persist the choice at the right scope. Compaction: show admission/progress/result and distinguish a local summary from the server context.

**Acceptance:** an unavailable model, a change between sessions, a no-op/run-active/failed compaction; context and choice reflect the server.

**State on 18 September 2026:** `model/list`, `session/setModel`, `session/setReasoningEffort` and `session/compact` are connected to the host, with a clearly separated non-live fallback. The effort setting (`none` to `ultra`) is an SSOT property of the global/project settings, visible in the input area of new conversations and existing ones. The hook applies the value when a normal or worktree session is created and on a change mid-conversation; old persisted values are normalised to `high`. The last model request is also kept in `StoredSession.model_id`, then reused by Settings/Composer if the host exposes no `isActive` row, without presenting it as a native confirmation. A fork now reapplies that model to the new host before making the branch active. The context bar now also receives `session/tokenUsage` and shows the per-turn counters provided by the engine, without deriving them. The compaction bar also exposes the renderer SSOT state of the server request (`pending`, `accepted`, `noop`, `error`) and blocks double calls during admission. The Windows `--exercise-reasoning` smoke test applies `none`, `high` and `ultra` on two ephemeral sessions and checks acceptance; the sidecar tested returns no effective projection, and the report marks it `not-reported`. `--exercise-model` also sends `session/setModel` then re-reads `model/list`: the acknowledgement is accepted, but `isActive: false` on the binary tested, so the effective model remains unproven. `--exercise-compaction` calls `session/compact` on two blank sessions; the sidecar answers `missing-run`, which confirms the bounded refusal without claiming to have compacted a history. Native confirmation of the effective model and effort, unavailable models and live compaction on a thread with history remain to be qualified.

### M1-12 — Search and organisation

**Code:** the sidebar, App search, `threads.ts`, storage. Depends on M0-09/12.

**Work:** a local search index over history, pagination and excerpts; explicit pinning and order; unread kept distinct from running. Migrate the existing sort without losing dates/titles. Native restore also walks `session/list` through an opaque cursor (200 items per page, 20 bounded pages) before the ownership filtering. The first slice provides search, pinning, order and unread; the sidebar now applies `content-visibility: auto` and an intrinsic size per row to reduce the painting cost while keeping the DOM and the keyboard order; complete virtualisation stays conditional on a measurement.

**Acceptance:** accented/multilingual search, archive, deletion, a large history, keyboard and restart; no deleted session re-indexed.

**State on 18 September 2026:** search walks the metadata and the local logs with a contextualised excerpt; conversations can be pinned, reordered within their tier and marked unread, with preservation across restarts. Renaming immediately updates the local projection and attempts `session/rename` on the host side with a name bounded to 120 characters, without blocking an older sidecar that does not yet know that RPC. Virtualisation of very long lists remains open pending a measurement.

### M1-13 — Long reading

**Code:** StreamView/MessageContent, blocks and CSS. Depends on M0-14.

**Work:** measure render time/memory/scroll on a long fixture. The transcript applies `content-visibility: auto`, a fallback intrinsic size and instant scrolling during streaming; beyond 600 entries, a window of 160 messages loads the previous 120 on demand, with height compensation and top/bottom virtual spacers that represent the entries outside the DOM in the scrollbar. The reading position and the window index are kept per conversation, so that switching threads does not lose the context. Expose a stable entry counter for native UI measurements. Accessible links/code/tools, a "new messages" state with no jump if the user is reading higher up. **Find in conversation** provides a bounded local finder, reachable through a button or `Ctrl/Cmd+F`, searches the complete log and moves the window onto a result outside the DOM. The browser's native search stays limited to the loaded DOM window.

**State on 19 September 2026:** the finder now accepts the up/down arrows to walk through the results and Enter to open the active result, and exposes the selection through `listbox/option` and `aria-activedescendant`. The selection stays bounded and cyclic, including when the DOM window does not contain the targeted message. The window also exposes each entry's global position (`article`, `aria-posinset`, `aria-setsize`), a live announcement of its visible range and focusable keyboard navigation (`Home`, `End`, `PageUp`, `PageDown`), so that a screen reader or keyboard user does not think the 160 mounted nodes make up the whole history. Virtual spacers computed by `streamWindowPadding` keep a proportional scroll height without adding fake elements to the accessibility tree; the mounted blocks now feed those spacers through `ResizeObserver` measurement, with anchor compensation when a height becomes more precise. The position and the window index are also persisted per conversation in `muse-desktop.stream-position.v1`, bounded and classified as UI, so as to restore the context after switching threads or relaunching without storing the transcript. The scroll targets are computed by `src/lib/streamNavigation.ts` and covered by pure tests; what remains is the native measurement on 2,000 entries and assistive qualification in the packaged webview.

**Acceptance:** interleaved streaming, selection/copy, large blocks, back to the bottom of the page and theme; set the measured budgets in the PR.

## M2 — Isolated environments

### M2-01 — Project roots

**Code:** `projects.ts`, ProjectsPanel, persistence and the workspace backend. Depends on M0-09.

**State:** wired on the model side and in the local UI. `Project.workspace` stays the primary root for compatibility and `Project.workspaces` carries the additional roots; the values are cleaned and deduplicated before persistence. The Projects panel provides the native multi-folder picker, editing and resetting the roots. `New conversation here` reuses the hook's `start_session` path and explicitly asks for the starting root.

**Added slice:** the new-conversation screen projects each available root into an environment picker with a stable `projectId:rootIndex` value. The choice passes exactly the project's workspace and settings to `start_session`, then attaches the created session to the project in the same transition. The `projectWorkspaceOptions` projection stays in `projects.ts` to avoid a second filtering rule on the UI side; projects with no root are never offered.

**Delivered:** `projectsNeedingWorkspace` identifies the old projects with no usable root and no choice marker. Projects created or edited now carry `workspaceReviewed`; Projects shows a bounded migration notice and opens the native picker. **Check folders** calls `inspect_workspace_root` for each root, shows an independent state per folder and keeps a non-mutating native observation that distinguishes an available folder, a file path and a missing folder. `updateProject` keeps the historical primary field and writes the additional roots under `workspaces`, with no inference from the name and no change to existing conversations.

**Remaining:** multi-platform qualification of the probe and the atomic admission of a managed environment/worktree. Never infer a folder from the project's name.

**Acceptance:** a multi-folder project, a moved folder, an old group with no root and a new conversation in the right workspace.

### M2-02 — Inherited configuration

**Code:** projects/settings/skills/connectors, host configuration. Depends on M2-01/M0-06.

**State:** global → project inheritance is visible through the SSOT helper `settingsForThread`, with an override diff and the conversation's context. The effective model is applied to the new session after `session/start` through `session/setModel`; the `default` value keeps the engine's choice. Local auto-compaction now respects the effective `autoCompact` value per conversation. The global isolation preference and the project `sandbox`/`networkDefault` overrides are now projected when the host launches, following the `muse serve --help` contract: restricted or enabled network, `--disable-sandbox` for authorised elevation, and `--disable-write`/`--disable-shell` in read-only mode. **Restart workspace host** explicitly replaces the process with the selected posture, detaches the conversations and clears volatile authorisations; the renderer transcripts stay available and a durable reconnection stays explicit. A host that is already alive therefore keeps its posture until the user asks for that restart; since 18 September, the bridge explicitly refuses a new diverging posture with a restart hint, so that no project believes a restriction was silently ignored; the header and Settings make that limit explicit.

**Remaining:** natively qualify two projects using distinct hosts and check the durable reconnection after a restart; no host yet allows that posture to be changed during its lifetime, so the Settings button explicitly takes on replacing the process.

**Acceptance:** two projects with different settings, removing an override, a restart and an already active host; show what is actually applied.

### M2-03 — Managed worktree

**Code:** replace the `worktrees.ts` helper with a Rust Git service; new creation actions. Depends on M2-01/M1-01/M0-01.

**State:** the Rust service `git_worktree_create` creates a real checkout under `.muse/worktrees/` from an explicit base and branch. The orchestration panel keeps the manual plan, adds an action per agent and receives the canonical path returned; the segments derived from identities are cleaned and deduplicated. The records are persisted under `muse-desktop.worktrees.v1` and can be deleted after confirmation through `git_worktree_remove`, with a confinement guard. The **Create & open** action now calls a single native command that creates the checkout and then starts the conversation rooted in it; if admission fails, the backend attempts to roll back the checkout before returning the error.

**Remaining:** qualify, on each platform, failures after admission and external Git errors. Since the current MSP host is bound to one workspace at a time, do not automatically switch an existing conversation until that cycle is designed.

**Acceptance:** two simultaneous creations, a missing branch, disk space, a partial failure; the starting checkout unchanged.

### M2-04 — Environment setup

**Code:** a new LocalEnvironment model, PTY/runner and worktrees. Depends on M2-03/M1-05.

**State:** a command typed by the user can be run explicitly in a managed worktree that has already been created. The Rust runner validates confinement, bounds the command and the output, neutralises stdin, exposes the `ready/failed/timedOut/cancelled` states, keeps the duration, the exit code and the retained environment keys, then allows a targeted rerun or cancellation from the orchestration panel. Named profiles are persisted per workspace with additional environment names; no imported setup is run at startup. **Check readiness** adds a read-only pre-check of the manifests and the required executables (`ready`, `blocked`, `needsSetup`) without running project code.

**State on 18 September 2026:** the **Setup & open** button now composes the existing operations into an explicit path: creating the checkout, bounded execution of the command with the environment allowlist, then admitting the conversation through the normal `start_session` path. After creation, **Cancel setup & open** reuses the native operation identifier to interrupt the setup; the newly created checkout is then deleted as on a failure. If the setup fails or admission is refused, the newly created checkout is deleted before handing back control; a cleanup intention stays visible if Git refuses the deletion. The separate **Create & open** button stays available when no setup is requested. The allowlist never persists values, and keeps the explicit command and the sessions hook's SSOT.

**Remaining:** native qualification of failures and cancellation during this composite path; the internal effects of a setup command cannot be undone, only the checkout is removed after a failure.

**Acceptance:** dependencies installed in the right worktree, a failed/cancelled setup and a retry; no first turn announced as ready prematurely.

### M2-05 — Handoff

**Code:** the Git/hosts/projects services, a dedicated dialog. Depends on M2-03/04 and M1-03.

**State:** the orchestration panel offers a local, read-only handoff plan for each created worktree, with an explicit **Local → Worktree** or **Worktree → Local** picker. The source/target preconditions are assessed with `pass/warn/blocked` statuses: workspace and target, conflicts, uncommitted changes, the observed target Git state and a branch already in use. The inspection now feeds the plan's cleanliness and branch lock directly; an SSOT snapshot compares the captured inputs with the current state and shows **refresh required** as soon as an inspection or a Git change makes it stale. A fresh plan with no blocker offers **Open with handoff context**: a new conversation is opened in the chosen worktree and receives in the composer a bounded note, enriched with a local excerpt of the latest user/Muse exchanges (system lines stay excluded), without claiming to have moved the MSP session. The plan then offers the observation, snapshot and transfer steps without triggering an automatic switch.

**Remaining:** atomic transfer of the MSP host, moving the context, a process lock and an explicit rollback. Ignored files are now counted by the worktree inspection and kept as a warning in the plan; their paths and contents are not transferred. As long as the host stays single-workspace, no button must present a conversation as transferred before native confirmation.

**Acceptance:** a Local ↔ Worktree round trip with tracked/untracked files; a deliberate conflict and an intermediate failure with no loss.

### M2-06 — Retention and cleanup

**Code:** the worktree store, archive, the Git service. Depends on M2-03/05.

**State:** the panel exposes **Inspect** to re-read a managed checkout's Git status (branch, changes, conflicts, ignored files and timestamp). **Inspect all** re-reads the created worktrees in parallel and shows a bounded summary of the targets inspected, clean, modified or in conflict, while keeping the detail per branch. The Rust service counts ignored files without passing their paths to the renderer, so that a hidden setup artefact stays visible as a review signal. The native inspection also counts the Muse conversations still attached to the path; retention and deletion protect them even if the Git checkout is clean. A durable per-repository policy offers to keep the checkout indefinitely or to mark it eligible after 7, 14, 30 or 90 days; only inspected, clean worktrees become eligible. Deletion stays distinct from archiving a conversation, requires a confirmation, and the Rust service refuses any dirty or still-attached worktree before `git worktree remove`. Each attempt is kept in `muse-desktop.worktree-cleanup.v1`; after a failure or a close, the record stays visible with the number of attempts, the bounded error and an explicit **Retry cleanup** action.

**Remaining:** qualification of external processes not represented by the Git markers. Never turn an archived record into an implicit deletion, nor automatically replay a persisted intention.

**Acceptance:** a clean worktree cleaned up, a dirty one kept, a target outside the root refused, an interrupted cleanup recoverable.

### M2-07 — Live sub-agents

**Code:** subagent.ts, panels, the existing RPCs. Depends on M0-01/05/08.

**Work:** check the parent/agent/child identity table; requested vs confirmed state; followup/stop/resume control and a drilldown with the available pagination. Keep a finished child's result.

**State on 18 September 2026:** `subagent_event` events normalise the lifecycle aliases provided by the host (`queued`, `running`, `completed`, `interrupted`, `stopped`, `paused`, `failed`, unknown state) and store them in the transcript. A sub-agent's `item/started`, `item/delta`, `item/updated` and `item/completed` notifications are kept in that lane with their `itemId`; a complete snapshot replaces the previous text according to its revision instead of concatenating duplicates. The block shows a state badge, closes on a confirmed termination, disables interrupt/stop for a finished agent and only makes resume available for an interrupted, stopped or paused agent. A state event with no text stays readable without exposing the raw JSON. Native qualification of two interleaved agents and the proof of resume after losing the host remain to be done.

**Acceptance:** two interleaved children, an action on a finished one, a lost host, a large result; a command on A never touches B.

### M2-08 — Concurrent writers

**Code:** fanout.ts, orchestration, worktrees. Depends on M2-03/07.

**State:** the orchestration panel exposes a pre-flight per writer: declared relative paths, bounded normalisation, refusal of traversals and detection of overlaps (file or subfolder). The declarations are persisted per workspace in `muse-desktop.writer-targets.v1`, with workspaces, agents and text bounded, then restored on a repository change with no leak between roots. A writer with no worktree or no target cannot be marked ready. Writers with no collision receive deterministic lanes (`cores - 2`, bounded to 4–8) and the following ones are represented as a FIFO queue in `src/lib/writerQueue.ts`; the computation stays pure and shares the fan-out's order. An admitted row can now build a bounded prompt in `src/lib/writerDispatch.ts`, open/reuse the worktree's conversation, send through `sendInput`, return to the parent conversation and expose the writer's state with stop and transcript opening.
**Remaining:** the MSP protocol does not yet provide a confirmed atomic cancellation nor a guaranteed complete business result. A renderer lease and a Tauri OS advisory lock bounded to the workspace now protect concurrent Muse panels and processes; the native descriptor stays open during the lease, which allows the lock to be released automatically after a crash, and the UI releases it on end, stop, failure or workspace change. A Stop acknowledgement keeps the lease and the `stopping` state until the terminal observation `writerSessionRunning=false`, and the command carries the active `turnId` when the host has announced it. At the end of an inactive session, the panel now computes a local extractive summary of the log (counters, the last assistant output and structured errors). When a host terminal event provides `resultPreview` or a structured error, that result is propagated through the session SSOT and shown first; the structured lists of issues and next steps are also shown in the Writer result; the local observation stays the fallback when the host provides nothing. Keep the dispatch on the normal start/send path until the MSP contract is verified; then add confirmed atomic cancellation and native business-result collection with a separate integration of the changes.

**Acceptance:** two writers modify the same file name in two checkouts; no overwrite; limits and cancellation match the real states.

## M3 — Tools and scheduled execution

### M3-01 — Local MCP

**Code:** ConnectorPanel/connectors.ts, a new runtime adapter. Depends on M0-06/08/14.

**State:** `mcp_local_probe` and `mcp_local_call` launch a local command only on a user gesture, speak the stdio MCP framing (`Content-Length` or JSON line), run `initialize` + `notifications/initialized`, then `tools/list` or `tools/call`. The response is bounded and the UI exposes the tools/arguments/result. The runtime now offers `mcp_local_start`, `mcp_local_refresh`, `mcp_local_poll`, `mcp_local_call_persistent` and `mcp_local_stop`: one process stays alive per connector until Stop or the app closes, responses are correlated by id, and a `notifications/tools/list_changed` triggers an automatic `tools/list` through the hook's light polling. Extensions also exposes **Reconnect with current connectors** to explicitly reapply the MCP configuration to the active conversation through `session/resume`, with the same SSOT as new starts; the button is hidden for the web preview and ephemeral sessions.

**Remaining:** wire the discovered tools into the catalogue Muse observes, and have that guard confirmed by the host's authorisation policy on each call. Explicit reconfiguration is delivered, but it still depends on a durable host that accepts the configuration during `session/resume`. The UI applies the global posture locally: Ask requests a one-off approval, Workspace keeps remote calls behind a confirmation, and YOLO allows the direct call.

**Acceptance:** a fixture server exposes then runs a tool, restarts, changes its list and fails; the call is observed in a Muse session.

### M3-02 — Remote MCP

**Code:** a dedicated transport/auth and secure storage. Depends on M3-01.

**Work:** an ADR on the supported transports, OAuth/tokens and network rules. Connection/refresh/revocation, expiry, reconnection and account isolation; do not keep secrets in the frontend registry.

**State on 17 September 2026:** `src/lib/remoteMcp.ts` implements the streamable HTTP/SSE transport with `initialize`, `notifications/initialized`, `tools/list` and `tools/call`, JSON-RPC correlation, `Mcp-Session-Id`, a bounded timeout and error messages for 401/403, HTTP and invalid JSON responses. `ConnectorPanel` requires a **Connect and list tools** action, shows the catalogue actually received, offers **Reconnect** after a session loss and keeps the bearer token in an in-memory ref of the hook; `connectors.ts` only persists the URL and the last verified revision. The Tauri bridge now exposes `secure_store_set/get/remove` on the native credential manager; explicit reconnections can re-read the token without adding it to web storage, and deleting the connector deletes its native copy. Since the M3-02 pass, a connected remote entry also exposes **Use in Muse**: `hostMcp.ts` then injects an optional `streamableHttp` configuration into new starts, cold resumes and worktrees, with the bearer passed only from the in-memory session. Six dedicated tests cover JSON, SSE, the session, network/auth refusal, an inconsistent id, excluding a remote with no session and stable credential keys.

**Remaining:** provider OAuth/refresh, a network test on each OS and the remote tool catalogue on the Muse host side. The configuration of an active session is now reapplied only after the explicit **Reconnect with current connectors** action; a host that refuses the configuration on resume keeps its previous state and reports the reconnection error. Automatic reconnection is limited to 401/403: it redoes a handshake with the bearer kept in memory and replays a single call; relaunching the application still requires an explicit reconnection, which can re-read the bearer from the native secret store.

**Acceptance:** a real test server, an expired token, a network refusal and a disconnection; the UI status confirmed by an actual exchange.

### M3-03 — Extension lifecycle

**Code:** ConnectorPanel/registry/runtime. Depends on M3-01/02.

**State:** a successful local probe can record the command, the server version and the discovered tools in the persistent registry. A new list replaces the existing entry without re-enabling a disabled extension; `listConnectorTools` immediately removes its tools when the status moves to `disabled`. Registered local connectors can be started, stopped and refreshed explicitly from the panel; a failure or an empty list does not replace the last usable version, and `tools/list_changed` triggers the same refresh through the SSOT path. A copy of the previous revision is kept for an explicit, single-step rollback. Verified local or remote connectors now keep a **Use in Muse** opt-in, reused by catalogue refreshes before injection when a conversation starts.

**Delivered on 17 September 2026:** an `.mcpb` file is parsed and bounded on the renderer side (manifest, semver, Node/Python runtime, entry point, arguments and paths), then passed as a list of base64 files to the Tauri bridge. The bridge installs each revision under `app_data/mcp-packages/<id>/<version>` with staged writing and an atomic commit; no existing version is overwritten. The server is probed through the real MCP handshake before registration. The registry keeps the source, file name, version, runtime and install path; an update explicitly stops the old runtime, replaces the command and keeps its previous revision for **Roll back**. A validation/probe failure cleans up the new revision and leaves the old entry intact. Deletion also removes the active revision when the native runtime is available.

**Remaining:** stopping during a call, and the catalogue of the tools really visible to the Muse engine; the per-call permission authority remains to be confirmed on the host side, the UI guard now being explicit. Bundles are installed locally from a file chosen by the user; remote distribution, signing and automatic updates belong to M4-09.

**Acceptance:** a failed install, an incompatible update, disabling during a call and deletion; registry and runtime consistent.

### M3-04 — SKILL.md discovery

**Code:** skills.ts/SkillPanel, a new native scanner. Depends on M2-01/M0-06.

**Work:** define scopes and precedence, a metadata parser, resource paths, deduplication and reloading. A relative resource stays tied to the skill's folder; bounded reading and visible errors.

**State on 16 September 2026:** `skills_scan` reads the workspace's conventional roots with bounds on depth, size and number of documents. The frontmatter parser, the validation of relative resources, the project > repo > team > builtin priority and explicit refresh are delivered; the panel shows provenance and errors. The resources are not yet loaded into the engine context, which remains M3-05.

**Acceptance:** skills with the same name, a malformed file, a missing resource, project scope and a change on disk; exact provenance.

### M3-05 — Skill invocation

**Code:** Composer, the skills resolver and the engine adapter. Depends on M3-04/M0-08.

**Work:** explicit invocation, loading the instructions and resources through the engine contract; progress/discovery with an understandable trace. Suggestions must not claim to run a skill. The progress state stays ephemeral and must stay derived from the session hook, while the host's events are authoritative for the start and the end.

**State on 17 September 2026:** a slash invocation of a discovered skill re-reads its relative resources just before sending, through `skills_read_resources`. The contents are bounded and tagged with their path, and a vanished file fails the send with an explicit system entry; retries reuse the outbox expansion. A verified host skill is sent as a native `skill` part; the hook now exposes `preparing`, `loading-resources`, `sending`, `queued`, `running`, `completed`, `failed` and `unknown` per conversation. Extensions announces the step and the detail without persisting that state. Additional native resources, the detailed invocation contract on the host side and live qualification remain to be confirmed.

**Acceptance:** a real invocation with a resource, a skill deleted between suggestion and sending, a refused permission; no double insertion on retry.

### M3-06 — Real scheduler

**Code:** schedules.ts/SchedulesPanel, a new scheduling service outside the React cycle. Depends on M0-09/M2-01; M2-03 for worktrees.

**Work:** separate Schedule and Run; capture the project/workspace/model/skills/policy, never "the session active at the time of the tick". An occurrence creates a durable run, then executes; the inbox contains the result, not a request to click before each run.

**State on 18 September 2026:** `Schedule` and `ReviewItem` now capture the workspace, the project, the model and the authorisation policy at creation time. Approval checks the target conversation's workspace and project, resolves the captured project settings through the same inheritance function as the UI, then reapplies the model/policy before sending; a mismatch is refused explicitly. The workspace and YOLO modes now dispatch with no click and feed a bounded local `ScheduleRun` log, visible in Automations. A structured end of turn marks the run `completed` or `failed`, keeps the assistant preview and sends retryable errors into M3-07's bounded retry; the interface also exposes the next trigger computed from the cron/time-zone cursor shared with the dispatcher. A host stop stays a non-retried failure, because its outcome is ambiguous. The native multi-instance scheduler, resume after a crash/sleep and rich business output remain to be implemented.

**Acceptance:** one-shot/recurring, a fixed target despite navigation, a start failure, automatic dispatch according to the policy and local history; the run stays explicitly bounded to the turn's admission as long as the host provides no usable completion event.

### M3-07 — Scheduler recovery

**Code:** scheduler/store; depends on M3-06.

**Work:** a unique schedule + occurrence key, claim transactions, a catch-up policy, time zone/DST, bounded retry with backoff and cancellation. Distinguish a closed machine/app from an interrupted run; never blindly relaunch an external operation whose outcome is ambiguous.

**State on 18 September 2026:** occurrences now carry `occurrenceAt`/`occurrenceKey`, missed crons follow `latest` or `skip`, and the log limits failures to three attempts with a 15/30/60-second backoff. A pending retry can be cancelled from Automations; ambiguous timeouts are never relaunched automatically. The renderer still uses `muse-desktop.scheduler-lease.v1` in preview, while a Tauri build also acquires, renews and releases `muse-desktop.native-scheduler-lease.v1` in the Rust supervisor: an open file makes the claim exclusive between independent processes, and closing it releases the lease after a crash. Runs and schedule definitions are now copied under `app_data/scheduler/` with a schema envelope, size bounds and staging + rename; their renderer → native writes are serialised and coalesced, then at startup the hook merges the two copies by occurrence or cursor before resuming its transitions. The scheduler immediately re-evaluates occurrences on `focus`, `pageshow` and a return to visibility, and IANA time zones are resolved to wall-clock time, including DST gaps and overlaps. At boot, non-terminal runs with no proof of result are now marked `recovery: after-restart`, shown as **Review needed** and blocked until an explicit **Mark failed** action; no ambiguous external operation is replayed automatically. Automations now exposes the result of the last lease check in four states and the check time, with an explicit explanation when this window is waiting for another instance, as well as the next trigger or the **Due now** state computed by `nextScheduleOccurrence`. On Windows, the supervisor schedules a one-off `Muse-Desktop\AutomationWake` task; on macOS it writes a `com.muse.desktop.automation-wake` user job in `~/Library/LaunchAgents`, and on Linux a user service/timer in `$XDG_CONFIG_HOME/systemd/user` (or `~/.config/systemd/user`) for the next enabled occurrence. These triggers only relaunch the executable with `--automation-wakeup`, after which the renderer SSOT resumes the normal reconciliation. The status and the due time are visible in Automations, and the trigger is replaced or deleted on each schedule change; native calls are serialised and coalesced so that the last definition wins.

**Remaining limit:** the native lease now arbitrates between Tauri processes, and the definitions/runs are durable under app data. All three platforms now have a one-off user trigger; that still depends on a user session and is not yet a background business service. The native proof of the host's state after a crash, a locked machine, sleep/wake and the qualification of these triggers on each OS remain to be done.

**Acceptance:** sleep/wake, a clock change, a double instance, a crash between claim and start, deleting a schedule; no duplicate occurrence.

### M3-08 — Results inbox

**Code:** ReviewQueuePanel to evolve, the Runs store; depends on M3-06/07.

**Work:** queued/running/succeeded/failed/cancelled statuses, timestamps, summary, target and conversation link. Open/retry/archive actions; unread kept separate from the business status.

**State on 18 September 2026:** Automations shows the last eight runs with status, timestamp, bounded preview, error, unread indicator, opening the conversation and marking as read. A run moves to `completed` at the host's first stop status and keeps the preview of the last assistant response; before that event, it stays `running` even if `send_input` was acknowledged. The list now offers the Active/Unread/Queued/Running/Completed/Failed/Archived filters, durable archiving and restoring, as well as Retry now for an error or a deferred retry. Each run can also be expanded to inspect the target, authorisation, model, workspace, occurrence, attempt, duration, instructions, result and error. At the end of a run, Muse also persists a bounded extractive summary (headline, counters, files mentioned, issues and next steps explicitly introduced by **Next steps**, **Todo**, **Follow-up** or **Remaining**) derived from the local log; it is presented in the row and in the detail with no extra model call, and the next steps stay observations, never inferred actions. When a terminal event already provides `result`, `resultPreview`, `output`, `summary` or `text`, the Rust bridge bounds it before passing it to the renderer, which keeps it before using the last assistant response. The structured `issues`/`warnings`/`blockers`/`risks` and `nextSteps`/`todo`/`remaining` lists provided by the same terminal result are now filtered, bounded, redacted and merged with the local recap before persistence.

**Remaining limit:** the rich business summary and an end-of-run signal provided directly by the host remain to be qualified.

**Acceptance:** no result presented before termination, a durable history and opening the right session after a restart.

### M3-09 — Notifications

**Code:** `src/lib/notifications.ts`, `useMuseSessions` and `SchedulesPanel`; depends on M3-08/M0-12.

**State on 19 September 2026:** the local inbox is delivered for finished/failed runs and for authorisation or user-answer requests: each entry keeps an idempotency key, a preview, the target session and an unread state; Automations lets you open the conversation, open a run with no session, mark an entry, and acknowledge all unread notifications in one action. A run that fails before a session is created now stays actionable: **Open run** opens Automations instead of losing the click. In a Tauri build, the permission request and the sending now use `tauri-plugin-notification`; the web preview keeps the `Notification` API as an explicit fallback, without replaying the histories at startup. The desktop mute preference is persisted separately. Toasts and terminal-run notifications stay disarmed until the native ledger merge finishes, so that a historical row is never replayed as something new at startup. Tauri notifications now declare the **Open conversation** action and carry only the bounded routing identifiers; `App` goes through the pure resolver `resolveNotificationRoute`, which validates the session then opens the thread directly, or opens the run's inbox if only the `runId` reference is known, and the web fallback emits the same event. If the action arrives before `session/list` or the run ledger is rehydrated, it is kept until the SSOT is available, then expires after 30 seconds. The inbox is now mirrored in `app_data/notifications/notifications.json` with a schema envelope, a size bound and an atomic write; the hook merges the copies by `dedupeKey` before writing the next state, and serialises the native writes so that a burst of notifications cannot reinstall an older snapshot. Run notifications now separately copy the explicit issues and next steps, bound them for persistence, and show them in a **Result details** disclosure in the inbox. Persisting a scheduler/notification while the app is closed, and OS qualification, remain open.

**Remaining work:** a native OS/Tauri service when the application is closed, and qualification of the action prompt on each platform. No notification per token or tick.

**Acceptance:** a single notification, a click opens the target, a deleted target, the OS refuses, and mute mode respected.

## M4 — Studies, then extended capabilities

The studies produce an ADR with the API actually available, a minimal prototype, OS/permission constraints, costs and a go/no-go criterion. A no-go stays visible in the roadmap, with no screen suggesting availability.

### M4-01 — Browser

**Code:** BrowserPanel and a new native surface; depends on M0-06/14. Compare a dedicated webview with a controllable browser engine, sessions/cookies, navigation, downloads and embed restrictions. **Acceptance:** real non-iframe sites, network errors and isolation; no dangerous URL loaded through an unplanned protocol.

**State on 19 September 2026:** a first UI pass delivered in `BrowserPanel`: a normalised URL, back/forward history, Reload, the URL actually displayed, load/protocol errors and up to eight local tabs restored under `muse-desktop.browser.tabs.v1`. Navigation is now persisted under a key derived from the conversation's `sessionId`, and the panel is remounted on a conversation change; a session can therefore no longer pick up another one's tabs. Persistence only contains http(s) URLs and a bounded history. An explicit same-origin link download is now available: on desktop, `browser_download_fetch` makes the native request with no credentials, refuses redirects, bounds the stream to 10 MiB and returns a base64 payload to the Tauri destination dialog; the web preview keeps a credential-free fetch, then a bounded Blob. `<a download>` links triggered by a same-origin page are intercepted and reuse that same bounded path, with the **browser** computer-use grant. The file name is reduced to a safe basename and the desktop write is validated on the Rust side. **Open native** now derives a dedicated window from the `sessionId`, closes another conversation's surface before opening and enables the private, non-persistent profile; **Close native** only targets the current conversation and stays idempotent. The iframe sandbox stays a bounded preview; download responses initiated by navigation and multi-platform qualification remain to be qualified.

### M4-02 — Visual annotation

**Code:** browserAnnotate.ts, capture and the composer; depends on M4-01/M1-08. Define URL/frame/viewport/region/element/version with a real capture; keep the provenance and flag a stale context. **Acceptance:** a scrolled selection, an iframe, zoom, and sending the correct image/anchor.

**State on 19 September 2026:** the text anchor uses the normalised URL actually displayed, and notes are filtered by that URL. In a same-origin iframe, a click produces a bounded DOM anchor (selector, tag, role, label and text) that stays passive metadata. **Add page context** and **Add to prompt** insert into the active composer a bounded block with provenance, URL, selection, comment and element anchor. **Capture visible page** explicitly asks for a source through `getDisplayMedia`, shows a preview with a review zoom control bounded to 100–250 % and a scrollable viewport, lets you select and crop a region, adds the captured image as an MSP attachment and keeps the URL, time, viewport, DPR, region coordinates and element anchor in the context; the sessions hook centralises the prefill and the attachment. The capture request keeps the navigation generation and the normalised URL; if the user navigates or reloads during the screen picker, the stale pixels are refused before reaching the composer and the panel asks for a new capture. Explicit sizing of the image and the canvas keeps the pointer matched to the source pixels, including when the preview is zoomed. Cross-origin pages keep the manual fallback; automatic capture of the iframe alone and native qualification remain to be produced.

### M4-03 — Browser driving

**Code:** a browser tools adapter; depends on M4-01/M3-01 and a compatible engine. Expose observe/click/type/navigation with an explicit surface and session, stop and errors; treat page text as untrusted data. **Acceptance:** a complete web workflow, an unexpected navigation and a stop without acting on another tab.

**State on 18 September 2026:** a first local slice delivered in `BrowserPanel`: **Observe page** collects the title, text, links and controls of a same-origin iframe, bounded and with provenance; **Navigate selected link**, **Open in new tab**, **Click selected element**, **Type into field** and downloading are explicit gestures limited to the selected element, visible text fields and the current frame, and now require the **browser** computer-use grant (denied by default). Navigation checks the http(s) origin, reuses the tab's history, can preserve the current tab by opening a new bounded surface and refuses external links. The `browser.*` skills announced by the host are now routed from the panel with a bounded URL/element/value; during an active browser invocation, **Stop Muse action** calls `cancel_session` through the SSOT and waits for the end confirmation. The observation context is marked as untrusted content and triggers no IPC. Remaining: native qualification of a long workflow, cross-origin/native WebView2 and proof of a host that actually serves these skills.

### M4-04 — Computer use

**Code:** a separate service per OS; depends on M0-06 and engine feasibility. OS authorisations, an app inventory, targeted capture/action, interruptions and a minimal log. **Acceptance:** a test application, a refused permission, a vanished window, the user taking back control; no action after stop.

**State on 18 September 2026 — first Windows slice delivered:** `src-tauri/src/desktop_control.rs` exposes a runtime status, a bounded inventory of visible, titled top-level windows, a read-only observation of child controls (title, Win32 class, UI Automation semantic role and automation identifier when available, relative geometry, visibility and enabled/disabled state), as well as bounded states/previews taken from `ValuePattern`, `RangeValuePattern`, `SelectionItemPattern`, `TogglePattern` and `TextPattern` for non-sensitive elements. Elements marked password, and names/roles/identifiers that look like secrets, tokens, codes or credentials, are flagged `valueRedacted` without passing their content. Native texts and renderer labels also strip replacement markers, control characters and invisible formats before display or copy. Focus, capped UTF-16 text injection, a key allowlist and a click within the observed bounds are also delivered; each observed row now offers an explicit click on its relative centre, with the same bounding. UI Automation is preferred, and the Win32 fallback is explicit when a window refuses COM access. `DesktopControlPanel` is reachable as a work panel and shares the persisted computer-use permission; that preference is reaffirmed in a volatile native lock after each launch, and the bridge refuses controls until explicit consent has been resynchronised. The observation can be added to the composer with its provenance through the prefill SSOT. The same panel also requests a `getDisplayMedia` gesture, previews the chosen surface and passes a capture as an explicitly attributed attachment to the composer. When the host announces a `computer.*` selector, the adapter reuses the existing skill invocation, outbox and targeted stop with a bounded payload. Platforms with no runtime return `supported: false`. The Node tests cover the default authorisation, coordinate bounding, bounded observation, masking of sensitive values, semantic states, capture provenance and selector filtering; Cargo covers the native types and the Windows build. Qualification of native consent and the interactive scenario stay separate.

**Remaining:** rich structure, selections and relations of complex documents, qualification of a `computer.*` selector actually served by a host, qualification of the Windows dialog and the macOS/Linux implementations. This slice must not be presented as autonomous desktop control: the host invokes no native command from the catalogue without a verified contract and consent.

### M4-05 — Rich artefacts

**Code:** artifacts.ts, previews and the files service; depends on M1-07/08. Separate image/document generation on the engine side, persisted files and safe rendering; detect supported formats, the real version/source and export. **Acceptance:** a file opened outside the app, a failing preview with a fallback, exact version and provenance; do not treat a Markdown block as a delivered file.

**State on 19 September 2026:** the Content panel now exports a precise version of an artefact, offers **Preview/Source** for Markdown documents and lets you open the content for bounded editing. A selection in the preview or the source block can be kept with the note as a quotation bounded to 240 characters; old versions with no quotation stay valid. **Save as new version** keeps the version produced by Muse, creates a distinct local version and persists it under the artefact's SSOT; no new assistant response can overwrite that edit, and the 120,000-character limit is applied before writing. The preview reuses the safe content renderer, with no HTML or script interpretation; the source and the provenance stay unchanged. On desktop, `save` opens the native picker, then `artifact_export` writes a UTF-8 file bounded to 2 MiB; the web preview keeps a browser download. Files also decodes recognised images and PDFs under 5 MiB into a bounded base64 preview, including textual SVGs, then offers opening in the system as a fallback. Valid CSV, TSV and JSON get a bounded local table (100 rows, 20 columns, 400 characters per cell, 40,000 characters inspected), while malformed inputs fall back to raw text. DOCX/XLSX/PPTX/ODT/ODS/ODP containers up to 5 MiB are now read locally: paragraphs, a bounded first sheet and slide text are shown as a table without running macros, formulas, relations or media. ZIP extraction is filtered before inflation: only the useful XML parts are kept, at 4 MiB per entry, 8 MiB in total and 500 entries examined. The transcript bridge also keeps the `modelVisibleContent` metadata and bounded `outputRef`s; **Preview output** loads the `item/readOutput` outputs in 64 KiB blocks, renders complete base64 images in the originating lane, shows complete PDFs up to 5 MiB in the WebView's viewer and offers **Save output** on desktop through a Rust base64 write bounded to 10 MiB, with **Open in app** for verified workspace paths. The web preview keeps the browser download. The absolute destination, the existing parent folder and the absence of NUL are checked on the Rust side. RTF documents now get a bounded text extraction (paragraphs, \u/\'/par/tab escapes, metadata destinations ignored), wired into Files and into the stream. What remains is wiring the image/document outputs actually produced by the engine, office formats beyond OOXML/ODF/RTF and qualification on each platform.

### M4-06 — Hosted sharing

**Code:** SharePanel/sharing.ts and a new remote service; depends on a hosting/auth decision. Create a snapshot with explicitly included data, permissions/token, duration and revocation; secrets excluded. **Acceptance:** a second client, a revoked link, an incomplete export and a publication error; no URL announced before its real creation.

**State on 19 September 2026:** the local Markdown/JSON export can now be saved through the native dialog on desktop, with a download fallback in the web preview and a visible error on failure. Before creation, known credential-shaped values are replaced, entries are capped at 400 and at 12,000 characters per entry, the body at 240,000 characters, and the bundle persists `redacted`/`truncated`/`omittedEntries` so that the interface flags a bounded export. The SSOT keeps at most 100 bundles, including the revoked history, so as to stay recoverable after many exports. The bundle stays explicitly local and revocable only within the profile; no public URL is fabricated. What remains is the hosting service, identity, lifetime and revocation observable from a second client.

### M4-07 — Remote/cloud

**Code:** `src/lib/hostConnection.ts`, `test/hostConnection.test.ts` and `SettingsPanel.tsx`. A pure `HostConnection` model, strict typing (`local`, `remote-ssh`, `cloud-runner`), a state machine (`disconnected`, `connecting`, `connected`, `reconnecting`, `error`), exponential backoff computation, heartbeat evaluation with a configurable timeout, isolated session routing with no orphans and clean environment teardown. Integrated into `SettingsPanel` under the `muse-desktop.host-connections.v1` key.

**State on 19 September 2026:** the HostConnection abstraction is delivered with support for the 3 environment types, masking of authentication secrets, validation of SSH/HTTPS endpoints and 11 passing unit tests (775 Node tests in total).

**Remaining work:** the native runtime for interactive SSH transport and a remote cloud container.

### M4-08 — Voice

**Code:** an audio module and composer integration to create. An ADR on transcription only vs real-time dialogue, providers and microphone consent. Handling cancellation, latency, errors and no implicit audio retention. **Acceptance:** microphone absent/refused, interruption, transcription editable before sending and an unchanged destination.

**State on 18 September 2026:** a first slice delivered in `src/lib/voice.ts` and `Composer`: standard/WebKit detection, an explicit `getUserMedia` pre-request on click, immediate stop of the temporary tracks, continuous editable transcription, an explicit stop and bounded messages for refusal, a missing microphone, silence or an unavailable API. The text only joins the draft; no audio stream is persisted or sent to the host. Remaining: the provider/real-time decision, native microphone permission per OS and qualification of an interruption during sending.

### M4-09 — Distribution

**Code:** Tauri config, the bridge, build scripts and CI. Depends on M0-10/14. An OS/architecture matrix, the supported engine, binary provenance/checksums, signing per channel, signed updates and recovery. **Acceptance:** install on a clean machine, update from the previous version and uninstall without erasing projects; evidence specific to each platform.

**State on 18 September 2026:** after each requested bundle (`nsis`, `msi` or `all`), `scripts/build-windows.ps1` now generates an adjacent manifest through `scripts/release-manifest.mjs`. The `muse-desktop.release-manifest.v1` schema is deliberately deterministic: the file name, size and SHA-256 of the installer and of the sidecar, with no local path or timestamp. The explicit `x86_64-pc-windows-msvc` build produced and verified the NSIS and the MSI on 17 September 2026; an NSIS rerun on 18 September produced a 5,297,801-byte x64 installer and validated the manifest against the supplied sidecar. `scripts/verify-release-manifest.mjs` compares these explicitly supplied files and flags a size or fingerprint change before installation; it also verifies an optional Ed25519 signature when the trusted public key is supplied explicitly. `scripts/release-update.mjs` now adds a `muse-desktop.release-update.v1` plan, a staging area copied and published atomically, then a `current`/`previous` switch with transactional rollback; with `--public-key --require-signature`, the signed plan is revalidated at each step. `scripts/release-launcher.mjs` requests a bounded stop of the current PID, waits for it to disappear, applies the candidate with no shell, then relaunches the executable detached; a startup failure restores the slots. The valid, tampered, applied, relaunched then handoff scenario is tested locally with 684 Node tests. `npm run release:installer -- --pid … --installer …` stops Muse and explicitly delegates to an NSIS `.exe` or MSI installer through `msiexec.exe`, still with no shell. `npm run release:delta -- create|apply` produces and rebuilds a compressed local delta, verified by the source/target fingerprints and published by atomic rename; the caller can measure `useDelta` and keep the full artefact if the delta is larger. `npm run release:channel -- build|verify|select` generates and checks a signed channel index, then picks the latest compatible target. `npm run release:fetch -- fetch` retrieves a declared HTTPS asset with no redirect, bounds the body, checks the size and the SHA-256, then publishes the file by atomic rename. `scripts/release-orchestrator.mjs sync` verifies the signed channel, selects the compatible target, retrieves both assets, revalidates the manifest and publishes a staging candidate ready for the launcher. What remains is operational hosting, key management and macOS/Linux qualification. The reconciliation smoke test is now documented separately so that the sidecar's `methodNotFound` output is not mistaken for an application failure.

## Handoff format

To fill in with each PR or delivery note:

```text
Roadmap ID / sub-ticket:
Base and delivered commit:
User scenario before → after:
Design / UI / Function / Validation before → after:
Contracts and migrations added:
Files changed and role:
Tests: command, platform, engine version, result:
Live vs fixture evidence:
Remaining limits and dependencies:
Next concrete sub-ticket:
```

Only declare a parent finished once all of its acceptance criteria are covered. The next recommended batch is the **native proof of M0-01c/M0-02c** (two workspaces, failure/reconnection, approval and resuming a turn), now that the renderer and liveness paths are wired. M2-08 now has renderer dispatch to the worktree conversations, a native lock per target and the projection of the available host completions; atomic cancellation and the complete business result stay conditional on the engine's writer/spawn contract. M3-07 has a one-off wake-up on Windows, macOS and Linux; OS qualification, resume after sleep/lock and the host proof remain open.
