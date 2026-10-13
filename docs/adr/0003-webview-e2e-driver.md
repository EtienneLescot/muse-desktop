# ADR 0003 — Drive the app end to end over CDP, on Windows, against the Muse fixture

- **Status:** accepted for M0-14; amended on 2026-10-13 for macOS (see the end)
- **Date:** 2026-10-05
- **Context:** M0-14 asks for an isolated end-to-end check, run before merging, that catches a wrong A/B route and a lost send, with a Tauri driver chosen from the platforms' real support. The facts:
  - `tauri-driver` (WebDriver) supports Windows and Linux only. On Windows it needs Microsoft Edge Driver at the version of the WebView2 runtime; on Linux, WebKitWebDriver (`webkit2gtk-driver` on Debian). macOS has no WKWebView driver: there it takes CrabNebula's fork (paid API key) or the `tauri-plugin-wdio-webdriver` plugin compiled into the app, driven by WebdriverIO.
  - WebView2 is Chromium. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` exposes the Chrome DevTools Protocol with no driver and no version to match. Every native campaign of this repository already drives the app that way (`scripts/cdp-harness.mjs`, `scripts/cdp-*.mjs`).
  - An elevated host ignores the `WEBVIEW2_*` flag variables and honours only the options the app passes to WebView2 (Microsoft, *Develop secure WebView2 apps*). A GitHub Windows runner runs elevated: measured on `windows-latest` on 05/10/2026, WebView2 153 opened no port and the flag was absent from its browser process.
  - WKWebView (macOS) and WebKitGTK (Linux) expose no CDP.

## Decision

On Windows, CI drives the debug build over CDP with the existing harness: `npm run e2e:fixture` (`scripts/e2e-fixture.mjs`), job `e2e-windows` of `.github/workflows/ci.yml`. No driver to install, no new dependency.

The app starts in an isolated test mode, compiled into debug builds on Windows only (`src-tauri/src/test_mode.rs`):

- `MUSE_DESKTOP_TEST_DATA_DIR` turns it on. That folder holds the app data (outbox, scheduler, notifications, computer use, MCP packages) and the WebView2 profile: the app sets `WEBVIEW2_USER_DATA_FOLDER` itself, which overrides the folder Tauri passes to WebView2. The elevated runner honours it; the check verifies it on every run.
- The computer-use service of a test instance listens on a pipe named after that folder, not on the user's: on the shared pipe, a level change or a revoke would stop and replace the user's own service. The relay the engine starts reads its level ceiling from the same folder.
- The mode never goes unnoticed: one line on stderr, `testMode: true` in the native diagnostics, and `test-mode.pid` written in the folder at startup.
- `MUSE_DESKTOP_TEST_SIDECAR`, a JSON argv, replaces every local engine. Missing or malformed, the start fails: a test instance never runs a real local engine. A remote target (`ssh://`, ADR 0002) that the test profile itself configured is reached over the system ssh, as outside test mode; a test that configures no remote target never leaves the fixture, as in CI.
- `MUSE_DESKTOP_TEST_CDP_PORT` opens CDP through the window's `additionalBrowserArgs`, a WebView2 option, so an elevated host keeps it.
- `MUSE_DESKTOP_TEST_REMOTE_MCP`, exactly `http://127.0.0.1:<port>`, is the one origin a remote MCP connector of the test instance may use over plain HTTP: the M3-02 bearer proof's local server (`scripts/mcp-bearer-test-server.mjs`). The renderer learns it only from the Rust side (`test_remote_mcp_origin`, `null` outside test mode). Every other URL keeps the public-HTTPS rule, and no TLS check changes.
- The single-instance guard and the OS wake-up task are skipped. The test instance runs beside the user's own and never edits the per-account `schtasks` entry.
- In a release build, and on macOS and Linux, `test_mode::data_dir()` is `None` by construction: no variable is read, no branch can switch on. There the mode would lift the single-instance guard without moving the WKWebView or WebKitGTK store.

