# Muse sidecar contract gaps — report to the maintainer

> ## ⚠️ Read this before the rest
>
> **This report claimed five gaps, plus an approval ceiling. All six were disproved.**
>
> | Finding | What this report claimed | Later measurement |
> |---|---|---|
> | 1 | `session/read` and `session/resume` missing | **working** on a persisted session (§1) |
> | 2 | no terminal notification after an interrupt | **`turn/completed` emitted**, +39 ms (§2) |
> | 3 | `userShell` accepted with no item and no output | **`userShell` item published, output included** (§3) |
> | 4 | projections not reported | **model visible on the session, effort signalled by notification** (§4) |
> | 5 | durability constantly `ephemeral` | **variable** (§5) |
> | 6 | `approval_mode` capped at `promptUnmatched` | **no ceiling** — `onRequest`, `allowAll` and `promptUnmatched` all accepted |
>
> **The cause was my tooling, not the sidecar.** Six findings of absence, six artefacts of method: a context error every time — an unpersisted session, a capability requested in the wrong shape, an interrupt without the required `turnId`, parameters in the wrong form, too short a wait, a mode that does not exist — each read as a missing host capability.
>
> **No sidecar contract gap is established.** Host 1.3.0 does what I accused it of not doing. What is left to build is **on the client side**, in this repository.
>
> **Do not carry over any conclusion from this document without re-checking it** on a **persisted** resource and with the **required** parameters. Corrected sections carry their date and their measurement; uncorrected sections do not have that guarantee.

**Recipient:** the Muse sidecar maintainer (us).
**Subject:** capabilities the Muse-Desktop client expects and `muse serve` does not expose, with reproducible measurements and ticket-by-ticket impact.
**Version measured:** Muse Code **1.3.0 (1.3.0-R3401.1)**, native Windows binary.
**Date:** 20 September 2026.

This document does **not** describe client bugs. Every gap was confirmed by querying the host directly, without going through the interface. The commands are provided so every finding can be re-checked.

**Lesson learned by the end of this campaign:** a measurement of absence is only worth something if the scenario **actually exercised** the resource. Four of the five findings in this report did not.

## How to reproduce every measurement

```powershell
# Host contract, without spending a model turn
node scripts/msp-probe.mjs --surfaces --user-shell

# Control, reasoning, model, compaction, against two real sidecars
node scripts/native-smoke.mjs --exercise-control --exercise-reasoning `
  --exercise-model --exercise-compaction --report gap-smoke.json
