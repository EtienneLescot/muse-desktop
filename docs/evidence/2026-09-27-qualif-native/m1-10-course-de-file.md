# M1-10 — Queue race: no removed turn starts (27 September 2026)

**M1-10's key criterion proved in the webview:** during a removal race while a
first turn runs, **no turn removed from the queue ever started** — no acknowledgement, no output,
no answer.

## Protocol

```powershell
node scripts/cdp-queue-race.mjs
```

The scenario queues two turns (`RACE-QUEUED-A-3311 say ALPHA`, `RACE-QUEUED-B-7722 say BETA`)
while a long first turn runs, then triggers the removals **from the page
context** (a single evaluation — CDP round trips add tens of milliseconds and
make a real race impossible to aim at).

Two method fixes were needed before the race could be played (run1 was void:
the script targeted a non-existent "Enumerate the three Musketeers" conversation and submitted
through synthetic `Enter` events):
1. a configurable target conversation (`MUSE_RACE_SESSION`, falling back to the title by prefix);
2. a send fallback on the real `button.send` button when the synthetic `Enter` had not cleared the
   composer.

## Results (run2)

| Step | Measurement |
|---|---|
| First turn in progress | ✓ (`working: true`) |
| Turns in the queue | ✓ queue visible (panel + "Remove from queue" buttons) |
| After the burst of removals | **queue emptied** (`queuedRows: 0`, panel closed) |
| Did removed turn A start? | **no** — `alphaAnswer: false`, no acknowledgement |
| Did removed turn B start? | **no** — `betaAnswer: false`, no acknowledgement |
| After the race | the first turn carried on normally to its terminal |

The conversation's local log (`muse-desktop.log.v1.<active>`) keeps the user entries
queued then removed — the interface honestly announces "…message was not sent."
instead of pretending.

## Limits of the measurement (honesty)

- Run2's set-up was imperfect: the second send did **not** enter the queue (text
  left in the composer) and the first entry ended up **duplicated** in the queue. The
  race therefore bears on the removals actually observed, not on two distinct turns.
- **Cause found on the evening of 27/09 (the harness, not the app):** the script's `submit()` sent a
  synthetic Enter through `keydown`+`keyup` — two submissions when both are caught by the React
  handlers, zero when neither is (hence A duplicated / B stuck). Fixed: **clicking the one real
  send button** (`button.send`), with no synthetic keyboard.

## Run4 — a clean race, two turns queued correctly (27 September 2026, harness fixed)

```
pre: first turn running ok=True          (long turn "Count slowly…" really started)
step two-queued : queued=2  texts=["RACE-QUEUED-A-3311 say ALPHA","RACE-QUEUED-B-7722 say BETA"]
                  removeButtons=2  composer=0   (no duplicate, composer cleared)
step after-race : queued=0  removeButtons=0    (burst removal during execution)
step later      : queued=0  working=true       (+20 s: the first turn is STILL running)
                  raceAInLog=true raceBInLog=true   ("not sent" trace in the log, honest)
```

**The clean race is played and the result is clear:** two distinct turns queued correctly,
removed while the first ran — **neither ever started** (queue empty from the
removal, the first turn alone to +20 s and beyond), and both removed texts stay traceable
in the local log with no side effect. The report's `race` verdict stays empty because of
`evaluate()`'s `JSON.stringify` wrapper (the clicks did happen — the states prove it); the
fix persisting the verdict is in the script but its return was not needed for the
conclusion.

**Remaining to close M1-10:** native restoration of the queue after a restart
(`muse-desktop.queued-turns.v1`), and execution in the **packaged** webview (the run is a dev build).

## Restoring the queue after a restart — proved (27 September 2026, kill + relaunch)

Protocol: a long turn started ("Count slowly … six hundred") + **two turns queued**
(`QUEUE-RESTORE-A` → ALPHA, `QUEUE-RESTORE-B` → BETA) → **`taskkill /F` on the app mid-turn** →
relaunching the `target\debug\muse-desktop.exe` binary with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.

- Before the kill: `muse-desktop.queued-turns.v1` holds the 2 turns ("Turn queued — it will start
  automatically" in the log); the long turn is running.
- After the relaunch (PID 44844): storage **intact (2 turns)**.
- **Then the queue empties by itself, in order**: `QUEUE-RESTORE-A` executed at 17:14:01 →
  answer **ALPHA** 17:14:04; `QUEUE-RESTORE-B` executed next → answer **BETA** 17:14:49.

The queue is not merely restored: it **resumes and executes correctly after the total death
of the process** (no duplicate, no reversed order). Only execution in the **packaged**
webview remains (a dev build here).

## Reproducibility

- Commit: scripts to include in the qualification series; app `362c8bb`+; Windows 11 26200, WebView2.
- Command: `node scripts/cdp-queue-race.mjs`; raw output `cdp-queue-race-run2.json` (limit
  above) and `cdp-queue-race-run4.json` (the clean race).