The runner starts nothing it cannot trust:

- It refuses an exe that does not contain the string `MUSE_DESKTOP_TEST_DATA_DIR`: a release build, or a debug build without the test mode, would run on the user's own profile and engine.
- It strips every `WEBVIEW2_*` variable from the app's environment.
- It kills the app when `test-mode.pid` does not appear within 10 s.
- Once CDP opens, before driving anything, it reads the WebView2 browser's `--user-data-dir` and stops unless it lies under the test folder. An elevated host ignores the `WEBVIEW2_*` variables but still honours the HKLM WebView2 policies, so a machine policy could move the profile.
- A watchdog prints the verdict and fails the run at 6 minutes, before the CI step stops at 8; the CDP calls are bounded. The diagnostics are uploaded on failure or cancellation.

The engine is `scripts/muse-fixture.mjs`, the newline JSON-RPC fixture with a durable in-memory store. Its `initialize` passes the handshake validator (schema 1, `sha256:` fingerprint). Its approvals behave as on the 1.4.2 host:

- each stage arrives twice, as the `approval/requested` notification and as the `approval/request` server request;
- the requirement token is the object `{approvalId, sourceIndex}`, carried as `currentRequirementId`;
- `approval/decide` refuses a choice not offered (-32052), a stale stage (-32053) and a resolved approval (-32051);
- `abort` resolves as a denial: the turn ends without running the action;
- `[fixture:two-stage]` in a turn's text gives a two-stage approval, the first decision answering `terminal: false`.

Its ids are unique per process, one process per workspace. A `turn/start` whose text holds `[fixture:exit]` kills it before it answers.

The check, in a fresh temp folder:

- **A/B:** projects A and B are created from the welcome screen, the folder dialog answered by the harness. A turn and an approval card in each. Allow once on A's card: only `approve(A)` is sent, A's turn ends, B's card stays pending at the same requirement, in the host and on screen. B is then decided on its own.
- **Lost send:** B's host dies on the next `turn/start` before answering. The text must still be in the transcript, the outbox or the native outbox ledger, and on screen, as a bubble or an unsent row. A's host still answers.
- **Isolation:** the WebView2 profile and the app data were written in the temp folder.

It catches both faults: on 05/10/2026 a decision sent to the other conversation's card, then a refused send dropped with its bubble, each turned `e2e-windows` red with the matching verdicts false. Both were temporary commits, reverted.

## Alternatives rejected

- **`tauri-driver` with Edge Driver on Windows:** one more binary to fetch on every run and to keep at the runtime's exact version, for the same Chromium underneath, and a second harness beside the one the native campaigns use.
- **WebdriverIO with the embedded plugin on every platform:** an HTTP automation server compiled into the app and a JavaScript test stack, for a macOS run that CI does not have.
- **A mocked IPC in the renderer:** the unit tests already do that. It skips the Rust bridge, the stdout pump and a real child process, where a route or a send can be lost.
- **Overrides honoured in every build:** a shipped app must not be pointed at another engine or another profile by its environment.

## Consequences

- `npm test` stays free of any app or engine. `npm run e2e:fixture` needs a built debug app (`npm run build`, then `cargo build --manifest-path src-tauri/Cargo.toml`) and runs on Windows only. The CI job takes about five minutes, most of it the debug build.
- **macOS:** superseded by the amendment below.
- **Linux:** no end-to-end check in CI, and no test mode. `tauri-driver` with WebKitWebDriver would work once the test mode moves the WebKitGTK data folder, which Tauri derives from the app's local data folder.
- The fixture is a protocol double, not a model. It does not replace the native campaigns on the real engine.
- The test mode isolates writes, not reads: the startup probe, the Muse sign-in status and the skills and rules scans still read the machine's own configuration.
- A native proof that points `MUSE_DESKTOP_TEST_SIDECAR` at the real engine leaves that engine's own data root as it is: its conversations go to the user's session store (`~/.local/share/muse/sessions` on Windows) and its user settings apply (an MCP server declared there starts in the test conversations).
- The keyring service `com.muse.desktop.mcp` is shared even in test mode: test mode does not isolate Windows Credential Manager. Only a user action writes to it (connecting a remote MCP server with a token), and the check takes none. Its keys derive from the connector's name (`remote-mcp-<id>`), so a test connector named like one of the user's reads and overwrites the user's token: a native proof names its connector uniquely per run and forgets or removes it before it ends.
- A failing run prints its verdict, masked and bounded, in the job log and in a seven-day artifact. So does a run that hangs, through the watchdog.

