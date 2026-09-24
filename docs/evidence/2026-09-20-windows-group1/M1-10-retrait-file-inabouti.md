# Queue removal — inconclusive test (M1-10, 20 September 2026)

An attempt to cover M1-10's only remaining unmeasured criterion: does the **Remove from queue** action really remove a queued turn?

**The test produced nothing, and the failure comes from my protocol.** I record it rather than pass over it in silence.

## Intended protocol

1. open the known conversation;
2. send a first long turn, which must run;
3. send a second message, which must be **queued** since it cannot start;
4. click **Remove from queue**;
5. check the turn disappears from `muse-desktop.queued-turns.v1` **and** from the panel.

## What happened

| Step | Queue (`queued-turns.v1`) | Panel | Removal button | `working` |
|---|---|---|---|---|
| opened | 0 | no | 0 | **no** |
| first-running | 0 | no | 0 | **no** |
| second-queued | 0 | no | 0 | **no** |
| after-removal | 0 | no | 0 | no |
| after-removal-settled | 0 | no | 0 | no |

`removal: {"clicked": false}` — the button never existed, so **nothing was measured**.

## Cause, established by after-the-fact diagnosis

The final diagnosis shows:

- `working: false`, `connected: true`, composer **active**;
- the composer **still** held `QUEUE-SECOND-8842 reply with j…` — that is, **40 characters** left in place, which I cleaned afterwards;
- the entry counter was at **50**, so the **first** send had indeed been submitted (the composer had cleared).

In other words: the first send worked, the second message was **typed but never submitted** — my `Enter` did not trigger the send at that moment.

**And above all, at no step did I check that the first turn was actually running.** Without that check, there is no way to know whether the expected state ("the second send must be queued") was even reachable: if the first turn had already finished, a second send starts normally and **nothing is queued**.

This is the **fourth time** in this campaign that a test fails because I did not check the starting state or the conversation's identity before acting. The previous three are documented: the wrong focus framing, the confusion over entry order, and the selector for the container instead of the opener.

## What M1-10 has established anyway

These points come from earlier campaigns and are not invalidated:

| Element | Where |
|---|---|
| Queue admission: `disposition: queued` returned by the host, persisted in `muse-desktop.queued-turns.v1` | group 1 campaign, round 3 |
| **Queued messages** panel ordered, with its removal action visible | round 3 |
| **`Stopping…`** state then the "waiting for the desktop host to confirm it" banner | round 3 |
| Queue **emptied** after a Stop — the host consumes the queued turn | round 3 |
| Code base: `turn/unqueue` is declared on the client side (`src/lib/msp.ts`) | source reading |

**What is missing:** proof that the removal action **deletes** the entry rather than merely hiding it.

## Picking this up — corrected protocol

1. **Check `working: true` after the first send**, and wait for it to become so; do not assume a long turn is running because it was sent.
2. **Check the composer cleared** after each send, a sign the submission was accepted — that is the check that was missing here.
3. **Check `queuedRows >= 1` before looking for the button**, instead of clicking and noting its absence.
4. Only start looking for the **Remove from queue** button in a panel that is actually unfolded — I have known since round 20 that the work bar's surfaces do not exist when the panel is folded.

**M1-10 stays open.** This round brings no new evidence.
