# ADR 0003 — Drive the app end to end over CDP, on Windows, against the Muse fixture

- **Status:** accepted for M0-14
- **Date:** 2026-10-05
- **Context:** M0-14 asks for an isolated end-to-end check, run before merging, that catches a wrong A/B route and a lost send, with a Tauri driver chosen from the platforms' real support. The facts:
  - `tauri-driver` (WebDriver) supports Windows and Linux only. On Windows it needs Microsoft Edge Driver at the version of the WebView2 runtime; on Linux, WebKitWebDriver (`webkit2gtk-driver` on Debian). macOS has no WKWebView driver: there it takes CrabNebula's fork (paid API key) or the `tauri-plugin-wdio-webdriver` plugin compiled into the app, driven by WebdriverIO.
  - WebView2 is Chromium. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` exposes the Chrome DevTools Protocol with no driver and no version to match. Every native campaign of this repository already drives the app that way (`scripts/cdp-harness.mjs`, `scripts/cdp-*.mjs`).
  - An elevated host ignores the `WEBVIEW2_*` flag variables and honours only the options the app passes to WebView2 (Microsoft, *Develop secure WebView2 apps*). A GitHub Windows runner runs elevated: measured on `windows-latest` on 05/10/2026, WebView2 153 opened no port and the flag was absent from its browser process.
  - WKWebView (macOS) and WebKitGTK (Linux) expose no CDP.

## Decision

On Windows, CI drives the debug build over CDP with the existing harness: `npm run e2e:fixture` (`scripts/e2e-fixture.mjs`), job `e2e-windows` of `.github/workflows/ci.yml`. No driver to install, no new dependency.

The app starts in an isolated test mode, compiled into debug builds only (`src-tauri/src/test_mode.rs`):

- `MUSE_DESKTOP_TEST_DATA_DIR` turns it on. That folder holds the app data (outbox, scheduler, notifications, computer use, MCP packages) and the WebView2 profile: the app sets `WEBVIEW2_USER_DATA_FOLDER` itself, which overrides the folder Tauri passes to WebView2. The elevated runner honours it; the check verifies it on every run.
- `MUSE_DESKTOP_TEST_SIDECAR`, a JSON argv, replaces every engine, remote ones included. Missing or malformed, the start fails: a test instance never runs a real engine.
- `MUSE_DESKTOP_TEST_CDP_PORT` opens CDP through the window's `additionalBrowserArgs`, a WebView2 option, so an elevated host keeps it.
- The single-instance guard and the OS wake-up task are skipped. The test instance runs beside the user's own and never edits the per-account `schtasks` or `launchd` entry.
- In a release build `test_mode::data_dir()` is `None` by construction: no variable is read, no branch can switch on.

The engine is `scripts/muse-fixture.mjs`, the newline JSON-RPC fixture with a durable in-memory store. Its `initialize` passes the handshake validator (schema 1, `sha256:` fingerprint). Its approvals carry the 1.4.2 host's choices. Its ids are unique per process, one process per workspace. A `turn/start` whose text holds `[fixture:exit]` kills it before it answers.

The check, in a fresh temp folder:

- **A/B:** projects A and B are created from the welcome screen, the folder dialog answered by the harness. A turn and an approval card in each. Allow once on A's card: only `approve(A)` is sent, A's turn ends, B's card stays pending at the same requirement, in the host and on screen. B is then decided on its own.
- **Lost send:** B's host dies on the next `turn/start` before answering. The text must still be in the transcript, the outbox or the native outbox ledger. A's host still answers.
- **Isolation:** the WebView2 profile and the app data were written in the temp folder.

It catches both faults: on 05/10/2026 a decision sent to the other conversation's card, then a refused send dropped with its bubble, each turned `e2e-windows` red with the matching verdicts false. Both were temporary commits, reverted.

## Alternatives rejected

- **`tauri-driver` with Edge Driver on Windows:** one more binary to fetch on every run and to keep at the runtime's exact version, for the same Chromium underneath, and a second harness beside the one the native campaigns use.
- **WebdriverIO with the embedded plugin on every platform:** an HTTP automation server compiled into the app and a JavaScript test stack, for a macOS run that CI does not have.
- **A mocked IPC in the renderer:** the unit tests already do that. It skips the Rust bridge, the stdout pump and a real child process, where a route or a send can be lost.
- **Overrides honoured in every build:** a shipped app must not be pointed at another engine or another profile by its environment.

## Consequences

- `npm test` stays free of any app or engine. `npm run e2e:fixture` needs a built debug app (`npm run build`, then `cargo build --manifest-path src-tauri/Cargo.toml`) and runs on Windows only. The CI job takes about five minutes, most of it the debug build.
- **macOS:** no end-to-end check. The way in is `tauri-plugin-wdio-webdriver` in debug builds with `@wdio/tauri-service`, or CrabNebula with a paid key. The test mode isolates the app data there, not the WKWebView store.
- **Linux:** no end-to-end check in CI. `tauri-driver` with WebKitWebDriver would work, but the test mode does not move the WebKitGTK data folder, which Tauri derives from the app's local data folder.
- The fixture is a protocol double, not a model. It does not replace the native campaigns on the real engine.
- The test mode isolates writes, not reads: the startup probe, the Muse sign-in status and the skills and rules scans still read the machine's own configuration.
- A failing run prints its verdict, masked and bounded, in the job log and in a seven-day artifact.