## Amendment — macOS, 13 October 2026

Decided with Étienne on 13/10/2026, before any macOS ticket proof: the test mode and the check run on
macOS too, through a bridge compiled into debug builds.

- **Test mode on macOS debug builds.** `test_mode::data_dir()` reads the switch on Windows and macOS
  debug builds; a release build, and Linux, still compile it to `None`. The app data, the
  computer-use socket (named after the folder, in the user's `$TMPDIR`), the fixture sidecar, the
  skipped single-instance guard and the skipped wake-up task (`launchd` here) behave as on Windows.
- **The WKWebView store moves.** Tauri does not read `dataStoreIdentifier` from the window
  configuration, so in macOS test mode the configured windows are not created by Tauri:
  `test_mode::setup` builds them with `data_store_identifier`, a UUID derived from the test folder
  and written to `webkit-store` in it. WebKit keeps that store under
  `~/Library/WebKit/<exe name>/WebsiteDataStore/<uuid>`: in the user's Library, but a store of its
  own, never the default one of the installed app (`~/Library/WebKit/com.muse.desktop`).
- **The bridge.** WKWebView has no CDP. `src-tauri/src/test_bridge.rs` serves, on
  `127.0.0.1:<MUSE_DESKTOP_TEST_CDP_PORT>`, the CDP subset the proofs use: `/json/list`, one
  WebSocket per window, `Runtime.evaluate` (through `callAsyncJavaScript` in the page world, promises
  awaited, throws as `exceptionDetails`), `Input.insertText`, `Input.dispatchKeyEvent`,
  `Input.dispatchMouseEvent` (AppKit events handed to the WKWebView: `isTrusted` is true, no
  Accessibility grant, the app is not activated), `Page.captureScreenshot`, `Page.reload`,
  `Page.add/removeScriptToEvaluateOnNewDocument`, the colour scheme of `Emulation.setEmulatedMedia`
  and the window bounds. Console errors and uncaught exceptions are relayed as events. Every other
  method answers -32601, so a proof never takes a missing emulation for a pass: reduced motion,
  contrast, `Performance.getMetrics`, `DOM.setFileInputFiles`, the mouse wheel and the network
  calls are among them. The module is compiled only with `debug_assertions` on macOS and started
  only by test mode; Safari's Web Inspector can also attach to the test window.
- **The runner.** `npm run e2e:fixture` runs on macOS against `src-tauri/target/debug/muse-desktop`.
  Before driving anything it writes to `localStorage` and checks that the test store appeared and
  that neither default store (`com.muse.desktop`, nor the debug exe's own `WebsiteData`) changed by
  a single file; it checks again at the end, kills the app's process group and deletes the test
  store. The CI job `e2e-macos` runs it on `macos-14`.
- **Real engine.** As on Windows, a native proof points `MUSE_DESKTOP_TEST_SIDECAR` at a pinned
  engine binary, never at the self-updating launcher `~/.local/bin/muse`
  (`scripts/macos/pin-engine.sh`, with `MUSE_NO_AUTO_UPDATE=1`).

Limits on macOS, beyond those above: the Keychain service `com.muse.desktop.mcp` is shared, as
Windows Credential Manager is; a TCC prompt (folders, notifications, Accessibility, Screen
Recording) belongs to the debug exe, not to the installed app, so anything about the installed
app's permissions, the DMG, first launch or `launchd` is proved on the release build, natively, with
Étienne.
