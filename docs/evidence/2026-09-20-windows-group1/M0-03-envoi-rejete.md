# Rejected send with a live host — proved (M0-03, 20 September 2026)

Replaces `M0-03-envoi-rejete-inabouti.md`. The criterion M0-03 was missing is now covered, with a **deterministic** rejection cause.

## Why the previous attempts failed

Two reasons, both fixed here:

1. **No rejection cause provoked.** The earlier attempts killed the host *during* the send: the submission was **accepted** before the death, which tests survival of a crash, not a rejection.
2. **Conversation identity unverified.** One attempt measured the state of a different conversation from the one where the text had been typed, producing an uninterpretable result.

## The rejection cause chosen

An **unknown skill command**. The send pipeline validates skills **before** reaching the harness and returns `unknown skill /<name>` (`src/hooks/useMuseSessions.ts`, `sendFailed` call when the skill is not found). No host behaviour is involved: the result is **reproducible at will**.

```powershell
node scripts/cdp-unknown-skill-reject.mjs
```

## Result

The conversation's identity is recorded at **every** step — `activeId` and displayed title.

| Step | `activeId` | Title | Composer | Failure copy visible |
|---|---|---|---|---|
| opened | `01a0bea1-…` | *Enumerate the three Musketeers…* | empty | no |
| typed | **identical** | **identical** | `/definitelynotaskill this command names a skill that does not exist` | no |
| **submitted** | **identical** | **identical** | **text preserved** | **yes** |
| after-10s | identical | identical | **text preserved** | yes |

Excerpt from the page body after submission: `…own skill /definitelynotaskill`. The error message is **in English, bounded, with no protocol prefix**.

**Established — this is M0-03's criterion:**

- the text **stays in the composer** after a rejection, it is **not** cleared;
- **no entry is created in the outbox** (`outboxRows: 0`) — consistent: a local rejection is not a pending send, so it must not produce a "to retry" entry;
- **no `Retry` / `Discard` / `Resend` affordance appears**, which is consistent with the absence of an outbox entry: the text is simply still there, ready to be corrected;
- the error is **visible** and **explains the cause** ("unknown skill /definitelynotaskill");
- the conversation is **not** left, the composer stays **active** (`disabled: false`) — the user can correct and resend.

That is the expected behaviour: **the user's work is never lost**, and the application does not claim to have sent.

## A useful distinction for M0-03

The ticket separates two situations, and both are now documented:

| Situation | Behaviour observed | Evidence |
|---|---|---|
| **Rejection** (the host is alive, the send is refused) | text kept in the composer, explicit error, no outbox entry | **this document** |
| **Crash mid-send** (the host dies) | send accepted then interrupted; text already cleared, log preserved | group 1 campaign `README.md` |
| **No host** (sending impossible) | text kept, send not attempted, hint unchanged | group 1 campaign `README.md` |

## What stays open for M0-03

The ticket also lists: **double-click**, **IME**, **close/reload**. None of the three is exercised here. The double-click is the most accessible — it would be enough to submit twice quickly and check that a single turn is admitted.

**M0-03 is therefore not closed**, but its central criterion — "lose no text on a rejected send" — is now **proved by a deterministic reproduction**.
