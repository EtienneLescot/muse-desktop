# Remaining client-side work — plan (20 September 2026)

This campaign spent twenty rounds asking the sidecar for things it **already provided**. The six gap findings were six artefacts of method. This document turns the useful result of that investigation — **the correct call shapes and the capabilities that really are available** — into a work plan for the client.

Audience: the next session, or you.

## What host 1.3.0 provides, verified

| Capability | Call | Proof |
|---|---|---|
| Resume a persisted session | `session/resume` + `session/read` | `msp-resume-free-session.mjs` — success on a free session |
| Enumerate sessions | `session/list` | 10 sessions with `path`, `turnCount`, `status`, `branch`, `title` |
| Read history | `session/read` | returns `{session, viewCursor, history, pendingRequests}` |
| Read the approval state | `session/read` → `session.approvalMode` | `{mode, source, lastCommandId}` |
| Configure approval | `session/setApprovalMode` | `onRequest`, `allowAll`, `promptUnmatched` accepted |
| Run a command and read its output | `session/userShell` | `userShell` item published, output included |
| Change model | `session/setModel` | `modelId` updated on the session |
| Change reasoning effort | `session/setReasoningEffort` | `session/reasoningEffortChanged` notification |

## The call shapes, not to be rediscovered

Every one of these shapes was found **after** producing a false gap finding with an incorrect one. They are measured.

```js
// userShell capability: NESTED inside capabilities. The other shapes grant [].
initialize({ clientInfo: { name: "muse_desktop", version: "1.0.0" },
             capabilities: { requestedCapabilities: ["userShell"] } })
// → grantedCapabilities: ["userShell"]

// The handshake is incomplete without this notification: every later call answers `Not initialized`.
notify("initialized", {})

// commandId is a UUIDv7. crypto.randomUUID() (v4) is REFUSED.
session/start        { commandId, workspaceRoot }
turn/start           { sessionId, commandId, input: [{ type: "text", text }] }
turn/interrupt       { sessionId, turnId, commandId }        // turnId REQUIRED
session/userShell    { sessionId, commandText, commandId }   // commandText, not command
session/setModel     { sessionId, commandId, model: { modelId } }   // modelId is NESTED
session/setReasoningEffort { sessionId, commandId, reasoningEffort } // not `effort`
session/setApprovalMode    { sessionId, commandId, mode }   // only onRequest, allowAll, promptUnmatched
```

## Workstream 1 — **CORRECTED: it does not exist**

**What this document claimed (round 63):** "`session/list` is declared in `src/lib/msp.ts:32` but no call exists on the application side."

**That is false, and the error is the same as the other six**: I had searched `src/` only, ignoring the Rust bridge.

**The reality, verified in `src-tauri/src/main.rs`:**

| Element | Finding |
|---|---|
| `session/list` is called | **yes**, `main.rs:4507`, with bounded pagination (`MAX_SESSION_LIST_PAGES`) |
| By which command | **`restore_sessions`** — which takes no workspace parameter |
| Scope | it **walks every host** (`for (root, client) in clients`) |
| Filtering | `hosts.owns(sid, &client) \|\| hosts.bind(sid, &root, &client).is_ok()` (`main.rs:4529`) |
| Metadata | `session_meta_from_list_row(&root, s, …)` — the `root` **of the current host**, correct |

**The client therefore does ask the host which sessions exist, and restores only those a live host owns.** That is **correct and deliberate** behaviour: a session with no host cannot be resumed, so restoring it would serve no purpose.

**What that explains:** session `01a0bd8e`, visible in the sidebar and absent from `session/list`, was a **local shell** — the host did not own it, and `sessionNotFound` on resume was the right answer. It was neither a client defect nor a host one.

**No workstream here.** I am withdrawing it, leaving the record of the error because it is representative: **a seventh finding of absence, a seventh artefact of method.**

## Workstream 2 — The `ephemeral` gate never re-evaluates

**Finding:** `isEphemeralSession` (`useMuseSessions.ts:569`) and `isResumeEligible` (`bootResume.ts:39`) refuse a resume if `session_durability === "ephemeral"`. That value is written **when the session is created** and never revised. Yet the host announced **`ephemeral` then `durable`** on the same day, with no configuration change.

**What is needed:** do not treat a stored `ephemeral` as final. Attempt the resume and let the host answer, or re-read the current durability.

**Honest reservation:** **no proof that this gate ever blocked anything** — all 41 saved sessions carried `durable`. It is a **latent risk**, not an observed defect. To be handled knowingly.

## Workstream 3 — Show the output of `userShell` commands

**Finding:** the host publishes a `userShell` item whose payload **contains the output**. The client has a fallback — inserting the output into the prompt by hand.

**What is needed:** read the item and show it in the interface. No `outputRef` is provided; the output is **in the item**.

## Workstream 4 — Confirm model and effort changes

**Finding:** the model is visible in `session.modelId` after the call, and the effort is signalled by **`session/reasoningEffortChanged`**. Today the client shows the last model **requested**, marked as not live.

**What is needed:** listen to `session/modelChanged` and `session/reasoningEffortChanged`, then reflect the **confirmed** state instead of the requested one.

## Workstream 5 — The terminal after a requested stop

**Finding:** the host emits `turn/completed` **39 ms** after `turn/interrupt`, with the right `turnId`. The client deliberately waits for that terminal (its Rust comment says so).

**What is needed:** check that `interrupt_session` receives a **non-empty** `turnId` — it is optional in the Rust code, and without it the interrupt is refused. Then reproduce a stop from the interface with a trace of the calls.

**The interface observation** — `Stopping…` that never resolves — **stays unexplained** and deserves reproducing before any fix: that is the lesson of the six false findings.

## Before touching the code: reproduce

**For each of these workstreams, the first step is to reproduce the defect reliably.** This campaign showed six times that an unreproduced finding of absence hid an error of method. A fix written without a reproduced defect is a guess, and I withdrew one for exactly that reason (the `prefers-contrast` fix, round 16).

## The measurement tools, to be used instead of `native-smoke.mjs`

`native-smoke.mjs` produced **three documented false negatives**. For any contract check, prefer probes that **record continuously** over those that wait for a precise event:

| Probe | What it establishes |
|---|---|
| `msp-list-sessions.mjs` | what the host knows, with metadata |
| `msp-resume-free-session.mjs` | resume works on a persisted, free session |
| `msp-session-survival.mjs` | a session with no turn does not persist |
| `msp-interrupt-notifications.mjs` | the terminal after an interrupt, all notifications recorded |
| `msp-user-shell-capability.mjs` | the `userShell` capability and item |
| `msp-projection-check.mjs` | model and effort, with the session read back |
| `msp-approval-mode-check.mjs` | the approval modes actually accepted |

## The lesson, for the next session

**A context error is not a missing capability.** Six times, a refused call — an unpersisted session, a capability requested wrongly, a missing parameter, a wrong shape, too short a wait, a mode that does not exist — was read as "the host cannot do this". Before writing that a capability is missing, check that **the scenario actually exercised it**, on a **persisted** resource, with the **required** parameters.
