# The harness produces a false negative — demonstrated (20 September 2026)

Follows [`harness-diagnostic-avale.md`](harness-diagnostic-avale.md). I had left an unverified hypothesis there. Both announced fixes are applied, **the test still fails**, but the preserved diagnostic delivered the answer — and it is worse than expected.

## The two fixes applied

1. **The diagnostic is no longer swallowed.** `waitForTerminalNotification` keeps the reason for each attempt instead of ignoring it.
2. **The timeout goes from 2,500 ms to `TERMINAL_WAIT_MS = 15,000`**, with the numeric justification in the code (measured latencies: 39 ms, 2,019 ms, 2,064 ms, **3,974 ms**).

## What the diagnostic reveals

```
host-A did not emit a terminal notification for 01a0c06a-0823-7649-a95e-715847cf45d4
  turn/completed: host-A timed out waiting for turn/completed (notifications: session/started)
  turn/retracted: host-A timed out waiting for turn/retracted (notifications: session/started)
  turn/stopped:   host-A timed out waiting for turn/stopped   (notifications: session/started)
```

**Three times 15 seconds, so 45 s of waiting, and the only notification received is `session/started`.**

Not even `turn/started`. The time budget is therefore **not** at fault: this is not a terminal arriving too late, it is **a turn that never began**.

## The contradiction, measured

The smoke's **exact** scenario — `turn/start` with the prompt `"Native control smoke probe. Stop immediately."`, then an **immediate** `turn/interrupt` with `{commandId, sessionId, turnId, retract: false}` — run against a single host, on the same machine, with the same command-line configuration:

```
turn/start : accepted | turnId 01a0c06a
immediate interrupt : ok status=accepted
terminal within 20 s : turn/completed@+2055ms
notifications        : session/started@1840, session/branchChanged@1922,
                       session/statusChanged@1978, turn/started@1978,
                       item/completed@1978, session/statusChanged@2054, turn/completed@2055
```

**My probe sees everything. The smoke sees nothing.** On the same machine, the same day, with the same call sequence.

## What is established

| Claim | Status |
|---|---|
| The host emits `turn/completed` after `turn/interrupt` | **proved** — 5 independent measurements, right `turnId` |
| The smoke's exact scenario works in isolation | **proved** — complete sequence reproduced |
| The smoke receives only `session/started` | **proved** — diagnostic preserved, 45 s of waiting |
| The smoke's time budget was too short | **ruled out** — 45 s made no difference |
| **`native-smoke.mjs --exercise-control --exercise-terminal` is a false negative** | **established** |

**Only one of the two can be right, and it is not the smoke**: my probe observes the complete sequence, seven notifications, with the expected terminal. The smoke observes one.

## What I do not explain, and why I stop

The smoke and my probe still differ in details I have not neutralised: the smoke launches **two hosts in parallel**, uses a **temporary working directory** and sandbox options specific to its harness, and names the probe differently.

**I have not isolated which of those details prevents the turn from starting.** Doing so would mean instrumenting the smoke itself — a **fourth** fix on a tool whose three defects have just been found — and my context budget no longer leaves the verification margin needed.

**I stop here, deliberately**, rather than stack one more fix into the instrument that has already produced three false findings.

## Why this is the most important result of this investigation

This harness is presented as the **native proof** for several tickets: `--exercise-control` feeds M0-04, `--exercise-approval` M0-01, `--exercise-user-shell` M1-06, `--exercise-reasoning` and `--exercise-model` M1-11.

**Three of its findings turned out to be false**, and I built my gap report on them before dismantling them one by one:

| Harness finding | Measured reality |
|---|---|
| `turn/start` refuses without `commandId` — noted, correct | — |
| `turn/interrupt` without `turnId` → `terminalNotification: unsupported` | **the host emits the terminal** |
| `session/read` reported `unsupported` | **the method works** on a persisted session |

**As long as this harness produces false negatives, any finding resting on it is suspect** — including the two gaps that remain (`session/userShell`, model and effort projections), which I have not re-checked outside its frame.

## What it would take to finish

1. **Isolate the difference**: run the control scenario with **one** host, then with two, then with the smoke's temporary directory, comparing the notifications received at each step.
2. **Or replace the measurement**: `msp-interrupt-notifications.mjs` observes continuously from the moment the host starts, depends on no targeted wait, and sees the terminal on every run. It is simpler and has produced no false finding.

## Reproducibility

```powershell
# False negative — sees only session/started
node scripts/native-smoke.mjs --exercise-control --exercise-terminal

# Sees the complete sequence and the terminal, same scenario
node scripts/msp-interrupt-notifications.mjs
```
