# The approval ceiling does not exist — the last finding falls (20 September 2026)

**This document corrects the last unre-measured claim in [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, and closes the investigation. The report presented a `promptUnmatched` ceiling as the sidecar's only remaining limit.

**It does not exist.**

## The method

`session/read` exposes `approvalMode` on the session — a round 61 discovery, unused until now. It makes it possible to **read** the effective mode after each attempt, instead of trusting the acknowledgement.

The script tries four plausible method names, then sweeps eight mode values, **reading the session back** after each one.

## The result

**Only one method exists:** `session/setApprovalMode`. The other three (`session/setApproval`, `session/approvalMode`, `approval/setMode`) answer `methodNotFound` — and the session stays unchanged, which confirms they do nothing.

**Three values are accepted:**

| Mode | Result | Effective mode afterwards |
|---|---|---|
| `onRequest` | **accepted** | `onRequest` |
| **`allowAll`** | **accepted** | **`allowAll`** |
| `promptUnmatched` | **accepted** | `promptUnmatched` |
| `auto`, `yolo`, `never`, `ask`, `deny` | refused with `invalidParams` | unchanged |

The five refusals are **names I invented myself** — `auto`, `yolo`, `never` are not part of the host's vocabulary. **They prove no limit.**

## What the host actually exposes

The acknowledgement is complete:

```json
{ "status": "accepted",
  "applyOutcome": "completed",
  "effectiveMode": { "mode": "allowAll", "source": "approvalReconfigure", … } }
```

And the session read back confirms it:

```
before : { "mode": "onRequest",  "source": "startup",              "lastCommandId": null }
after  : { "mode": "allowAll",   "source": "approvalReconfigure",  "lastCommandId": "<the commandId sent>" }
```

Plus a **`session/approvalModeChanged`** notification.

**The mode is configurable, applied, projected onto the session, and signalled by notification.** There is **no ceiling**.

## The cause of my error

The original finding came from `native-smoke.mjs`, on a scenario where an **approval request** never appeared — in `ask` mode, a mode that **does not exist**. I inferred a host ceiling, when it was my scenario that exercised nothing.

That is **exactly** the same error as the five previous gaps: a context error read as a missing capability.

## Final summary: six findings, six artefacts

| Finding | Claimed | Measured |
|---|---|---|
| 1 | `session/read`, `session/resume` missing | **they work** |
| 2 | no terminal after an interrupt | **`turn/completed` emitted** |
| 3 | `userShell` with no item and no output | **item published, output included** |
| 4 | projections not reported | **visible (session + notification)** |
| 5 | durability constantly `ephemeral` | **variable** |
| 6 | `approval_mode` capped at `promptUnmatched` | **non-existent** — three modes accepted |

**No sidecar contract gap is established.** Host 1.3.0 does everything I accused it of not doing.

## What that changes for the group 1 tickets

| Ticket | What I believed | Measured |
|---|---|---|
| **M0-01** — concurrent approvals | blocked by the host's ceiling | **no ceiling** — `allowAll` is accepted |
| **M0-02** — resume | blocked by the sidecar | **the host can resume** |
| **M0-04** — reliable stop | blocked by the missing terminal | **the terminal is emitted** |
| **M0-06** — permission posture | limited by the ceiling | **no ceiling** |
| **M1-06** — terminal output | blocked by the sidecar | **the item and the output exist** |
| **M1-11** — model and effort | blocked by the missing projection | **the projections exist** |

**None of these tickets is blocked by the sidecar.** What is left to do is **on the client side**, in this repository.

## Reproducibility

```powershell
node scripts/msp-approval-mode-check.mjs
```

Launches a host, starts a session, tries four method names, sweeps eight mode values and **reads the session back** after each attempt. No assumption about names: the script prints the ones that exist and the ones the host refuses.
