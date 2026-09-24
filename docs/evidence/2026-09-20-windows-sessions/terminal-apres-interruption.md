# The host does emit the terminal after an interrupt (20 September 2026)

**This document corrects gap no. 2 of [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, which claimed no terminal notification is emitted after `turn/interrupt`. **That is false**, and I found out why I believed it.

## The measurement

```powershell
node scripts/msp-interrupt-notifications.mjs
```

A deliberately long turn is started, then interrupted after 6 s with `{sessionId, turnId, commandId}`, and **every** notification is recorded for 45 s.

**Result — the host is talkative, and fast:**

| After the interrupt | Notification |
|---|---|
| +19 ms | `item/completed` |
| +39 ms | `session/statusChanged` |
| **+39 ms** | **`turn/completed`** |
| `item/delta` deltas afterwards | **0** — the turn really stopped |

The terminal carries **exactly the expected `turnId`**:

```json
{ "method": "turn/completed",
  "turnId": "01a0c05a-2e5d-77e9-863a-97b400bf52c1",
  "keys": ["sessionId", "viewCursor", "sourceRange", "turnId", "terminal", "reason", "durationMs"] }
```

(the `turnId` sent and the `turnId` received are identical.)

## Why I believed the opposite

`native-smoke.mjs --exercise-control --exercise-terminal` **fails**, with:

```
host-A did not emit a terminal notification for …
```

It is **not** the host at fault. The offending line is in the harness:

```js
await host.request("turn/interrupt", {
  commandId: uuidv7(),
  sessionId: sessions[index],
  retract: false,          // ← no turnId
});
```

**The host requires `turnId`** — it says so itself: `invalid session/start commandId: expected UUIDv7`, and for interrupts `turn/interrupt` requires `commandId` **in addition to** `turnId` (already noted in the report's "shape details" section). Without `turnId`, the interrupt is refused with `invalidParams`, **the turn is never interrupted**, and no terminal can arrive.

The harness then translated that absence into `terminalNotification: unsupported`, and **I took that finding for a property of the host**. It is the **fourth** error of the same family in this campaign: an error of method read as a missing capability.

## What the client does, for its part

The Rust code **knows** how to send the `turnId` — but it is **optional**:

```rust
if let Some(turn_id) = turn_id.map(str::trim).filter(|value| !value.is_empty()) {
    params["turnId"] = json!(turn_id);
}
```

And its comment states the client's intent exactly:

> An accepted `turn/interrupt` is admission only; the renderer remains in its stopping state until `turn/completed`, `turn/retracted` or another terminal notification arrives.

**So the client deliberately waits for a terminal — and the host provides it**, provided the `turnId` is passed.

## What is left to check, and is no longer a sidecar gap

The interface did indeed show a `Stopping…` that never resolved, with the "waiting for the desktop host to confirm it" banner. **Something does not work on that path** — but it is **not** a missing terminal on the host side, that is demonstrated.

Three possibilities, none settled:

1. the renderer does not call `interrupt_session` with a non-empty `turnId`, so the host refuses or interrupts something else;
2. the terminal arrives but is not associated with the right turn on the client side;
3. the interface observation dated from a different state.

**What it would take to settle it:** reproduce the stop from the interface with the network tab or a trace of the Rust calls, and check **the `turnId` actually transmitted**.

## Checking the harness

```powershell
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
# fails: "did not emit a terminal notification" — harness with no turnId

node scripts/msp-interrupt-notifications.mjs
# succeeds: turn/completed at +39 ms
```

**The harness needs a fix**: pass the `turnId` of the turn it is interrupting. Until it does, it will keep producing a false finding of absence, and any documentation resting on it will be wrong — as mine was.

## Summary of this report's corrections

| Gap | What I claimed | Measured |
|---|---|---|
| 1 | `session/read` and `session/resume` missing | **present and working** on a persisted session |
| 2 | no terminal after an interrupt | **`turn/completed` at +39 ms** |
| 5 | `sessionDurability` constantly `ephemeral` | **variable**: `ephemeral` then `durable` |

**Three gaps out of five were false**, all for the same reason: my tooling did not distinguish "the resource does not exist" from "my scenario did not exercise it".
