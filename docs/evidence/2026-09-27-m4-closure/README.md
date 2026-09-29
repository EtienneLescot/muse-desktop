# M4 closure campaign — browser, computer use, rich docs, voice (27 September 2026)

**Platform:** Windows 11 (build 26200) · dev build (WebView2, CDP 9222, real
Muse sidecar 1.3.0) · CUA driver 0.28.2 (installed, grant active).

**Objective:** qualify the Windows-reachable M4 criteria.

## Results

| Ticket | Scenario | Result |
|---|---|---|
| **M4-01** | built-in browser (`m4-01-browser.json`) | **Windows evidence** — same-origin navigation renders in the sandboxed iframe (`tauri.localhost/index.html`), a second tab isolates state (2 tabs), and in-tab history Back returns to the previous entry (`?v=second` → `index.html`). |
| **M4-04** | real computer-use turn (`m4-04-computer-turn.json`) | **Windows evidence — the remaining core piece** — a fresh conversation (computer-use MCP entry handed at session start) ran a turn where the model **called `get_screen_size`** and completed. The "real turn" gap from the roadmap is closed on Windows. Level-change-on-open-conversation and guided driver installation stay open. |
| **M4-05** | rich documents (`m4-05-rich-docs.json`, `m4-05-files-xlsx.json`) | **Windows evidence** — a real DOCX attached to the composer was accepted by the office pipeline in a live turn; a real XLSX read through the Files panel rendered the **structured office preview** (table extraction). Composer intake stays text/image (by design); office files route through the Files panel. |
| **M4-08** | voice probe (`m4-08-voice-probe.json`) | **Windows evidence** — WebView2 **exposes `SpeechRecognition`** (typeof function); the composer Voice control answers ("Start voice input" → "Requesting microphone access…") with calm handling and no crash. The permission dialog appeared as an `edge://permission-request-dialog` target. |
| **single-instance** | wake-task relaunch guard (`single-instance-wake.json`) | Second instance with `--automation-wakeup` exits after forwarding its argv; the primary instance receives the `automation-wakeup` event (1 event recorded) and re-checks the scheduler. The two-instance ledger clobbering is closed. |

## M4-03 follow-up (29/09) — the real-page workflow

| Piece | Result |
|---|---|
| Real page in a recognized browser (`m4-03-edge-drive.json`) | **The complete observe-real-page workflow passes without refusal** — the test page opened in Edge (a process the CUA driver recognizes), a live turn drove the computer-use flow (`get window state`, UIA walk) and the model read the real page title (`M4-03 Drive Target`) back. The open question from 27/09 ("does driving a REAL page work once it lives in a recognized browser?") is answered: yes. |
| Driver browser tools on that page (`m4-03-edge-browser-state.json`) | `get_browser_state` **executes but the driver refuses the DevTools attachment** with `browser_consent_required` — attaching to the user's logged-in profile needs the explicit `existing-profile` grant, which the app never passes (`computer.rs` enable(): bounded manifest for "observe", `--dangerously-bypass-approvals` for "act", no `--grant`). The model quoted the refusal verbatim. A consent gate by design, one product surface away. |
| Earlier refusal, kept for the record (`m4-03-browser-drive.json`) | `get_browser_state` on the muse-browser WebView2 window: "pid … is not a recognized browser process" — the driver's browser tools bind to recognized browser processes only. |

M4-03 therefore **stays ◐ on Windows**: the real-page computer-use workflow is
proven, but the ticket's browser-tools path awaits the existing-profile consent
surface, and the acceptance set (complete web workflow, unexpected navigation,
stop) is not fully measured through those tools.

## M4-09 follow-up (27/09 evening) — rollback wiring

| Piece | Result |
|---|---|
| Standalone rollback CLI (`scripts/release-launcher.mjs rollback`) | **Added and proved** — `releaseLauncher.test.ts` "release-launcher CLI rollback flips the installed slots": two versions staged/applied through the update CLI, then the launcher's `rollback` subcommand flips `current`/`previous` (1.1.0 → 1.0.0). The rollback machinery existed (`rollbackRelease` in release-update.mjs) but had no post-launch CLI entry — now wired and tested. |
| npm script | `release:rollback` added. |

This closes the "wiring the rollback into the installer" remainder: the
operator path is `release:launch` (apply+start, auto-rollback on launch
failure) and now `release:rollback` for post-launch health-check failures.

## Notes

- The Files-panel office preview keeps its safety guards: a malformed office
  archive degrades to the bounded notice instead of a crash (verified during
  fixture iterations).
- M4-06 stays ☐ (product spec missing); M4-07's real transport (SSH/cloud)
  does not exist yet — the pure model is tested in Rust.

## Reproducibility

```
npm run build && cargo build --manifest-path src-tauri/Cargo.toml
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/debug/muse-desktop.exe
node scripts/cdp-m4-01-browser.mjs
node scripts/cdp-m4-08-voice.mjs
node scripts/cdp-m4-04-computer-turn.mjs
node scripts/cdp-m4-05-files-xlsx.mjs
node scripts/cdp-single-instance-wake.mjs
node scripts/cdp-m4-03-edge-drive.mjs
node scripts/cdp-m4-03-edge-browser-state.mjs
```
