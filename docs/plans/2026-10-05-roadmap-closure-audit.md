# Roadmap closure audit — 5 October 2026

Read-only audit of the 17 tickets still ◐ on Windows, plus the macOS columns, at `a893293`
(main = origin/main). Nine agents checked each ticket against the
[implementation plan](2026-09-15-agent-implementation-plan.md), the evidence tree and the code.
Scope: Windows and macOS only.

## Headline

- **The host was not the blocker for M0-05/M0-06.** Host 1.3.0 did raise approvals. Its session logs
  show real `approval/requested` events (native session `01a0dd25`, 26/09; WSL session `01a0a996`,
  16/09, decided through `approval/decide`). The earlier probes asked for `echo`. `echo` is on the
  `onRequest` read-only allowlist, so it never prompts. Upstream #56: the maintainer replied on 02/10
  and asked for a re-test on 1.4.2 with a write command.
- **The native engine is now 1.4.2.** At 10:57 today the native launcher updated itself from
  1.3.0-R3401.1 to 1.4.2-R4684.1. An audit probe called `muse.cmd`, and that call triggered the
  update. The native 1.3.0 binary is gone. Copies of 1.3.0 remain in WSL and in the main checkout's
  dev sidecar. The schema change is additive: all 29 RPCs the app sends exist in both versions. 1.4.2
  adds `workspaceRoots` (session/start, turn/start), `session/delete` and `--provider echo`.
- **Two Windows engines coexist.** Every qualification campaign ran the native sidecar. 0.2.0 ships the
  WSL bridge (release notes). `release.yml` still bundles the native exe. The roadmap never says which
  engine counts.
- **Rust CI has been red since 27/09 (`561a3fe`)** on Linux and macos-14. Probable cause:
  `src-tauri/src/git.rs` test `setup_reports_failed_on_nonzero_exit` runs `cmd /C exit /b 3` through
  `sh -c`, which exits 127 instead of 3.
- **Release v0.2.0 was never published.** The Windows job fails on `release not found`: the engine
  draft `sidecar-muse-1.3.0` now shows as untagged. The macOS job fails on the red cargo test. The last
  published release is 0.1.0. `docs/releases/0.2.0.md` promises a notarised 0.2.0 DMG that does not
  exist.

## Per ticket (Windows)

| Ticket | Real blocker | Closable how |
|---|---|---|
| M0-05 | None. The host prompts on write commands | Fix the probe recipe and answer server-initiated `approval/request` in `msp.rs`. Then run the card / restart / stale / double-answer scenario on 1.4.2 with live turns |
| M0-06 | Product decision: the posture → mode mapping contradicts the host semantics | Decide the mapping, fix the risk gate in `authorization.ts`, run the refused-decision proof |
| M0-07 | Code. Windows proof is missing, not only macOS | Make the renderer truncation code-point safe (`diagnostics.ts`, `engineError.ts`), then run the native forged-reject + stderr + export proof |
| M0-08 | None. Two versions now sit on this machine | Version fixtures, an unknown-notification test, a handshake row per version, the app run on 1.4.2 |
| M0-10 | Infra (clean machine) + code gaps | Code: WSL-side auth probe, non-default distribution, sandbox prerequisite guidance. A clean machine is still needed for full closure |
| M0-12 | Screen reader session | Fix finder focus and reduced-motion scroll (`StreamView.tsx`). Then CDP mouse-free path, 200 % zoom, NVDA portable with a speech log (or Narrator with you listening) |
| M0-13 | Doc. The listed remainder targets code deleted on 23/09 | Re-scope, then a click → effect CDP audit, no model turn |
| M0-14 | Code | Fix the red test, add a `windows-latest` job, a macOS frontend job, and the webview driver ADR |
| M1-09 | Host (#31 Windows fork defect; the 20/09 success ran on the WSL engine) | Echo-provider probe on 1.4.2. Fix the `WriteFailed` copy in `fork.ts` |
| M1-13 | Screen reader session | Same NVDA session as M0-12. Fix the harness `hasFinder` check |
| M2-01 | Product decision on `workspaces[]` (1.4.2 has `workspaceRoots`) | CDP harness for the 4 plan criteria + decision |
| M2-05 | Code (L). The UI described in the roadmap was deleted on 23/09 | Git transfer with rollback in Rust, or re-scope |
| M2-08 | Product decision. Its code was deleted on 23/09 | Withdraw, or re-scope to worktree isolation |
| M3-08 | Code. `turn/completed` exists; runs are not anchored to their own turn | Anchor runs to their turn, add `cancelled`, scope the preview, then a native proof |
| M4-06 | Second device | Your phone on the LAN reading a link, then the 404 after revoke. WSL is not a separate host here (mirrored networking) |
| M4-07 | Code + a real host | Fix the `remote_ssh.rs` defects (pipes not drained, char boundary). sshd in WSL gives only a same-PC proof. The remainder understates the gap: no UI, no MSP over SSH |
| M4-08 | Product decision | WebView2 dictation sends audio to Microsoft unless `processLocally` is used, which has no French yet. This contradicts the 29/09 decision |

## Closed tickets the audit finds generous

M1-05, M3-02, M3-07 (sleep and lock still listed as remaining), M4-04: some plan acceptance criteria
have no evidence.

## macOS

Nothing closes from this machine. Reachable now from Windows: the CI fix, the missing
`NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription` keys and the audio-input
entitlement (voice is very likely dead on the Mac), the stale `NSAppleEventsUsageDescription`, and a
release dry run giving a fresh ad-hoc DMG. Several roadmap macOS cells are wrong: M4-09 has three
notarised DMGs in CI, M0-14 has a macos-14 job, and the M0-10 native setup screen exists. One Mac
session of about 3 h 20 covers the rest; the checklist is in the audit transcript.

## Stale roadmap text to correct

L119 and L241-249 (host ceiling), L135 (`turn/completed never emitted`), L97 and the M4-04 line
(`desktop_control.rs` deleted), L282-285 (CI), L426 (M2-08 lock), L411 (M2-05 UI), L491 (M3-08),
L521-523 (WebView2-bound), L550 (M4-07 proof used Git's ssh, not `remote_ssh.rs`), L560 (macOS DMG).
