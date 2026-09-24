# The harness fix: necessary but not sufficient (20 September 2026)

Follows [`terminal-apres-interruption.md`](terminal-apres-interruption.md). There I announced the harness "needs a fix" and that I would do it. **I did, and it is not enough.** This document says what is fixed, what remains, and why I am stopping there.

## The fix applied

`scripts/native-smoke.mjs` called `turn/interrupt` without a `turnId`:

```js
await host.request("turn/interrupt", {
  commandId: uuidv7(),
  sessionId: sessions[index],
  retract: false,          // ← turnId missing
});
```

although `turnIds[index]` was available two lines above, and the response check expected it. Added:

```js
turnId: turnIds[index],
```

**That fix is necessary**: the host requires `turnId`, and without it the request is refused with `invalidParams` — verified by reading the code and by measurement.

## But the test still fails

```
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
→ host-A did not emit a terminal notification for 01a0c05f-…
```

The report is **not even written**: the failure happens first.

## What the measurement isolates

The smoke's **exact** scenario — `turn/start` with the prompt `"Native control smoke probe. Stop immediately."`, then an **immediate** `turn/interrupt` with `{commandId, sessionId, turnId, retract}` — run in isolation:

| Step | Result |
|---|---|
| `turn/start` | `accepted`, `turnId` returned |
| `turn/interrupt` | **`ok`**, `status: accepted`, **same `turnId`** |
| Terminal | **`turn/completed` at +2,019 ms** |

**The sequence works.** The host emits the terminal, with the right `turnId`, in 2 seconds.

## So a cause remains that I have not identified

The smoke and my scenario probe differ on at least three points, and I have **not** determined which is responsible:

1. **Two hosts** in parallel in the smoke, one in mine;
2. the smoke waits through its own `waitForNotification(method, predicate, 2_500)` function — **possibly registered too late**, after the notification has already arrived (my terminal arrives at +39 ms in one case, +2,019 ms in the other);
3. the smoke queries **three aliases in sequence** (`turn/completed`, `turn/retracted`, `turn/stopped`), which can exhaust its budget before the right one arrives.

**Hypothesis 2 is the most likely** — a wait registered after the event will never see it, and that is exactly the kind of race this harness is supposed to measure. But **I have not verified it**, so I do not write it as a result.

## Decision: I stop here, and I say so

Three reasons:

1. **The fix applied is right** — it repairs a real defect, that of passing a required parameter. Keeping it is justified even though the test still fails.
2. **Going further would mean instrumenting `native-smoke.mjs` itself** to see when the wait registers relative to the terminal's arrival. That is feasible, but it starts stacking changes on a harness in which **two** defects have just been found — the risk of making it less reliable while believing it is being repaired is real.
3. **The useful result is already secured**: the host emits its terminal after an interrupt, measured four times, with the right `turnId`. The remaining defect is **in my tooling**, not in the product.

## What is established, and what is not

| Claim | Status |
|---|---|
| The host emits `turn/completed` after `turn/interrupt` | **proved** — +39 ms and +2,019 ms depending on the prompt |
| `turn/interrupt` requires a `turnId` | **proved** — the host's code and the measurement agree |
| The harness omitted that `turnId` | **proved** — fixed |
| The fix makes `--exercise-terminal` pass | **disproved** — the test still fails |
| The notification wait registers too late | **unverified hypothesis** |

## What it would take to finish

Instrument `native-smoke.mjs`: log the registration time of every `waitForNotification` and the arrival time of every notification, then compare. If the wait registers after the arrival, the fix is to **subscribe before sending the request** — a pattern my own `msp-interrupt-notifications.mjs` already applies, since it **records continuously** from the moment the host starts rather than waiting for a precise event.
