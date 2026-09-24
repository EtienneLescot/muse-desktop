# Truncation ceilings — covered (M1-13 / M0-12, 20 September 2026)

`src/lib/persist.ts` bounds two collections that are, by nature, unbounded:

| Constant | Value | Application points |
|---|---|---|
| `MAX_LOG_ENTRIES` | **2000** | `loadLog`, `appendLog`, `saveLog` |
| `MAX_ALLOWLIST_RULES` | **200** | `loadAllowlist`, `saveAllowlist` |

**Neither had a test.** The risk is silent: a broken ceiling raises no error, it simply lets the history grow without limit.

## Why these ceilings matter, measured

My own performance work (round 22, `M1-13.md`) quantified what an unbounded log costs: at **2,001 entries**, the transcript window mounts **160 articles**, the DOM goes from 1,942 to 2,938 nodes, `ScriptDuration` reaches **2.02 s** and the heap gains 160 KiB. The `MAX_LOG_ENTRIES` bound is what stops the observed slowness from becoming unbounded.

A ceiling that kept the **oldest** entries instead of the recent ones would be just as serious, and **invisible**: the user would watch their recent conversation disappear, believing it was normal truncation.

## Coverage

```powershell
node --experimental-strip-types --test test/persistCaps.test.ts
```

**Log** — ceiling respected on append · **the oldest are dropped, not the newest** · no truncation at exactly 2000 · ceiling held across **successive appends** (not just within one batch) · `loadLog` bounded even when storage already holds more than the ceiling (a log written by an earlier version) · `saveLog` bounded the same way.

**Allowlist** — ceiling respected on save · **the most recent rules kept** · `loadAllowlist` bounded on overloaded storage · a list under the ceiling **unchanged**.

## Effectiveness verified by mutation

| Mutation introduced into `src/lib/persist.ts` | Result |
|---|---|
| Truncation removed at all **3** points | **5 failures** / 10 |
| `.slice(-MAX_LOG_ENTRIES)` → `.slice(0, MAX_LOG_ENTRIES)` | **3 failures**, including *"drops the OLDEST entries, not the newest"* with `actual: 'entry-1999'` instead of `'expected: entry-2004'` |
| restored | **10/10** |

The second mutation is the one that matters: it simulates a truncation that **appears to work** but keeps the wrong side of the history. The test names it and shows the exact difference.

## An error of mine, corrected

My first log-entry fixture had only `role`, `text` and `ts` — **every log test failed** (`0 !== 2000`). Cause: `isValidEntry` also requires a **string `id`**, and **silently filters out** entries that do not satisfy it. The allowlist tests passed, their rules being complete.

I fixed the fixture and documented the requirement in the test file, so the next person does not write the same thing. **It is also a useful observation**: validation on read is strict and silent — an entry with no `id` disappears without trace, which is worth knowing.

## Full suite

**958 tests, 219 suites, 958 passed, 0 failures** — against 948 before this commit.

## Limits

- **Unit** tests: `localStorage`'s real behaviour in WebView2 — quota, eviction, partial write — is not exercised.
- **No performance test** of the ceiling: I did not measure the cost of writing a 2000-entry log on every append. With `appendLog` re-reading then rewriting the whole log, one entry appended at 2000 costs a full serialisation — **that cost is not measured here**, and it is a serious candidate for a future measurement.
- The ceilings are checked **as coded**: I did not assess whether 2000 and 200 are the right values.
- No test of the behaviour when `localStorage.setItem` fails (quota exceeded).
