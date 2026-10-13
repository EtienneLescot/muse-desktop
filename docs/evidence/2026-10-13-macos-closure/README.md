# macOS closure — evidence of 13 October 2026

Native proofs on **macOS 26.5 (25F71), Apple Silicon**, against **Muse Code 1.4.2 (`1.4.2-R4684.1`)** pinned beside the launcher (`scripts/macos/pin-engine.sh`), never through `~/.local/bin/muse`.

- **Debug builds:** each proof launches one isolated test instance (`scripts/macos/test-instance.mjs`, ADR [0003](../../adr/0003-webview-e2e-driver.md) amendment). It runs on its own data folder and WKWebView store, and the default stores are checked unchanged. It is driven through the WKWebView bridge.
- **Builds used:** `08b291d` (campaign), then `4fecdc8`, `df57377`, `3196ce2` and `4fd5da9`, the fixes re-proved in files suffixed `-fixed-<sha>`.
- **Release build:** the release dry-run DMG of `e0c029b` (`m4-09-dmg-smoke-macos.json`).

Result: **35 ☑, 17 ◐, 1 ☐** on macOS. What is left is in the [roadmap checkpoint](../../ROADMAP.md#checkpoint--macos-closure-13-october-2026) and the [session list](../../plans/2026-10-13-macos-sessions-with-etienne.md); deferred low items in the [backlog](../../plans/2026-10-13-backlog.md).

| Ticket | macOS | Evidence |
|---|---|---|
| M0-01 | ◐ | [`m0-01-two-projects.json`](m0-01-two-projects.json) |
| M0-02 | ☑ | [`m0-02-crash-resume.json`](m0-02-crash-resume.json) |
| M0-03 | ◐ | [`m0-03-no-text-lost.json`](m0-03-no-text-lost.json) |
| M0-04 | ☑ | [`m0-04-stop-resume.json`](m0-04-stop-resume.json) |
| M0-05 | ☑ | [`m0-05-approvals-questions.json`](m0-05-approvals-questions.json) |
| M0-06 | ☑ | [`m0-06-policy-in-force.json`](m0-06-policy-in-force.json), [`m0-06-policy-in-force-fixed-3196ce2.json`](m0-06-policy-in-force-fixed-3196ce2.json) |
| M0-07 | ☑ | [`m0-07-diagnostics.json`](m0-07-diagnostics.json) |
| M0-08 | ☑ | [`m0-08-engine-compat.json`](m0-08-engine-compat.json) |
| M0-09 | ☑ | [`m0-09-data-no-silent-failure.json`](m0-09-data-no-silent-failure.json) |
| M0-11 | ☑ | [`m0-11-language-navigation.json`](m0-11-language-navigation.json), [`m0-11-language-navigation-fixed-3196ce2.json`](m0-11-language-navigation-fixed-3196ce2.json) |
| M0-14 | ☑ | [`m0-14-e2e-macos.json`](m0-14-e2e-macos.json) |
| M1-01 | ☑ | [`m1-01-git-status-diff.json`](m1-01-git-status-diff.json) |
| M1-02 | ☑ | [`m1-02-review-comment.json`](m1-02-review-comment.json) |
| M1-03 | ☑ | [`m1-03-stage-discard.json`](m1-03-stage-discard.json) |
| M1-04 | ☑ | [`m1-04-sync-commit-push.json`](m1-04-sync-commit-push.json), [`m1-04-pr-roundtrip-macos.json`](m1-04-pr-roundtrip-macos.json) |
| M1-05 | ☑ | [`m1-05-terminal-macos.json`](m1-05-terminal-macos.json), [`m1-05-terminal-macos-fixed-4fd5da9-run1.json`](m1-05-terminal-macos-fixed-4fd5da9-run1.json), [`m1-05-terminal-macos-fixed-4fd5da9-run2.json`](m1-05-terminal-macos-fixed-4fd5da9-run2.json), [`m1-05-quote-probe-macos-fixed-3196ce2.json`](m1-05-quote-probe-macos-fixed-3196ce2.json) |
| M1-06 | ☑ | [`m1-06-terminal-context-macos.json`](m1-06-terminal-context-macos.json), [`m1-06-usershell-probe-macos.json`](m1-06-usershell-probe-macos.json) |
| M1-07 | ☑ | [`m1-07-files.json`](m1-07-files.json), [`m1-07-files-fixed-3196ce2.json`](m1-07-files-fixed-3196ce2.json) |
| M1-08 | ☑ | [`m1-08-attachments.json`](m1-08-attachments.json) |
| M1-09 | ◐ | [`m1-09-fork-app-1.4.2.json`](m1-09-fork-app-1.4.2.json), [`m1-09-msp-fork-probe-1.4.2.json`](m1-09-msp-fork-probe-1.4.2.json) |
| M1-10 | ☑ | [`m1-10-queue-macos.json`](m1-10-queue-macos.json), [`m1-10-queue-restart-replay-macos.json`](m1-10-queue-restart-replay-macos.json) |
| M1-11 | ☑ | [`m1-11-model-context-macos.json`](m1-11-model-context-macos.json) |
| M2-01 | ☑ | [`m2-01-project-roots.json`](m2-01-project-roots.json) |
| M2-02 | ☑ | [`m2-02-postures.json`](m2-02-postures.json), [`m2-02-postures-fixed-4fecdc8.json`](m2-02-postures-fixed-4fecdc8.json) |
| M2-03 | ◐ | [`m2-03-worktree.json`](m2-03-worktree.json) |
| M2-04 | ☑ | [`m2-04-06-setup-cleanup.json`](m2-04-06-setup-cleanup.json), [`m2-04-06-setup-cleanup-fixed-3196ce2.json`](m2-04-06-setup-cleanup-fixed-3196ce2.json) |
| M2-05 | ☑ | [`m2-05-handoff.json`](m2-05-handoff.json) |
| M2-06 | ◐ | [`m2-04-06-setup-cleanup.json`](m2-04-06-setup-cleanup.json), [`m2-04-06-setup-cleanup-fixed-4fecdc8.json`](m2-04-06-setup-cleanup-fixed-4fecdc8.json) |
| M2-07 | ◐ | [`m2-07-subagents.json`](m2-07-subagents.json), [`m2-07-msp-subagent-notifications-1.4.2.json`](m2-07-msp-subagent-notifications-1.4.2.json) |
| M3-01 | ☑ | [`m3-01-local-mcp.json`](m3-01-local-mcp.json) |
| M3-02 | ☑ | [`m3-02-remote-mcp.json`](m3-02-remote-mcp.json), [`m3-02-tls-macos.json`](m3-02-tls-macos.json) |
| M3-03 | ☑ | [`m3-03-mcpb-lifecycle.json`](m3-03-mcpb-lifecycle.json) |
| M3-04 | ☑ | [`m3-04-skills-discovery.json`](m3-04-skills-discovery.json) |
| M3-05 | ☑ | [`m3-05-skill-invoke.json`](m3-05-skill-invoke.json) |
| M3-08 | ☑ | [`m3-08-run-review.json`](m3-08-run-review.json) |
| M4-01 | ☑ | [`m4-01-browser-macos.json`](m4-01-browser-macos.json) |
| M4-02 | ☑ | [`m4-02-annotations-macos.json`](m4-02-annotations-macos.json) |
| M4-03 | ☑ | [`m4-03-browser-drive-macos.json`](m4-03-browser-drive-macos.json), [`m4-03-browser-drive-macos-fixed-df57377.json`](m4-03-browser-drive-macos-fixed-df57377.json) |
| M4-05 | ◐ | [`m4-05-rich-docs-macos.json`](m4-05-rich-docs-macos.json) |
| M4-06 | ◐ | [`m4-06-share-publish-macos.json`](m4-06-share-publish-macos.json) |
| M4-07 | ☑ | [`m4-07-remote-engine-macos.json`](m4-07-remote-engine-macos.json) |
| M4-09 | ☑ | [`m4-09-dmg-smoke-macos.json`](m4-09-dmg-smoke-macos.json) |

Tickets with no proof here keep their earlier macOS state. M1-12 was ☑ before; M0-10, M0-12, M0-13, M1-13, M3-06, M3-07, M3-09, M4-04 and M4-08 are ◐ and wait for Étienne. M4-10 is ☐.
