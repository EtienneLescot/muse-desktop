# `session/userShell` works — the fourth false gap (20 September 2026)

**This document corrects gap no. 3 of [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md).** The report claimed the host accepts `session/userShell` without ever publishing an item. **That is wrong on both counts.**

## The decisive correction: the shape of the capability

`msp-probe.mjs` requests the capability like this:

```js
connect(host, { requestedCapabilities: ["userShell"] })
// → initialize({ clientInfo, capabilities: { requestedCapabilities: ["userShell"] } })
```

**The request is nested inside `capabilities`.** My attempts used `capabilities: { userShell: true }`, `capabilities: ["userShell"]` or `requestedCapabilities` at the root level — **all three fail** with `grantedCapabilities: []`, and `session/userShell` then answers:

> `session/userShell requires the userShell capability`

**I nearly concluded a gap a second time from a malformed probe.** It is the same trap as `session/read`: a context error read as a missing capability.

## The measurement, with the right shape

| Measurement | Result |
|---|---|
| `grantedCapabilities` | **`["userShell"]`** |
| `session/userShell` | **`ok`** — `{"commandId": …, "status": "accepted"}` |
| Notifications published | **`item/started`, `item/completed`** |
| Items' `kind` | **`userShell`** |
| **Command output** | **the marker `muse-ushell-…` appears in the notifications** |
| `outputRef` | absent — but **the output is there** |

**Both claims in the report fall:** the host **publishes** a `userShell` item, and the **output is reported** — not through an `outputRef`, but **in the item's payload**.

**Method:** the command executed writes a unique marker (`muse-ushell-<timestamp>`) and looks for it in every notification received after the call. The marker is **found** — proof by content, not by the presence of a field.

## What that changes for M1-06

"Have the engine read the terminal output" was classified as **blocked by the sidecar contract**. **It is not**: the host accepts the command, publishes a typed item, and puts the output in it.

What is missing, if anything is, is **on the client side**: the client has to request the capability in the right shape and read the item. The report attributed a blocker to it that does not exist.

## The fourth gap was badly measured too

Gap no. 4 (model and effort projections) was re-measured outside the harness. **My calls fail with `invalidParams`:**

```
setReasoningEffort(none|high|ultra)  → invalidParams
setModel(muse-spark-1.3)             → invalidParams: missing f…
```

An `invalidParams` on **my** request says **nothing** about the host's capability — it is the same trap as `approval/listPending` without a `sessionId`, which had already produced a false finding in this repository.

**I therefore have no valid measurement of gap no. 4.** It is neither confirmed nor refuted, and the report should not assert it.

Incidentally, `session/read` exposes an **`approvalMode`** field on the session — useful for M0-06, unused until now.

## Summary: the five gaps

| Gap | Claimed | Measured |
|---|---|---|
| 1 — `session/read`, `session/resume` missing | a gap | **non-existent** — they work |
| 2 — no terminal after an interrupt | a gap | **non-existent** — `turn/completed` emitted |
| 3 — `userShell` accepted with no item and no output | a gap | **non-existent** — `userShell` item published, output included |
| 4 — projections not reported | a gap | **not measured** — my calls are refused with `invalidParams` |
| 5 — durability constantly `ephemeral` | a gap | **non-existent** — variable |

**None of the five gaps is confirmed.** Three are formally disproved, one was never validly measured, and the fifth was a misread constant.

## What I am not doing, and why

I am **not** investigating gap no. 4 now: it requires finding the correct shape of `session/setModel` and `session/setReasoningEffort`, which is probe work in its own right. **My context budget is nearly exhausted**, and hastily redoing a measurement that has already produced four false findings would be the worst way to finish.

**The lesson of these ten rounds is clear:** I do not have a knowledge problem about the host, I have a **tooling** problem. Five findings of absence, five artefacts of method.
