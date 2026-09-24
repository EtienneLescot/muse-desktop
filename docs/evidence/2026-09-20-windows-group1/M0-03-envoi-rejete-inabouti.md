# Rejected send with a live host — not obtained (M0-03, 20 September 2026)

An attempt to cover the M0-03 criterion that had never been proved: "rejecting a send **with** a live host", as opposed to the already-measured case with no host.

**The criterion was not obtained.** I record the observations and the reason.

## First attempt — killing the host during the send

Sequence measured: typing "Write a 400 word essay about the number seven.", submitting with `Enter`, then killing two of the three hosts mid-turn.

| Step | Composer | Connected | Working | Entries |
|---|---|---|---|---|
| before | empty | yes | no | 25 |
| typed | `Write a 400 word essay` | yes | no | 25 |
| **sent** | **cleared** | yes | **yes** | **28** |
| observe-1..3 | empty | yes | yes | 29 |
| observe-4..6 | empty | **no** | no | 30 |

**What that shows:** the send was **accepted before** the host died — the draft cleared and the log gained 3 entries. The death happened **during the work**, not during the send. So it is not a rejected send.

**Behaviour verified along the way:** the host's brutal death did **not** break the composer (it stays present, becomes disabled), erased **nothing** from the log (25 → 30 entries preserved), and the application stayed alive.

## Second attempt — killing the host before submitting

Sequence: type the text **without** submitting, kill the last host, then attempt the submission.

After the host died, the composer was **empty and disabled** (`composer: ""`, `disabled: true`, `disconnected: true`), and stayed so after an `Enter` send attempt.

**I cannot draw a conclusion about M0-03 from this**, for a methodological reason: the CDP session does not guarantee we are on the **same conversation** as the one where the text was typed. The first attempt had already changed the displayed conversation, and the phase 1 typing was done on a state whose identity I did not verify. The empty composer may therefore simply be another conversation's.

## What stays established

- **Host death during an accepted send**: no crash, composer present but disabled, **log entirely preserved** (25 → 30 entries), no false success displayed.
- **No send-rejection surface was observed** in the DOM: no `Retry`, `Discard` or `Resend` button at any point in either attempt. The code does provide for them (`outbox` with `sending`/`accepted`/`failed` states), but I did not manage to provoke the `failed` state.

## To pick this up correctly

1. **Verify the conversation's identity** before each phase (`muse-desktop.active.v1` and the displayed title), to guarantee the same session is being measured.
2. Provoke a **real** rejection: submit while the host is alive but the command is invalid, or cut the link just after submitting and before the acknowledgement — that is the window where the `outbox` must switch to `failed`.
3. Explicitly target the `outbox`'s `Retry`/`Discard` affordances rather than relying on their appearance.

**M0-03 stays open** on this criterion.
