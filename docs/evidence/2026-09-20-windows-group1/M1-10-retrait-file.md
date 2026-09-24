# Queue removal — measured (M1-10, 20 September 2026)

Replaces `M1-10-retrait-file-inabouti.md`. The criterion "does removal actually delete?" is now measured.

## What made the previous attempt fail

Two causes, both fixed:

1. **No state check before acting.** The test sent a second message without ever confirming the first turn was running. If the first has finished, a second send starts normally and **nothing is queued** — the removal button then cannot exist.
2. **The submission did not go out.** My helper sent `Input.dispatchKeyEvent` **without awaiting** the CDP responses: the composer kept its 52 characters, `entryCount` did not move, `working` stayed false. Replaced by a submission **in the page context**, whose result is read back.

## Protocol adopted — every precondition is awaited

```powershell
node scripts/cdp-queue-removal.mjs
```

| Precondition | How it is verified |
|---|---|
| 1. Composer present, active, **empty**, conversation connected | active wait |
| 2. After the 1st send: composer cleared **and** `working` became true | two separate waits |
| 3. After the 2nd send: `queuedRows >= 1` **before** looking for the button | active wait |

## Result

| Step | Queue (`queued-turns.v1`) | Panel visible | Removal buttons | `working` |
|---|---|---|---|---|
| **queued** | **1** — `QUEUE-SECOND-8842 reply with just QUEUED` | **yes** | **1** | yes |
| **after-removal** | **0** | **no** | **0** | **yes** |
| after-removal-settled | 0 | no | 0 | yes |

The button clicked: **"Remove from queue"**.

## Established

- **The removal action really deletes the entry**: the persisted queue goes from 1 to 0 in `muse-desktop.queued-turns.v1`. It is not a hide — the durable state is modified.
- **The panel goes away with the entry**: `Queued messages` disappears and the button with it, consistently.
- **The first turn is unaffected**: `working` stays true after the removal. Removing a queued turn does not interrupt the one running — the expected behaviour.
- **The removed entry is identified**: the queue's content before removal carries the second message's marker, not the first's.

## One precondition failed, and it is instructive

The first precondition ("composer ready and empty") reported **FAIL**: the composer held **40 characters** — leftovers from the previous test, which I had cleaned by hand before this round but which had come back. The script continued anyway, and the next three preconditions passed.

**Consequence:** the result is valid — the second message really was queued and removed — but the script **does not stop on a failed precondition**, which is a defect: it should abort rather than continue in a non-conforming state. To fix if this scenario is replayed.

## What M1-10 now covers

| Element | State |
|---|---|
| Queue admission, `disposition: queued` persisted | measured (group 1 campaign) |
| **Queued messages** panel ordered, removal action visible | measured |
| **`Stopping…`** state then the host-wait banner | measured |
| Queue **emptied after a Stop** (the host consumes the turn) | measured |
| **Explicit removal of a queued entry** | **measured (this document)** |
| **UI queue/`unqueue` race** | **not measured** — the heart of the ticket |

## Scope and limits

- **The race the ticket targets is not exercised**: I did not provoke a concurrent send at the exact moment of the removal. The scenario measured is sequential (queue, then remove).
- **`turn/unqueue` is not observed on the host side**: I see the entry disappear locally, not the host's acknowledgement of the cancellation command.
- **No restoration check**: if the removal failed on the host side, would the entry disappear anyway? Untested.
- **A single case**, with no repetition. My protocol defect (continuing after a failed precondition) reduces confidence in the exact order of operations.

**M1-10 is not closed**: its central criterion — the UI queue/`unqueue` race — stays unmeasured. What is secured is that removal works sequentially.
