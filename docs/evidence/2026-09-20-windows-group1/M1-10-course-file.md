# UI race on the queue — measured (M1-10, 20 September 2026)

Completes `M1-10-retrait-file.md`, which only covered a **sequential** removal. The ticket's central criterion — the **race** between the queue and its emptying — is measured here.

## Why a race needed another method

The earlier passes drove each action through a separate CDP command. Every round trip adds tens of milliseconds, which makes a race window **impossible to aim at**. This time, the burst of removals runs **in the page context**, in a single evaluation, with clicks 90 ms apart.

## Protocol — preconditions awaited, never assumed

```powershell
node scripts/cdp-queue-race.mjs
```

Three preconditions, each **awaited** by polling:

| Precondition | Result |
|---|---|
| Composer empty and connected | **OK** |
| First turn really running (`working: true`) | **OK** |
| Two turns actually queued (`queuedRows >= 2`) | **OK** |

That is the direct fix for the defect that made the previous pass fail.

## Result

| Step | Queue | Panel | Removal buttons | `working` | Log entries |
|---|---|---|---|---|---|
| **two-queued** | **2** — `RACE-QUEUED-A-3311`, `RACE-QUEUED-B-7722` | yes | 2 | yes | 70 |
| **after-race** | **0** | **no** | **0** | yes | 72 |
| after-race-settled | 0 | no | 0 | yes | 72 |
| later | 0 | no | 0 | yes | 72 |

Both queue entries carry exactly the expected markers, in order.

### The transcript confirms the operation

The log's last entries, in order:

```
user       RACE-QUEUED-B-7722 say BETA
assistant  1 2 3 4 5 … 23            <- the FIRST turn, still going
system     Turn queued — it will start after the current…
subagent   (empty)
system     Queued turn removed.
system     Queued turn removed.
```

**Two "Queued turn removed." lines 111 ms apart** — the queue emptying was indeed recorded, entry by entry.

## The decisive point: no removed turn started

| Measurement | Result |
|---|---|
| Occurrences of `ALPHA` in the log | **0** |
| Occurrences of `BETA` in the log | **0** |
| Last assistant answers | the **first** turn's counting `1 2 3 … 23` only |

The two removed turns' prompts appear as `user` entries (they were typed) but **no answer corresponds to them**. They were removed from the queue **before** starting, and the first turn carried on unaffected (`working` stays true at every step).

**Established:** the queue → remove sequence holds the race. Removal deletes the entry from storage, the panel goes away, the operation is traced in the transcript, and **removed turns do not run**.

## Limits, and one unexplained anomaly

- **Anomaly: three "Turn queued" lines** appear although I typed only **two** queued messages. The log's total entries go from 70 to 72 during the race, which matches the two removal lines. I **do not explain** the third "Turn queued" line: maybe a re-emission, maybe a leftover from an earlier pass. Unsettled.
- **My `race` object came back empty** (`{}`): the asynchronous evaluation did not return a usable result. The clicks did happen — the queue went from 2 to 0 and two removal lines exist — but I **do not have the exact count** of clicks made nor of buttons found at each attempt.
- **A single take**, with no repetition: the race is not tested statistically.
- **`turn/unqueue` is not observed on the host side** — I see the local consequence and the transcript trace, not the host's acknowledgement of the cancellation command.
- **No failure case provoked**: I did not test the behaviour if the removal failed on the host side.
- The "two turns queued" precondition passed, but the previous pass had shown my script **continues after a failed precondition** — that defect is not fixed here.

## State of M1-10

| Element | State |
|---|---|
| Queue admission, `disposition: queued` persisted | measured |
| **Queued messages** panel ordered, removal action | measured |
| **`Stopping…`** state then the host-wait banner | measured |
| Queue emptied after a Stop | measured |
| Sequential removal of an entry | measured |
| **Race: removing while the previous turn runs** | **measured — removed turns do not start** |

What the ticket calls "the UI race" is now exercised. **M1-10 is not declared closed** for all that: the three-queue-lines anomaly is not explained, the exact click count is missing, and the host's acknowledgement is not observed.
