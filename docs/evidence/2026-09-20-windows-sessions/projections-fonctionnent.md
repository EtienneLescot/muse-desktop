# Projections work — the fifth and last false gap (20 September 2026)

**This document corrects gap no. 4 of [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, the last one left open. It falls like the other four.

## The cause: my parameters were wrong

| Method | What I was sending | What the host expects |
|---|---|---|
| `session/setModel` | `{ sessionId, modelId }` | `{ commandId, sessionId, model: { modelId } }` |
| `session/setReasoningEffort` | `{ sessionId, effort }` | `{ commandId, sessionId, reasoningEffort }` |

My calls were refused with `invalidParams` — **which says nothing about the host's capability**. I had already written that lesson into the report at round 59, after nearly concluding a gap on the basis of the same error. The original finding came from `native-smoke.mjs`, whose unreliability is documented.

## The measurement, with the right shapes

Session `01a0c07a`, `model/list` catalogue: `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`.

**Model change:**

| Step | `session.modelId` |
|---|---|
| before | `muse-spark-1.3-contributor` |
| `setModel({ model: { modelId: "muse-spark-1.3" } })` | **`accepted`** |
| after | **`muse-spark-1.3`** |

**The projection is visible on the session when it is read back.**

**Reasoning effort change:**

| Call | Acknowledged | Notification |
|---|---|---|
| `setReasoningEffort("none")` | `accepted` | `session/reasoningEffortChanged` |
| `setReasoningEffort("high")` | `accepted` | `session/reasoningEffortChanged` |
| `setReasoningEffort("ultra")` | `accepted` | `session/reasoningEffortChanged` |

**Three calls, three notifications.** The host **signals** the change through a dedicated notification, and `session/modelChanged` for the model.

**What the session does not carry:** a `reasoningEffort` field is still **absent** from the session object. That is the one point where the projection can be said not to be in the session — but it is **in the notification**, which is a form of projection at least as usable for a client.

## The five gaps: none of them exists

| Gap | Claimed in the report | Measured |
|---|---|---|
| 1 | `session/read` and `session/resume` missing | **working** on a persisted session |
| 2 | no terminal after an interrupt | **`turn/completed` emitted** (+39 ms) |
| 3 | `userShell` accepted with no item and no output | **item published, output included** |
| 4 | projections not reported | **model visible on the session, effort signalled by notification** |
| 5 | durability constantly `ephemeral` | **variable** |

**The five findings of absence were five artefacts of method.** None of them describes a limit of the sidecar.

## What the client can do right now, with no host change

- **Resume a persisted session**: `session/resume` then `session/read`.
- **Discover the sessions**: `session/list`, never called by the application.
- **Run a command and read its output**: request the capability in the form `capabilities: { requestedCapabilities: ["userShell"] }`, then read the `userShell` item.
- **Change model or effort**: `{ model: { modelId } }` and `reasoningEffort`, then listen to `session/modelChanged` and `session/reasoningEffortChanged`.

**None of these paths depends on the sidecar evolving.**

## What remains, and is not a gap

- **`approval_mode` beyond `promptUnmatched`**: the only limit still standing in the report, and it has **not** been re-measured. `session/read` exposes `approvalMode` — read here as `{mode: "onRequest", source: "startup", lastCommandId: null}` — which may open a simpler measurement than before.
- **The `native-smoke.mjs` false negative** on the control path stays unexplained. Three of its defects are fixed, the fourth is documented.

## Reproducibility

```powershell
node scripts/msp-projection-check.mjs
```

Launches a host, starts a session, calls both methods with the **correct shapes**, reads the session back and records the notifications. No assumption about field names: the script prints the fields actually present.
