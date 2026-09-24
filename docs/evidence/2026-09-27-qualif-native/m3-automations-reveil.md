# M3 — Automations: execution at the scheduled time, notification and honest wake-up degradation (27 September 2026)

**A complete scenario played in the real application:** a "Once" automation created at 16:31 for
16:34:00 ran at **16:34:11**, created a **new conversation**, captured the answer
**"WOKEN"**, published a **notification** with actions, and marked the occurrence as consumed —
all with a **wake-up** degradation displayed without ambiguity.

## Scenario and measurements

**Automations** panel (`aria-label="Automations"`), form: name `Qualif M3 wake`,
instructions `Reply with exactly the word: WOKEN`, frequency **Once**, `22/09/2026 16:34:00`,
target **New conversation**.

### Persistence (`muse-desktop.schedules.v1`)

```json
{"id":"sched-mucruycl-53csyg","name":"Qualif M3 wake","instructions":"Reply with exactly the word: WOKEN",
 "trigger":{"kind":"once","at":1790087640000},"threadReuse":{"kind":"new"},
 "workspace":"G:\\repos\\openscreen","model":"default","authorizationMode":"yolo",
 "missedPolicy":"latest","timeZone":"Europe/Paris","enabled":true}
```

The contract's taxonomy is there: one-off/cron trigger, thread reuse (`new`),
**per-run workspace isolation** (`workspace`), model, **authorization mode**, missed-run
policy (`latest`), **time zone** (M3-01/02/03/05).

### Execution (`muse-desktop.schedule-runs.v1`) — M3-06

```json
{"id":"run-mucryvm8-17vwjr","occurrenceAt":1790087640000,
 "occurrenceKey":"sched-mucruycl-53csyg:1790087640000","attempt":1,
 "createdAt":1790087651216,"startedAt":1790087651944,"finishedAt":1790087663738,
 "status":"completed","sessionId":"01a0c989-e029-7a01-8467-4a097c50bc2d",
 "resultPreview":"WOKEN","unread":true}
```

