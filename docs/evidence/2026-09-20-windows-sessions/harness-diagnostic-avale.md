# The harness: what I found, and where I stop (20 September 2026)

Follows [`correctif-harness-insuffisant.md`](correctif-harness-insuffisant.md). I left three unsettled hypotheses there. This document **eliminates two**, **adds an unexpected measurement**, and **stops** at the point where I cannot go further without risk.

## Hypothesis ruled out: the wait would be registered too late

I suspected a race — a wait registered after the notification arrived would never see it. **False.** `waitForNotification` (`native-smoke.mjs:307`) starts with:

```js
const existing = notifications.find(
  (notification) => notification.method === method && predicate(notification.params),
);
if (existing) return Promise.resolve(existing.params);
```

It **first consults the notifications already received**, then registers a wait. The race is therefore handled, and my most likely hypothesis falls.

## Hypothesis ruled out: `turnId`s would collide between hosts

Two hosts launched in the same millisecond produce `turnId`s with an **identical prefix** — `01a0c064` in one attempt, `01a0c065` in another. I suspected a collision that would pair the terminal with the wrong host.

**False, and the measurement is clear:**

```
turnId A (full) : 01a0c065-7833-7bcf-a0e4-1ee48dd10ad0
turnId B (full) : 01a0c065-7833-7053-845d-ffb4c96265b7
IDENTICAL ?     : false
```

The identifiers are **distinct**; the shared prefix comes from both hosts starting in the same millisecond, and a UUIDv7 begins with a timestamp. **A false alarm of mine**, lifted by comparing the full strings.

## An unexpected measurement: with no interrupt, no terminal

The same attempt, **without** `turn/interrupt`, produced **zero** `turn/completed` on either host in 4 seconds:

```
terminal A : []
terminal B : []
```

Whereas **with** an interrupt, both hosts emit their terminal — at **+2,064 ms** and **+3,974 ms** depending on the run.

**My initial probe was therefore right twice, and for a more precise reason than I thought:** `turn/completed` is indeed emitted, but **after an interrupt**, not as a natural ending within that window. That also explains why my measurements gave +39 ms in one case and +2,019 ms in the other: the delay depends on the prompt and the machine, not on a constant.

## What that implies for the harness

The smoke's timeout is **2,500 ms** per alias, three aliases in sequence. Yet I measured the terminal at **+2,064 ms** and **+3,974 ms**. **The margin is thin to non-existent**: on a host slower than mine at test time, the terminal arrives after the timeout.

**That is the most coherent explanation** for everything I have measured — but I have **not** verified it by recording the smoke's exact timeout on a failure, because the harness **swallows its own diagnostic**:

```js
// waitForTerminalNotification
catch {
  // Compatible hosts use different terminal aliases. ...
}
```

The three attempts fail silently, and the final message keeps **only** `did not emit a terminal notification` — without the list of notifications seen, which `waitForNotification` had nevertheless built:

```js
reject(new Error(`${label} timed out waiting for ${method} (notifications: ${seen})`));
```

**The harness throws away the information that would settle it.** That is the third defect found in this tool, after the missing `turnId`.

## Decision: I stop here

Three reasons, and I stand by them:

1. **The remaining defect is in my tooling, not in the product.** The host emits its terminal after an interrupt, measured four times with the right `turnId`. The product is not at fault.
2. **Going further would mean a third fix to the harness** — raising the timeout and/or preserving the diagnostic — on a tool whose two defects have just been found. Stacking unvalidated fixes into a measuring instrument is exactly what produced this campaign's three false findings.
3. **My context budget is nearly exhausted.** Continuing now would mean working without the margin needed to check what I am doing, which is precisely the condition in which I made my previous errors.

## What it would take to finish, precisely

1. **Preserve the diagnostic**: in `waitForTerminalNotification`, do not swallow the three aliases' errors — surface the list of notifications seen instead of only the final message.
2. **Widen the timeout**: 2,500 ms is below the `+3,974 ms` measured on a loaded host.
3. **Re-run** `--exercise-control --exercise-terminal` and check it reports `terminalMethod: turn/completed` instead of `terminalNotification: unsupported`.

Those three steps are bounded and verifiable. They are **not done**, and I do not present them as such.

## Summary of the terminal investigation

| Claim | Status |
|---|---|
| The host emits `turn/completed` after `turn/interrupt` | **proved** — 4 measurements, right `turnId` |
| With no interrupt, no terminal within the window observed | **proved** — 2 hosts, 4 s |
| `turn/interrupt` requires `turnId` | **proved** — code + measurement |
| The harness omitted that `turnId` | **proved** — fixed |
| The fix makes `--exercise-terminal` pass | **disproved** — still fails |
| The wait registers too late | **ruled out** — `waitForNotification` reads the buffer first |
| `turnId`s collide between hosts | **ruled out** — distinct, only the timestamp coincides |
| The 2,500 ms timeout is too short | **coherent hypothesis, unverified** |