```

`scripts/msp-probe.mjs` was written for this report: a minimal MSP client that does nothing but describe what the host exposes.

## 1. Read surfaces

The client declares these methods in `src/lib/msp.ts` (lines 28–31) and uses them for resume and reconciliation.

| Method | Measured result | Consequence for the client |
|---|---|---|
| `session/list` | **available** — enumerates persisted sessions with their path and metadata | paginated restore works |
| `approval/listPending` | **available** — returns `{approvals, userInputs}` | pending requests can be recovered |
| `session/read` | **available on a persisted session** — returns `{session, viewCursor, history, pendingRequests}` | **history replay exists**; see the correction below |
| `session/resume` | **`sessionInUse`** on a persisted session already open; `sessionNotFound` on an unpersisted one | a **conditional** refusal, not a missing method |
| `view/page` | **unsupported** as such | `session/read` returns a `viewCursor`: pagination may go through it |

**Major correction (20/09/2026, end of campaign).** This table classified `session/read` and `session/resume` as `unsupported`. **That is wrong, and the error came from my probe.** `msp-probe.mjs` called these surfaces on a **freshly created** session, never persisted: the host answered `sessionNotFound`, and the probe did not distinguish that error from `methodNotFound`. On a session **actually on disk**, `session/read` answers **`ok`** and `session/resume` answers **`sessionInUse`** — four sessions tested, four times.

**Impact:** resume therefore does **not** rest on missing methods. Two narrower questions stay open: `session/resume` on a **free** session was never observed (the app held the sessions during the test), and `view/page` needs re-evaluating against the `viewCursor` that `session/read` returns. Full detail in [`session-read-fonctionne.md`](evidence/2026-09-20-windows-sessions/session-read-fonctionne.md).

**Worth noting:** `approval/listPending` **works** as soon as it is given a `sessionId`; a call **without** one returns `methodNotFound`. The `native-smoke.mjs` harness called it without an identifier and therefore classified it `unsupported` — the repository's documentation carried that error for a while. **This is the same trap as `session/read`**: a context error read as a missing method. The probe must explicitly distinguish `methodNotFound` from `sessionNotFound`, and test read surfaces on a **persisted** session.

## 2. Turn terminal notification — **emitted on normal completion, absent after an interrupt**

**Second correction (20/09/2026, round 55).** This paragraph then claimed that **no** terminal is emitted after an interrupt. **That is wrong too**, and the table now reads:

| Situation | Terminal notification | Measurement |
|---|---|---|
| **Turn carried to normal completion** | **`turn/completed` emitted** | `msp-resume-free-session.mjs` |
| **Turn interrupted by `turn/interrupt`** | **`turn/completed` emitted at +39 ms** | `msp-interrupt-notifications.mjs` — with `{sessionId, turnId, commandId}` |

After an interrupt the host emits `item/completed` (+19 ms), `session/statusChanged` (+39 ms) then **`turn/completed` (+39 ms)**, carrying **the expected `turnId`**, and **zero** `item/delta` afterwards: the turn did stop, and the terminal confirms it.

**Why I believed otherwise:** `native-smoke.mjs` calls `turn/interrupt` **without a `turnId`** (`{commandId, sessionId, retract}`), while the host requires one. The interrupt was refused with `invalidParams`, the turn was never interrupted, no terminal could arrive — and the harness translated that absence into `terminalNotification: unsupported`. **The harness needs a fix:** pass the `turnId` of the turn it is interrupting.

**Impact, corrected a second time:** there is **no terminal gap on the host side**, neither on the nominal path nor on the stop path. The interface observation — `Stopping…` that never resolves, the "waiting for the desktop host to confirm it" banner — stays **unexplained**, but it can no longer be attributed to a missing terminal: the host provides it. Three leads remain open, none settled: the renderer may not be passing a non-empty `turnId` to `interrupt_session`; the terminal may be arriving without being associated with the right turn; the observation may date from a different state. Detail in [`terminal-apres-interruption.md`](evidence/2026-09-20-windows-sessions/terminal-apres-interruption.md).

## 3. `session/userShell` — **works**, and the output is reported

**Correction (20/09/2026, round 59).** This paragraph claimed the host accepts `session/userShell` **without ever publishing an item**. **That is wrong on both counts.**

The cause was in how I requested the capability. It must be **nested inside `capabilities`**:

```js
initialize({ clientInfo, capabilities: { requestedCapabilities: ["userShell"] } })
```

My other shapes — `capabilities: { userShell: true }`, `capabilities: ["userShell"]`, or `requestedCapabilities` at the root level — all fail with `grantedCapabilities: []`, and the call then answers `session/userShell requires the userShell capability`. **I read that refusal as a missing feature.**

With the right shape:

| Measurement | Result |
|---|---|
| `grantedCapabilities` | **`["userShell"]`** |
| `session/userShell` with `commandText` | **`ok`**, `status: accepted` |
| Items published | **`item/started` and `item/completed`**, of `kind: "userShell"` |
| **Command output** | **present in the item payload** |
| `outputRef` | absent — but the output is reported another way |

**Proof by content, not by the presence of a field:** the command executed writes a unique marker (`muse-ushell-<timestamp>`) and that marker is **found in the notifications** received after the call.

**Impact, corrected:** the "run a command and see the output" path **is achievable**. Nothing on that side is blocked by the sidecar. What would be missing, if anything were, is **on the client side** — requesting the capability in the right shape and reading the item. Detail in [`user-shell-fonctionne.md`](evidence/2026-09-20-windows-sessions/user-shell-fonctionne.md).

## 4. Effective projections — **they work**

**Correction (20/09/2026, round 61).** This paragraph claimed both settings are accepted with no usable projection. **That is wrong.**

The cause, as with the other gaps: **my parameters were wrong**.

| Method | What I was sending | What the host expects |
|---|---|---|
| `session/setModel` | `{ sessionId, modelId }` | `{ commandId, sessionId, model: { modelId } }` |
| `session/setReasoningEffort` | `{ sessionId, effort }` | `{ commandId, sessionId, reasoningEffort }` |

My calls were refused with `invalidParams` — which says **nothing** about the host's capability.

With the right shapes:

| Measurement | Result |
|---|---|
| `setModel({ model: { modelId } })` | `accepted` |
| **`session.modelId` after the call** | **`muse-spark-1.3-contributor` → `muse-spark-1.3`** |
| `setReasoningEffort("none" / "high" / "ultra")` | `accepted` (all three) |
| **Notifications received** | **`session/modelChanged`** and **3 × `session/reasoningEffortChanged`** |

**The model is visible in the session when it is read back, and the effort is signalled by a dedicated notification.** The only nuance: the session object carries no `reasoningEffort` field — the projection goes through the notification, which is still usable by a client.

Detail in [`projections-fonctionnent.md`](evidence/2026-09-20-windows-sessions/projections-fonctionnent.md).

<details>
<summary>Original finding, kept for the record — <strong>disproved</strong></summary>

*Original finding, produced by `native-smoke.mjs`, a tool this campaign showed produces false negatives.*

Re-checked outside that tool, with `session/start`, `model/list`, then the two calls:

| Call | Result of my check |
|---|---|
| `session/setReasoningEffort` (`none`, `high`, `ultra`) | **`invalidParams`** |
| `session/setModel` (`muse-spark-1.3`) | **`invalidParams: missing f…`** |

An `invalidParams` on **my** request says **nothing** about the host's capability: it is the same trap as the `approval/listPending` call without a `sessionId` that had already produced a false finding in this repository.

What `model/list` does return, and which is measured: `{providerId: "meta", profileId: "tbh", source: "providerCatalog", models: [{modelId: "muse-spark-1.3", …}]}` — the catalogue exists and can be queried.

| Setting | Acknowledged | Projection | Effective |
|---|---|---|---|
| `session/setReasoningEffort` — `none`, `high`, `ultra` | *accepted* (all three) | **`not-reported`** | *empty* |
| `session/setModel` — `muse-spark-1.3` | *accepted* | reported | **`isActive: false`** |
| `session/compact` on a blank session | — | — | **`missing-run`** |

</details>

**Impact: unknown.** Neither "the client cannot prove a setting took effect" nor the opposite is established. `session/read` exposes `modelId` and `providerId` on the session — the projection may simply be readable there, as `approvalMode` is.

**What would be needed:** find the correct shape of both calls, then read the session back to see whether the setting appears there. Bounded, not done.

## 5. Session durability — **variable**, not `ephemeral`

**Correction (20/09/2026, end of campaign).** This paragraph claimed `initialize` announces `sessionDurability: "ephemeral"`. **That is incomplete and misleading.**

Measured at the start of the campaign: **`ephemeral`**. Measured at the end, **four times in a row on fresh hosts**: **`durable`**. The configuration did not change between the two (`settings.json` and `auth.json` date from 19/09, before the first measurement), and the result depends neither on `clientInfo.name` nor on the capabilities requested.

**I cannot identify the cause.** What is established is that **`sessionDurability` cannot be documented as a constant of host 1.3.0**: its value changed on the same machine, the same day, with no configuration change.

Direct consequence of the resume failure, observed from the interface after reconnecting:

> `MSP error -32020: session … was not found [sessionNotFound] [retryable=false]`

The client shows "Your saved messages are still available" and fabricates no false success — correct behaviour, but **the explanation is no longer the right one**.

### What `session/list` demonstrates instead

The host **knows 9 sessions**, each with its **storage path** on disk

```
%USERPROFILE%\.local\share\muse\sessions\<year>\<month>\<day>\<sessionId>\session.jsonl
```

and complete metadata: `title`, `turnCount`, `status`, `workspaceRoot`, `branch`, `updatedAt`, `providerId`, `modelId`, `firstUserPrompt`.

**History is therefore already persistent and enumerable.** `session/read` and `session/resume` are not missing in order to *create* persistence, but to **read from a client** what the host already stores.

### A hypothesis to test, which could close M0-02

If the host is `durable` and `session/list` enumerates these sessions, then **the host knows the session after a restart** — and the resume failure would come from the **client**, which starts a new host without reconciling against the sessions already present. That would be a **client-side defect, fixable**, and not a sidecar blocker.

**This is a hypothesis, not a result.** It is testable: restart the application and check whether the client offers, on resume, a session that `session/list` enumerates.

**Impact:** no resume after a restart is possible. A `durable` value with a working `session/read` would be the shortest path to closing several tickets at once.

## 6. `initialize` fields actually exposed

Measured: `experimentalApi`, `grantedCapabilities`, `museHome`, `platformFamily`, `platformOs`, `schema`, `serverInfo`, `sessionDurability`, `userAgent`.

Two notes for the protocol documentation:

- **`initialize` requires a `clientInfo.name` matching `^[a-z0-9_]+$`** — a hyphen fails the call with an explicit message (`SS1.4.1`). Correct, but undocumented on the client side; we discovered it while writing the probe.
- Useful shape details, absent from our documentation: `session/start` takes `workspaceRoot` (not `cwd`) **and requires `commandId`** — without it, `invalid session/start params: missing field 'commandId'` — and answers `result.session.sessionId`; `session/userShell` takes **`commandText`** (not `command`); `turn/interrupt` requires **`commandId` in addition to `turnId`**. A client must also send the **`initialized`** notification after `initialize`, otherwise every later call answers `Not initialized`.

## Where sessions live — and why that matters for resume

`session/list` returns each session's **storage path**:

```
%USERPROFILE%\.local\share\muse\sessions\<year>\<month>\<day>\<sessionId>\session.jsonl
```

Fields exposed: `sessionId`, `path`, `status`, `activeTurnId`, `createdAt`, `updatedAt`, `workspaceRoot`, `providerId`, `modelId`, `turnCount`, `forkedFrom`, `title`, `firstUserPrompt`, `branch`.

**Direct consequence for §1:** conversations **exist on disk** and the host reads them back at startup. Persistence is therefore not what is missing — and `session/read` and `session/resume` **exist and work** (§1 corrected). The data is there, and so is the API to read it from a client.

## Consolidated impact on the group 1 tickets

**Corrected table (rounds 59 to 62).** The old version declared **four M0 tickets blocked by the host**, then left an approval ceiling as the only limit. **Both readings were wrong.**

| Ticket | What this report assumed | Measured |
|---|---|---|
| **M0-01** — concurrent approvals | blocked by a host ceiling | **no ceiling** — `onRequest`, `allowAll` and `promptUnmatched` are accepted, and `session/approvalModeChanged` is emitted |
| **M0-02** — resume after close or crash | `session/read` and `resume` missing | **working** on a persisted session |
| **M0-04** — stop with reliable state | no terminal after an interrupt | **`turn/completed` emitted at +39 ms** |
| **M0-06** — permission posture | limited by the ceiling | **no ceiling** |
| **M1-06** — read terminal output | `userShell` item never published | **item published, output included** |
| **M1-11** — effective model and effort | projections not reported | **model visible on the session, effort signalled by notification** |

**None of these tickets is blocked by the sidecar.** What is left to build is **on the client side**, in this repository — much better news than this report suggested.

## What we are asking for

**Nothing.** This section asked for five sidecar changes. **None of them was founded:** the five original findings and the approval ceiling described **my tooling**, not the host.

| Request | Status |
|---|---|
| `session/read` and `session/resume` | **withdrawn** — they work |
| Turn terminal notification | **withdrawn** — `turn/completed` is emitted |
| `userShell` item with its output | **withdrawn** — published, output included |
| `setModel` / `setReasoningEffort` projection | **withdrawn** — visible |
| `approval_mode` beyond `promptUnmatched` | **withdrawn** — no ceiling, `allowAll` is accepted |

Host 1.3.0 **does everything** this report accused it of not doing. What is left to build is **on the client side**, and this document no longer has a recipient on the sidecar side.

## What this report does not claim

- **It has already claimed two false things**, corrected since: that `session/read` and `session/resume` were `unsupported` (§1 — false, the probe was testing an unpersisted session), and that `sessionDurability` was constantly `ephemeral` (§5 — false, its value changed mid-campaign). Both errors came from the **same cause**: a context error read as a missing capability. Every conclusion in this report should therefore be read with that reservation, and re-checked on a **persisted** session before being carried over.
- It does not say **why** the capabilities that really are missing are absent: design choice, implementation lag or a limit of `serve` mode — we do not know. Note that `muse exec` (headless entry) **does** produce a complete turn, so the engine is capable of it; it is the projection through `serve` that is missing.
- It does not claim these changes are simple: we have not examined the sidecar's code.
- It does **not** cover interactive `muse` mode or `muse exec`, only `muse serve`, which is the only path the application uses.
- All measurements come from a single profile on **Windows**; no macOS or Linux test was run.
