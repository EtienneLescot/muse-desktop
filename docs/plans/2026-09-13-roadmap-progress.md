# Roadmap — progress report (2026-09-13, `main` @ `4d1f92c`)

> Historical: this report counts merged stories, not functional parity. For the current state by design, UI, wiring and validation, see the [operational roadmap](../ROADMAP.md) and the [15 September audit](2026-09-15-codex-parity-audit.md).

Clean tree, pushed to `origin/main`. Gates: `tsc` clean, 343/343 node tests,
23/23 Rust tests, `vite build` green (Linux node
`~/.nvm/versions/node/v22.16.0`, the `node` on PATH being a broken Windows shim).

## Stories: 33/34 merged, 2 partial

V1 Must 11/11: US-1, US-2, US-6, US-10, US-11, US-14, US-17, US-18, US-22,
US-29, US-33.
V2 Should 20/22: US-3, US-4 (**local** extractive compaction), US-5, US-7
(fan-out through the parent turn — no spawn in the schema), US-8 (worktree plan +
manual snippet), US-9 (client-side scheduling), US-12, US-15, US-16, US-19
(iframe + per-app permission), US-20, US-21, US-23, US-24/25/26 (local
directory, 1 remote guard), US-27 (local bundles), US-30, US-32, US-34.
Partial: US-28 (experimental "not connected" stub), US-31 (sample registry,
server `model/list` not wired). US-13 = Won't (SSE, by spec).

## Meta SDK (`@muse-code/sdk@0.1.1`, pinned)

Partial adoption agreed: `src/lib/msp.ts` + `test/msp-conformance.test.ts`
validate our 8 methods / 15 notifications against the official unions at
compile time (`import type` only — identical bundle, zero runtime). Schema audit
against `msp.rs`: **zero gap**. Rust transport kept (the SDK requires Node+spawn,
unavailable in a webview). Still open: fingerprint of the bundled binary
(`checkServedFingerprint`).

## Remaining (suggested order)

1. ~~US-31~~ **done** (`8f98fa1`): real `model/list` + `session/setModel`,
   proved on the binary (`accepted`, `isActive` flips; an invalid id →
   `-32030 invalid_model`). Live picker with a sample fallback.
   Note: the binary announces fingerprint `sha256:03312c21…` while the
   SDK pins `sha256:cfd31ee7…` (schema ahead on the host side — a warning,
   not an error; to watch).
2. ~~US-4 server~~ **done** (`5539be3`): `compact_session` command
   (`session/compact`, `accepted`/`noop` statuses, `missing_run` /
   `run_active` rejections mapped — all proved live), `session/contextUsage`
   routed to the occupancy bar + a "Compact server" button suggested from
   `warning` up (never automatic). The local recap is unchanged.
3. US-28: real-time channels (transport to specify) or downgrade to a
   documented Won't.
4. Unused server capabilities: `turn/steer`, `session/fork`,
   `turn/cancel`/`unqueue`, `view/page`, `approval/listPending`.
5. Live/E2E verification: real sub-agents, `check_scope`, sidecar
   (never exercised in this session; no automation under WSLg).
6. Housekeeping: branches `impl/w-*`, `impl/us-32-a11y`, `impl/v2-batch2`
   still on origin; worktrees already deleted.

## Sidebar UX — threads first, `design/prototype` mockup (`be54165` → `4d1f92c`)

- Threads first, secondary sections as static labels (no `<details>` — the
  mockup has no disclosure widgets): Projects, Automations, Integrations,
  Library, Archived.
- Labels on the mockup's token (`.section-label`: 11px, letter-spaced caps,
  muted, `margin: 28px 12px 9px`); a discreet `+` button like the mockup's
  Projects `[+]`.
- Per-thread workspace (Codex style): a folder picker at creation, the default
  set in Settings; no more global "Choose workspace folder" lock.

## Known risks

- Cross merges on `App.tsx` / `useMuseSessions.ts` / `App.css` resolved by
  hand: gates green but a silent UX regression is possible.
- `wire_log` (`/tmp/muse-wire.log`, prompts in clear) still present:
  to remove before release (see SPEC).
