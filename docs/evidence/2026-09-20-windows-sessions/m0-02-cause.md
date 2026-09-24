# M0-02: what is really at fault (20 September 2026)

After [`reprise-fonctionne.md`](reprise-fonctionne.md), which showed the host can resume a persisted session, this document looks for **who** fails. It rules out two hypotheses and leaves one, without concluding beyond what is measured.

## Hypothesis 1 — the client's `ephemeral` gate: **ruled out**

The client refuses a resume when its stored session is marked `ephemeral`, in **two places**:

```ts
// useMuseSessions.ts, reconnectSession
if (isEphemeralSession(session)) { /* error, return */ }

// bootResume.ts, isResumeEligible
if (session.session_durability?.toLowerCase() === "ephemeral") return false;
```

with

```ts
function isEphemeralSession(session) {
  return session?.session_durability?.toLowerCase() === "ephemeral";
}
```

**That value is written only when the session is created** (six write sites, all fed by the host's `meta.session_durability`) and **never revised**.

**Tests run:**

| Check | Result |
|---|---|
| Durability stored in the backup's 41 sessions | **41 × `durable`**, none `ephemeral` |
| Durability stored in the remaining session | **`durable`** |
| Durability announced by the host today | **`durable`** |

**The gate therefore never fired**: no local session ever carried `ephemeral`. I **cannot** attribute the resume failure seen during the campaign to it.

The gate stays a **latent risk** — if the host's durability changes, a session marked `ephemeral` at creation would refuse resume forever, even once the host had become durable. But **I have no proof that case occurred**, so I have **fixed nothing** on that basis.

## Hypothesis 2 — the client does not use `session/list`: **confirmed, but not causal**

`session/list` appears in `MSP_METHODS_SENT` (`src/lib/msp.ts` line 32), the list of methods the Rust side sends. But on the application side, **no call**:

| Occurrence in `src/` | Nature |
|---|---|
| `msp.ts:32` | declaration in the method list |
| `App.tsx:386` | a **comment** mentioning it |

**The client therefore never asks the host which sessions exist.** It cannot discover a session the host knows but local storage ignores, nor reconcile an identifier after a restart.

**Is that the cause of the failure observed?** Not demonstrated. It is a **missing capability**, not a proved defect.

## Hypothesis 3 — the session had never been persisted: **the most likely**

`msp-resume-free-session.mjs` showed that a session **only persists by writing a turn**: host A listed 10, host B **9** — the session created with no turn had disappeared.

The failure documented in the campaign README concerned session `01a0bd8e`, active during the campaign. Several sessions in that campaign were created and used **with no completed turn** (the cleanup showed it: shells at `turnCount: 0`).

**If the session was never written to disk, no host can resume it** — and `sessionNotFound` is then the **correct answer**, not a defect.

**I could not verify it for `01a0bd8e` specifically**: the session was deleted during the cleanup. It is a hypothesis supported by a measured mechanism, not proof on that particular case.

## What is established, and what is not

| Claim | Status |
|---|---|
| The host can resume a persisted, free session | **proved** — `session/resume` succeeds, `session/read` answers |
| A session with no completed turn does not persist | **proved** — 10 sessions on A, 9 on B |
| The client never calls `session/list` | **proved** — no call occurrence in `src/` |
| The `ephemeral` gate blocked a resume | **unproved, and contradicted** by the 41 × `durable` stored |
| The campaign failure came from an unpersisted session | **likely, unproved** — the mechanism is measured, the specific case is not |

## What I did not do, and why

I have **changed nothing in the code**. Two reasons:

1. **No defect is proved.** The gate never fired, and the absence of a `session/list` call is a missing capability, not a demonstrated bug.
2. The resume path touches **conversation recovery**. Introducing an unproved change there, without being able to reproduce the original defect, would be exactly the kind of fix this campaign spent its time disproving elsewhere — like the `prefers-contrast` fix attempted then withdrawn.

**What would need doing, if the subject is picked up:** reproduce the resume failure **first** — a session with a completed turn, the application closed, the host killed, then a resume attempt from the interface. As long as that scenario does not fail reproducibly, there is nothing to fix.

## Reproducibility

```powershell
node scripts/msp-resume-free-session.mjs   # proves the host can resume
node scripts/msp-session-survival.mjs      # proves a session with no turn does not persist
node scripts/msp-list-sessions.mjs         # lists what the host knows
```
