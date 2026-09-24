# M0-02: there was nothing to fix (20 September 2026)

This document **closes** the investigation opened by [`reprise-fonctionne.md`](reprise-fonctionne.md) and [`m0-02-cause.md`](m0-02-cause.md). Its conclusion is that **the resume failure observed was a correct response from the client**, not a defect.

## The measurement that settles it

The only conversation left in the application — `01a0bd8e`, "Explain the project structure and its main…", 15 entries — was checked against three sources:

| Source | Result |
|---|---|
| The host's `session/list` (10 sessions) | **absent** |
| Files on disk (`~/.local/share/muse/sessions`, 19 directories) | **no `01a0bd8e*` folder** |
| The application's local storage | **present**, `session_durability: durable`, 15 entries |

**At the time of the investigation, this session exists only on the client side.** The host does not list it and no file carries its identifier on disk.

**What those three sources do not prove, and which I therefore do not claim:** they establish an absence **at the moment of measurement**, not that the host **never** knew it, nor that no data was ever written for it. No historical proof supports those two stronger claims, and I withdraw them.

## Consequence: `sessionNotFound` was the right answer

When the application tries to resume this conversation, the host answers that it cannot find it — **because, at the time of the resume, it is not among the sessions it knows**. The client then shows:

> `This conversation could not be resumed. — MSP error -32020: session … was not found [sessionNotFound] [retryable=false]`

**That is not a defect.** The client is **right** to report the failure, and the host is **right** to refuse. There is **nothing to fix**: neither in the client nor in the sidecar.

That is the conclusion I failed to draw across twenty rounds, because I was looking for a culprit in the protocol instead of checking **whether the session existed**.

## What the investigation established along the way

| Claim | Status |
|---|---|
| The host can resume a **persisted and free** session | **proved** — `session/resume` succeeds, `session/read` answers `ok` |
| `session/read` exists and returns `{session, viewCursor, history, pendingRequests}` | **proved** — my report wrongly declared it `unsupported` |
| A session **with no completed turn** does not persist | **proved** — 10 sessions on host A, 9 on host B |
| Terminal notifications **are** emitted at the normal end of a turn | **proved** — `turn/completed` received |
| `session/list` is **declared** on the client side but **no call was found** in `src/` | **proved** — the method appears in the executable `MSP_METHODS_SENT` table (`msp.ts:32`), but with no invocation |
| The client's `ephemeral` gate blocked a resume | **ruled out** — all 41 saved sessions carried `durable` |
| The resume failure was a defect | **disproved** — the session is absent from the sessions the host lists |

## The real gap, which is not the one I was looking for

The client **can** show, in its sidebar, a conversation the host does not know. That is what happened, and that is what makes the failure confusing for the user: the conversation is **visible**, its history is **readable**, and yet it is **not resumable** — with nothing to say why.

**No call to `session/list` was found in the application**, so nothing lets it know which conversations are really resumable. It can neither mark orphaned conversations, nor warn the user, nor avoid offering a resume that will fail.

**A note on that absence:** `session/list` is indeed declared in `MSP_METHODS_SENT` (`src/lib/msp.ts:32`), the table the Rust bridge uses — so it is not a mere documentary mention, and an automated review was right to flag it to me. What is established is that **no invocation exists on the application side**; the absence of a call in `src/` does not exclude a Rust path taking it.

**That is a missing capability, not a bug** — and it is the only improvement this investigation justifies. It would still need validating with a scenario that fails reproducibly, which is not the case today.

## Method

```powershell
node scripts/msp-list-sessions.mjs        # what the host knows
node scripts/msp-resume-free-session.mjs  # the host can resume a persisted session
node scripts/msp-session-survival.mjs     # a session with no turn does not persist
```

Then, on the application side: read `muse-desktop.sessions.v1`, and check every identifier against the sessions the host lists and the directories on disk. **It is the confrontation of the three sources that settled it** — none of the three was enough on its own.

## Note on the preserved conversation

`01a0bd8e` was created on **20/09 at 06:44**, that is **five hours before** the first session of my campaign (`01a0bea1`, 11:44). Its content is about OpenScreen. **It is not mine and I did not touch it**, even though its title ("Explain the project structure and its main…") is the same as one of my test sessions — the textual marker alone was not conclusive, the timestamp was.
