# `--no-session-log` explains everything — the end of the harness's two mysteries (27 September 2026)

**This document solves the two puzzles left open by the 20 September campaign**:
the `native-smoke.mjs --exercise-control --exercise-terminal` false negative
([`harness-faux-negatif.md`](../2026-09-20-windows-sessions/harness-faux-negatif.md), "I
cannot explain it") and the host's "variable" durability
([`durabilite-a-change.md`](../2026-09-20-windows-sessions/durabilite-a-change.md), "I
cannot explain the change"). **A single cause, measured**: the `muse serve`
`--no-session-log` flag.

## The cause, in one sentence

`muse serve --help`: `--no-session-log` = **"Use memory-only sessions"**. It is not a
mere storage choice: a memory-only host answers `sessionDurability: "ephemeral"`
**and never admits turns that materialise** — `turn/start` answers `accepted`, then
the only notification is `session/started`, with no `turn/started`, no items, no terminal.

`native-smoke.mjs` launched **all** its hosts with `--no-session-log`. The `msp-*.mjs` probes,
for their part, do not use it. Hence the contradictory measurements on the same machine, the same day.

## The measurement: `scripts/msp-session-log-effect.mjs`

One probe, two hosts, identical except for the flag, the exact same sequence as the smoke's
control path (`turn/start` → immediate `turn/interrupt`, 20 s of observation):

| Measurement | logging (default) | `--no-session-log` |
|---|---|---|
| `sessionDurability` | **`durable`** | **`ephemeral`** |
| `turn/start` | `accepted` | `accepted` |
| `turn/started` | **yes** | **never** |
| Notifications | `session/started`, `session/branchChanged`, `session/statusChanged`, `turn/started`, `item/completed`, `session/statusChanged`, **`turn/completed`** | `session/started` — and nothing else |
| Terminal after an interrupt | **`turn/completed`** | **none** |

```json
"verdict": { "durabilityExplained": true, "controlPathExplained": true }
```

**Both puzzles have the same cause, and it is proved by forking a single flag.**

## What that repairs in the 20/09 campaign's account

| Mystery | Explanation |
|---|---|
| "`sessionDurability` varies: `ephemeral` then `durable`" | **It does not vary**: the smoke (memory only) measured `ephemeral`, the other probes (logged) `durable`. |
| "The smoke receives only `session/started`, the turn never starts" | **That is memory-only mode**: the admitted turn does not materialise in that mode. The host is not at fault. |
| "`turn/start` accepted but `missing_run`" (msp-probe report) | Same cause. |
| The smoke's `sessionRead: unsupported`, `reconnect: sessionNotFound` reports | Same cause: with no session log, nothing is persisted, so nothing can be read back. |

**An important methodological consequence:** every smoke finding measured on the turn
path (`--exercise-control`, `--exercise-terminal`, `--exercise-model`, `--exercise-compaction`,
`--exercise-queue`) comes from this degenerate mode and must be **re-measured on a
logged host** before being cited. Purely contractual findings (parameter shapes,
catalogue, refusals) stay valid.

## The harness fix, and its verification

`scripts/native-smoke.mjs` now launches hosts **in logged mode by default**;
the old behaviour stays available with `--memory-only-sessions`.

Before (20/09, and again this morning):

```json
"controls": [{ "host": "A", "status": "interrupted", "terminalNotification": "unsupported" }]
```

After the fix:

```powershell
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
```

```json
"controls": [
  { "host": "A", "turnId": "01a0c927-25e1-74eb-…", "status": "interrupted", "terminalMethod": "turn/completed" },
  { "host": "B", "turnId": "01a0c927-25e1-7f19-…", "status": "interrupted", "terminalMethod": "turn/completed" }
]
```

**Both hosts, in parallel, with the right `turnId`**: this is the exact scenario that had been failing
since the start of the campaign. It passes. The expected `terminalMethod` is `turn/completed`
on both, `sessionDurability: "durable"`.

## A side effect of the fix, accepted

Logged hosts **persist** the test sessions in
`%USERPROFILE%\.local\share\muse\sessions\`. The smoke is only run opt-in on a development
machine (never in CI), and its prompts are trivial. That is the price of measuring the
real behaviour: the smoke's old defect was precisely to measure a crippled host.
Cleanup stays manual and deliberate (see [`stockage-des-sessions.md`](../2026-09-20-windows-sessions/stockage-des-sessions.md)).

## What is now established (the host contract, re-measured on 27/09/2026)

The dedicated probes were re-run today on the `muse-bin-1.3.0-R3401.1` binary:

| Fact | Today's measurement | Probe |
|---|---|---|
| Resuming a free, persisted session | **`session/resume` succeeds**, `session/read` → `history`, `pendingRequests`, `session`, `viewCursor` | `msp-resume-free-session.mjs` |
| Terminal after an interrupt | **`turn/completed` at +36 ms**, right `turnId`, `terminal`, `reason`, `durationMs` | `msp-interrupt-notifications.mjs` |
| `session/userShell` | `userShell` items published (`item/started` + `item/completed`), **output included** (marker returned) | `msp-user-shell-items.mjs` |
| userShell after a resume | works after `session/resume` — the desktop's `sessionNotLoaded` comes from the host not holding the session in memory | `msp-user-shell-after-resume.mjs` |
| Model/effort projections | `session/setModel` visible on the session read back; `session/modelChanged` and `session/reasoningEffortChanged` emitted | `msp-projection-check.mjs` |
| Approval modes | `onRequest`, `allowAll`, `promptUnmatched` accepted and projected (`session/approvalModeChanged`) | `msp-approval-mode-check.mjs` |

No sidecar contract gap is established. **Everything left is client or method.**

## Reproducibility

```powershell
# Measuring the cause (two hosts, a single flag of difference)
node scripts/msp-session-log-effect.mjs

# Proof that the fix makes the failing scenario pass
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
```
