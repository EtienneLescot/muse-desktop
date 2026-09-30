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

## M4-03 follow-up (30/09) — the existing-profile consent surface delivered

| Piece | Result |
|---|---|
| Dedicated toggle (`m4-03-attach-proof.json`) | **The consent surface works end to end** — Settings → Computer use → "Attach the user's browser" records `computer-attach.json` (`attachChecked: true`, state "Granted"), and the daemon restarts with a **measured** command line: `serve … --permission-mode standard --grant existing-profile` (`grantFlagOnProcess: true`). |
| Serve matrix, measured | `--grant existing-profile` is **only valid in standard permission mode**; every capability manifest (v1 and v2) makes the user's live windows invisible unless each pid is named (`bounded_resource_outside_manifest`), and the browser resource class accepts exact pids only — so a manifest and the user's live browser cannot coexist. With the toggle on, the driver therefore runs manifest-less in standard mode (whose own policy refuses foreign process termination), and the observe/act tool ceiling moved to the app's MCP relay (`relay_filter`: `tools/list` filtered, out-of-level calls answered before the driver). Unit-tested (the `serve_argv` matrix and the relay filter). |
| The live browser turn | A fresh conversation ran the full chain — `list windows`, `browser_prepare` (`attached_existing_profile`), `get_browser_state` — and the driver **bound the real Edge window exactly** (`binding_quality: "exact"`, `endpoint_access_class: "existing_profile_approved"`), with no `browser_consent_required` (`bindingRefused: false`). The model reported the page identity from the bound window (`M4-03 Drive Target`, `modelReportedPage: true`). Verdict: **`completeWorkflowOnRecognizedBrowser: true`**. |
| Consent prompt mechanics | Edge's native remote-debugging consent ("Voulez-vous autoriser le débogage à distance ?") is a **one-time per-install approval**: after Étienne approved it once (29/09), later daemons attach through the persisted `DevToolsActivePort` endpoint with no new prompt — the setting survives Edge and daemon restarts. Stacked prompts (one per prepare attempt while the setting is off) make the driver refuse with `browser_wrong_target_refused` — it requires exactly one prompt with exactly three buttons. |
| Environment notes | The proof ran against a single-window Edge (`--hide-crash-restore-bubble`); the crash-restore bar's buttons otherwise pollute the driver's prompt-button count. The evidence's final tail shows the model reading the bound window's title ("bind output did not expose a tab title string. Window title is M4-03 Drive Target…") — the tab-level snapshot needs an exact `tab_id`, recorded verbatim. |

M4-03 **stays ◐ on Windows with a narrowed remainder**: the consent surface and
the browser-tools bind are now delivered and proved (the 29/09 "one consent
step away" question is closed). Still unmeasured: the unexpected-navigation and
stop-without-acting-on-another-tab acceptance behaviors, cross-origin pages,
navigation-initiated download responses, and iframe auto-capture.

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

## M4-06 / M4-07 follow-up (30/09) — self-hosted sharing, SSH transport

| Ticket | Result |
|---|---|
| **M4-06** (`m4-06-share-server.json`) | **Client + reference server delivered and proved over real loopback HTTP** — `src/lib/sharePublish.ts` (endpoint validation, bounded publish requests, deny-only revoke, no URL announced before the server's real 201) and `scripts/share-server.mjs` (the single-file zero-dependency service the user runs on their own LAN/VPS/NAS: token-gated publish/revoke, token-free read, expiry on every read, revocation observable from any client as the same 404). The tests spawn the real server on an ephemeral port: publish with token / read without any / wrong token 403 / incomplete export 400 / oversized 413 / revoke → 404 for everyone / expiry → 404. |
| **M4-07** (`m4-07-ssh-transport.json`) | **The SSH transport is the system binary, delivered and drive-proven** — `src/lib/remoteSsh.ts` (pure validation + canonical argv) and `src-tauri/src/remote_ssh.rs` (binary resolution, argv rebuilt Rust-side, 64 KiB/stream output bound, 1–120 s timeout). The renderer never builds argv: fields are charset-checked and the remote command travels after a literal `--`. The real `ssh.exe` (OpenSSH 9.9p1) driven with the canonical argv against a local discard port fails fast with a transport-level refusal ("Connection refused"), never an argv rejection — the remote-host half stays unmeasured (no SSH server on this machine; installing one was out of scope). |
| **M4-08** | Product decision of 29/09: the voice path is the **WebView speech API only** — no audio ever leaves the machine; real-time dialogue with a provider is out. The dictation flow already shipped (`voice.ts`); it waits for a microphone to be qualified — nothing further to code today. |

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
