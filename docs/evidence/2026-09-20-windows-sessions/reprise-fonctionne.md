# Resume works on the host side: M0-02 is a client gap (20 September 2026)

**This document corrects gaps no. 1 and no. 2 of [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md).** Both were false, and the test that contradicts them is decisive.

## The test

```powershell
node scripts/msp-resume-free-session.mjs
```

Complete sequence, with no application running:

1. fresh host **A** → `session/start` with a UUIDv7 `commandId`;
2. a **real** turn is carried to completion, so the session is written to disk;
3. **host A is killed** — the equivalent of closing the application or a crash;
4. fresh host **B** → `session/list`, then **`session/resume`** on the session, **free** this time;
5. `session/read` to check the history is reachable.

## Result

| Step | Result |
|---|---|
| Turn completed on A | **`turn/completed` received** |
| Host B lists the session | **yes** — `status: notLoaded`, `turnCount: 1` |
| **`session/resume` on a free session** | **success** |
| `session/read` | **success** — returns `history`, `viewCursor`, `session`, `pendingRequests` |

Notifications observed on A's nominal turn:

```
session/started, session/branchChanged, session/statusChanged,
turn/started, item/started, item/delta, item/completed,
session/tokenUsage, session/contextUsage, turn/completed
```

## The two corrections

### Gap no. 1 — `session/read` and `session/resume` are not absent

The report classified them as `unsupported` and made them the **first item to request from the sidecar**. **False.**

The cause was in my probe: `msp-probe.mjs` called those surfaces on a **freshly created** session, never persisted → `sessionNotFound`, which the probe did not distinguish from `methodNotFound`.

On a **persisted and free** session: `session/read` answers `ok`, **`session/resume` succeeds**.

**Consequence: durable resume works at the host level.** The M0-02 blocker is **not** in the sidecar.

### Gap no. 2 — `turn/completed` **is** emitted

The report claimed terminal notifications are **never** emitted. **False.**

| Situation | Terminal |
|---|---|
| Turn carried to completion | **`turn/completed` emitted** |
| Turn interrupted by `turn/interrupt` | **none** — `native-smoke --exercise-control --exercise-terminal` fails: `host-A did not emit a terminal notification` |

**Cause of my error:** `native-smoke.mjs` only tests the terminal notification **after an interrupt**. I had never measured the nominal case and generalised.

**What is really missing:** confirmation of a **requested stop**. The user presses Stop, the host acknowledges, then nothing confirms the turn stopped. That is narrower than "no terminal notification at all".

## What that changes for M0-02 and M0-04

| Ticket | What I believed | What is measured |
|---|---|---|
| **M0-02** (resume) | blocked by the absence of `session/read` and `session/resume` | **the host can resume a persisted session.** The defect is **on the client side**: `session/list` is declared in `src/lib/msp.ts` line 32 but **never called**, and nothing reconciles local conversations with the sessions the host knows |
| **M0-04** (reliable stop) | blocked by the absence of any terminal notification | only the **stop path** lacks a terminal; the nominal path has one |

**M0-02 is therefore not a sidecar workstream.** It is a fixable defect in this repository — the most promising one I have found since the campaign began.

## Three errors, one single cause

My report was wrong **three times**:

1. `session/read` / `session/resume` "absent" — the probe tested an unpersisted session;
2. `sessionDurability` constantly `ephemeral` — its value changed mid-campaign;
3. terminal notifications "never emitted" — the probe only tested the interrupt path.

**The same cause every time: a context error interpreted as a missing capability.** A probe that does not distinguish "the resource does not exist" from "my scenario did not exercise it" produces findings of absence that are really findings about method.

## What is left to do

- **Check the client path**: where does the client fail, and can it call `session/list` then `session/resume` to reconcile? That is code in this repository.
- **`view/page`**: the `viewCursor` returned by `session/read` may stand in for it.
- **The terminal after an interrupt**: the only confirmed sidecar gap in this document, along with `session/userShell` §3 and the projections §4.

## Reproducibility

```powershell
node scripts/msp-list-sessions.mjs          # persisted sessions
node scripts/msp-session-survival.mjs       # survival when the host dies
node scripts/msp-resume-free-session.mjs    # resume on a free session (this document)
```

All three are **read only** — except the second and third, which create a session and a trivial turn to make persistence observable.