- **At the scheduled time, give or take a few seconds**: scheduled 16:34:00 → created 16:34:11 (the
  scheduler's tick granularity), executed in **12 s**, `completed` on the first attempt.
- **A real new conversation**: `threadReuse: new`, a `sessionId` created, a
  "conversation started" status line in the run card (M3-01).
- **Occurrence idempotency**: `occurrenceKey` = `scheduleId:occurrenceAt` — a restart
  cannot replay the same occurrence (M3-04 crash-restart).
- **Visible lifecycle**: tabs `Queued / Running / Completed / Failed / Archived` + controls
  `Inspect run`, `Open conversation`, `Mark read`, `Archive` (M3-04).

### Notification — M3-09

```
Notifications 1 — Unread (1)
"Automation completed: Qualif M3 wake — NEW — WOKEN — 22/09/2026 16:34:23"
   [Open conversation] [Mark read]
```

The ticket's exact acceptance is met: a notification with the **run's result**, **opening
the conversation concerned** and **marking read/unread**. (The Windows system banner requires the
"Enable notifications in system settings" button — an OS setting, to replay with authorization.)

### Native wake-up — M3-08 (honest degradation measured)

Three states observed, all explicit:

1. no active automation: "Native wake-up cleared; no enabled automation is scheduled."
2. an active automation: **"Native wake-up is unavailable; keep Muse open for automations."**
3. scheduler lease: "Native scheduler active — This desktop instance owns the native scheduler
   lease. Checked 16:34:11" (`scheduler_claim` on the wire: `{"ownerId":"scheduler-…","leaseTtlMs":30000,
   "acquired":true,"native":true}`).

The app **explains whether the wake-up API is available and what it requires** ("keep Muse open") —
the "the machine cannot wake up, the app says so" acceptance is met; the app shutting down cleanly
when the lease is dropped remains to be replayed along with the relaunch.

## M3 Windows verdict

- **M3-06 (run with no prior click)**: **proved with the app open** (16:34:00 → run created 16:34:11,
  `completed` in 12 s, a new conversation, the answer captured). The **native wake-up mechanism**
  (`Muse-Desktop\AutomationWake`, relaunching with `--automation-wakeup`) is declared by the app itself
  **unavailable** here ("Native wake-up is unavailable; keep Muse open for automations.") —
  its qualification remains (locked machine, sleep, crash) on all three OSes, never played.
- **M3-07 (sleep, resume, duplicates, failures)**: pieces proved — **exclusive native lease active**
  (`scheduler_claim`: `acquired: true, native: true`, 30 s TTL, ownerId visible), **anti-duplicate
  claim** (`occurrenceKey = scheduleId:occurrenceAt` persisted), the `missedPolicy:
  latest` policy and the occurrence cursor (`No further runs` after a `once` trigger is consumed). Remaining:
  crash/relaunch with non-terminal runs (**Review needed**), retries/exhaustion, sleep.
- **M3-08 (review run results)**: a complete run card measured — `resultPreview:
  "WOKEN"`, `attempt`, `unread`, filters `Queued/Running/Completed/Failed/Archived`, actions
  `Inspect run` / `Open conversation` / `Mark read` / `Archive` + manual retry present. Remaining:
  a business summary and a native run ending (depends on the host).
- **M3-09 (a useful notification)**: **proved** in the app — "Automation completed: … WOKEN" with the
  result, **opening the conversation** and **marking read/unread** (Unread 1 → actions).
  Remaining: the native permission prompt (`tauri-plugin-notification`, system banner).
- **M3-01/02/03/05**: the complete taxonomy persisted (Once/Cron, new conversation, isolated workspace,
  `Europe/Paris`) — the "target an existing conversation while a turn is in progress" variant
  (M3-03) and the **time-zone warnings** (M3-05) remain to be replayed.

Screenshot: [`shots/m3-automation-run.png`](shots/m3-automation-run.png).

## Time zone and DST (M3-07) — resolution measured, warning absent

Two `Once` automations created through the form for **degenerate** local times:

| Case | Input | Displayed and persisted | Verdict |
|---|---|---|---|
| **Gap** (28/03/2027, 02:30 does not exist — switch to summer time 02:00→03:00) | `2027-03-28T02:30` | "At **28/03/2027 03:30:00** · Europe/Paris", `trigger.at = 1806197400000` (= 01:30Z = 03:30 CEST) | resolved by jumping an hour ✓ |
| **Duplicate** (31/10/2027, 02:30 exists twice — back to winter time) | `2027-10-31T02:30` | "At **31/10/2027 02:30:00** · Europe/Paris", `trigger.at = 1824942600000` (= 00:30Z = the **first** occurrence, CEST) | a deterministic choice ✓ |

`timeZone: "Europe/Paris"` persisted **per schedule** (wall-clock time anchored on the IANA time zone,
insensitive to a later change of system time zone). **What is missing, though, is a warning:**
neither the hour jump nor the choice on the duplicate is signalled to the user —
the "the application **displays** and persists scheduling warnings" acceptance is only
half met (persistence is proved, display is not).

## Targeting an existing conversation (M3-06) — an honest refusal + a path comparison defect

Automation `Qualif M3 existing busy` created with `threadReuse: {"kind":"session","sessionId":"01a0c929-…"}`
(the "Count slowly…" thread) and launched by hand (**Run**) while a turn was running in it:

```
run-muct4y1i-5yagz7  status: failed  sessionId: ""
error: "the recorded workspace no longer matches the target conversation"
```

- **A clean refusal**: no partial state (`sessionId: ""`), an explicit error, the run marked `failed`
  with a **persisted notification** (`kind: "run-failed"`, `dedupeKey: run-…:run-failed:<ts>`) —
  no inconsistent state as far as the "refused with no inconsistent state" acceptance goes.
- **But the cause of the refusal is a path comparison defect**, not the thread being busy:
  the automation records `workspace: "G:\repos\openscreen"` while the target conversation
  carries `workspace: "\\\\?\\G:\\repos\\openscreen"` (the raw form returned by `start_session`).
  **Same directory, two spellings → systematic failure.** Consequence: targeting an existing
  conversation can **never** succeed as things stand, and the second half of the acceptance
  ("then reuses the same thread") cannot be played until the comparison is
  normalised. To fix on the app side (a normalised comparison, or storing a single form).
- **Fixed on 22/09/2026 (normalised comparison).** `executeReviewItem` (`useMuseSessions.ts`)
  compares `displayPath(conversation)` with `displayPath(automation)`. Storage keeps its native
  form: Rust uses it as identity, notably to validate a resume (`resume::validate`).
  **Remaining:** replay targeting an existing conversation, on a free thread then on a busy one.

## Restart mid-run (M3-07) — "Review needed" absent, a stale "Running" state

Run `run-mucta00t-3dqgz3` ("Qualif M3 restart", `threadReuse: new`) left in `running` status
then **`taskkill /F`** on the app. After relaunching: the run **still shows "Running"** ("22/09/2026
17:10:49 · conversation started") although the turn and its host are dead — **no
"Review needed" marking**, no visible reconciliation. The "non-terminal runs marked
**Review needed** after a restart and blocked until explicit reconciliation" acceptance **is not
met**: the displayed state becomes inconsistent ("Running" for dead work). To fix /
replay once the marking exists.

## Native wake-up `AutomationWake` (M3-06) — task absent, the app's status honest

`schtasks /query /tn "Muse-Desktop\AutomationWake"` → **"The specified file cannot be found"**
(task not registered on this machine). The status the app displays — **"Native wake-up is
unavailable; keep Muse open for automations."** — is therefore **honest and accurate**. Consequence: the
`--automation-wakeup` mechanism cannot be qualified here until the task is registered
(a new install? `scheduler_schedules_write`?); that is the remaining qualification entry
point.

## Reproducibility

- Commit `aff5467`+; Windows 11 26200, WebView2, CDP 9222; `muse` 1.3.0.
- Sequence: **Automations** panel → form (name, instructions, Once, `datetime-local` at
  +3 min, target New conversation) → **Create automation** → wait for the due time → read the run
  card, `muse-desktop.schedule-runs.v1` and the Notifications.
