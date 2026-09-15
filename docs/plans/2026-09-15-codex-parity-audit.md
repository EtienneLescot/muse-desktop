# Codex parity audit — 2026-09-15

Baseline: main at 589022e, fetched and fast-forwarded after PR #12.

## Method and conclusion

Source audit of React components, session hook, Rust backend, SPEC and roadmap against official documentation fetched today. Old Codex app URLs now redirect to ChatGPT Learn; scope is desktop coding workflows, with extended capabilities tracked separately. No fresh paid agent turn or native E2E scenario was executed. Wired means a backend path exists, not that every recovery scenario is proven.

Muse has a working conversation client and a substantially improved desktop shell. It does not yet provide Codex feature parity. The historical “33/34 stories merged” count measures delivery of scoped implementations, including manual helpers and local registries, not parity. A numeric completion percentage would be misleading without weighted acceptance criteria.

## Capability matrix

| Area | Evidence in Muse | Remaining work |
|---|---|---|
| Desktop UI | WindowControls, Desktop.css: integrated controls, themes, fixed sidebar/profile, branded scrolling | Cross-platform native QA; remaining French output includes “outil” in ArtifactsPane and “Suite” in newFromSummary |
| Conversations | main.rs and useMuseSessions: real start/send/stream/interrupt, approvals and structured questions | Restart/reconnect, pending requests and failure recovery E2E |
| Organization | Rename/archive/restore/delete, local search, groups, drafts, shortcuts | Backend fork, steering/queue UI, pinning/order; full history search not established |
| Parallel projects | main.rs ensure_host shuts down old host for another workspace; send_input uses current single host | Critical: session-aware host routing and independent workspace lifecycle |
| Projects | lib/projects.ts stores names, instructions and overrides | Entity has no directory roots; build durable project/environment identity |
| Model/context | Real model/list, session/setModel, session/compact, context notifications | Distinguish live models from sample fallback and local summaries from backend compaction |
| Git review | ArtifactsPane extracts message snippets and referenced names | Real staged/unstaged/base-branch diff, line feedback, stage/revert/commit/push/PR workflow |
| Worktrees | lib/worktrees.ts generates manual shell snippet; hash check report-only | Creation, selection, cleanup, setup scripts, conversation mapping and handoff |
| Terminal | No PTY command in Rust registry | Interactive scoped terminal, process lifetime and agent-readable output |
| Subagents | Parent-prompt fan-out plus actual subagent control RPCs | Isolation for writers; live lifecycle/drilldown acceptance |
| Automations | lib/schedules.ts plus 15s UI timer enqueue instructions; approval sends the turn | Unattended execution, durable run records, fixed workspace, missed-run policy, retries and result inbox |
| MCP | lib/connectors.ts stores curated tools and registry metadata | Actual transport, authentication, discovery and engine tool execution |
| Skills | Local definitions, slash calls, keyword suggestions | Native SKILL.md discovery, scoped resources and engine integration |
| Browser/computer use | BrowserPanel iframe plus typed selection comments and permission metadata | Browser control, visual selection capture and desktop automation runtime |
| Files/images | Text mentions, manual file index and response artifacts | Real file tree/attachments; send_input currently transmits text only |
| Sharing/memory | Local memory and Markdown/JSON bundles | Hosted links/cross-device state; channels explicitly disconnected |
| Permissions | Real approvals and canonical scope checks; local sandbox preferences | Effective backend policy: spawn_sidecar only passes serve, not UI policy settings |
| Distribution | Windows native app with WSL adapter | Dependency/auth onboarding, release verification, update strategy; not standalone Windows engine |
| Remote/cloud | No remote execution implementation identified | Separate infrastructure milestone |

## Priority findings

1. **P0: workspace continuity.** main.rs:267 ensure_host shuts down the previous engine when a different folder starts. main.rs:1225 send_input routes through the single current host. Prove that starting B does not interrupt A and that commands always reach their own session host.
2. **P0: diagnostic logging.** main.rs:485 still appends raw host frames to /tmp/muse-wire.log where writable. Remove by default or explicitly enable redacted/rotated diagnostics. String::truncate(2000) can also panic if that byte offset splits a UTF-8 character.
3. **P0: input recovery.** Composer clears input immediately after onSend, while the hook handles backend failure asynchronously. Provide durable failed-message retry or retain draft until acknowledgement; verify with disconnect/rejection.
4. **P1: protocol assurance drift.** lib/msp.ts lists eight methods despite model/compact/subagent RPCs in Rust. Current conformance checks do not certify the full implementation. Synchronize the registry and validate served capabilities/fingerprint.
5. **P1: reliability gates.** localStorage is bounded and best-effort. Establish quota/migration recovery. No .github/workflows directory exists on this baseline; add CI and repeatable native integration tests.

## Roadmap reconciliation

US-8 is a manual worktree helper. US-9 is scheduling with approval before execution. US-19 is iframe preview and metadata. US-21 restores message snippets to the composer, not files on disk. US-24/26 are connector registries, not operational MCP. US-25 has local skills but native integration remains to prove. US-27 is local export. US-28 is disconnected; co-editing is not established as a core Codex parity requirement. US-31 models and US-4 backend compaction really are wired.

The old SPEC also contains stale test counts and /dev/urandom references. Keep it as historical context, but use real acceptance scenarios for current status.

## Recommended milestones

1. **M0 — Finish and trust existing flows.** Host routing, input recovery, diagnostics, actual permission state, conformance registry, localization and Windows onboarding. Exit: start/stream/approve/answer/interrupt/retry, restart, missing engine and concurrent projects pass native E2E.
2. **M1 — Complete daily coding.** Git review/actions, scoped PTY, real files/attachments, backend fork and steering where engine capabilities permit. Exit: inspect, amend, test and deliver a real repository change within Muse, including conflicts and failures.
3. **M2 — Parallel environments.** Durable project roots, managed worktrees/setup/handoff and validated subagent controls. Exit: independent writers cannot overwrite each other; restart and cleanup preserve work.
4. **M3 — Operational extensions and automation.** Real MCP, filesystem skills, unattended schedules, result inbox, run history and notifications. Exit: a scheduled run uses a real tool without a pre-run click and records a resumable outcome.
5. **M4 — Extended parity.** Browser automation/visual feedback, image inputs/generation subject to engine support, remote/cloud, hosted sharing, voice/computer use if required. These remain gaps for literal full parity, but should not delay finishing core workflows.

Definition of done: real implementation, effective permissions, error/restart behavior, reproducible E2E and verification on each claimed platform. A tested helper or stored setting is insufficient. Preserve Muse branding and compare workflow outcomes; product-specific models/accounts are not interchangeable.

## Official references

- [Feature index](https://learn.chatgpt.com/docs/features)
- [Projects](https://learn.chatgpt.com/docs/projects)
- [Code review](https://learn.chatgpt.com/docs/code-review): repository diff, line feedback and Git actions.
- [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal): scoped to project/worktree.
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees): isolated chats and Local/Worktree handoff.
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app): unattended runs and results. Local tasks also require the computer and app running; app closure alone is not the distinguishing gap.

## Validation

Production frontend build, 346/346 Node tests and 25/25 Rust tests passed on merged main. These are build/unit checks, not proof of native feature parity. No application source changed during this audit.
