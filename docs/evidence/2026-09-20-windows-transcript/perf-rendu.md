# Rendering cost of a long transcript — measurements (M1-13, 20 September 2026)

Measurements taken through CDP's `Performance` protocol in the webview, on the native Windows Muse sidecar 1.3.0.
They answer the criterion the roadmap sets as the condition for full virtualisation: "a real measurement of memory and rendering time".

## Protocol

```powershell
node scripts/cdp-perf.mjs --entries 2000
```

The script first takes a **reference** on the real profile, writes 2,000 entries in the persisted format, reloads, takes the metrics, then triggers **one incremental page of 120 entries** and takes the delta. The original log is restored in a `finally`.

## Result

### Loading with 2,000 entries

| Measurement | Value |
|---|---|
| `firstContentfulPaint` | **20 ms** |
| `domInteractive` | 17 ms |
| `domContentLoaded` | 160 ms |
| `loadEvent` | 162 ms |
| Total DOM nodes | 1,942 → **2,938** |
| **`JSHeapUsedSize`** | 12,233 → **12,392 KiB** |
| `LayoutDuration` (cumulative since activation) | **0.012 s** |
| `ScriptDuration` (cumulative) | **2.022 s** |
| `LayoutCount` | 15 |
| Articles mounted in the log | **160** out of 2,000 |
| Log DOM nodes | **967** |
| Log `scrollHeight` | **173,252 px** |
| Total page DOM nodes | 1,954 |

### Cost of one incremental page (120 entries)

| Measurement | Delta |
|---|---|
| `LayoutDuration` | **+0.001 s** |
| `RecalcStyleDuration` | **+0.001 s** |
| `ScriptDuration` | **+0.071 s** |
| Log DOM nodes | **967 → 967 (unchanged)** |
| Articles mounted | 160 → **160 (unchanged)** |

## Reading

**Three findings:**

1. **The window's rendering cost is negligible.** Cumulative `LayoutDuration` stays at **12 ms** for 2,000 entries, and an incremental page costs **1 ms of layout**. The bounded window does its job: neither the article count (160) nor the log's node count (967) moves when 120 more entries are loaded.
2. **The time goes into the script, not the layout**: cumulative `ScriptDuration` reaches **2.022 s** against 12 ms of layout. If there is optimising to do, it is on the JavaScript side — hydration, search, window computation — not on the DOM or CSS.
3. **Memory is contained**: about **+160 KiB** of JS heap to go from the reference to a 2,000-entry log. The log itself weighs 373,671 bytes in `localStorage`.

## Reservations — important

- **These figures are not a performance measurement in the strict sense.** The measurement was taken on a **development build** (Vite, unminified) with **remote debugging active**, which adds unquantified overhead. A release build would give different values.
- **`wallClockToSettledMs` (14,014 ms) is unusable**: it includes my own fixed 14 s wait after the reload, not a rendering time.
- **No frame or frequency measurement.** I did not measure per-frame rendering time, responsiveness to continuous scrolling, or behaviour at 10,000 entries.
- **One machine, one profile.** No variance, no repetition, no comparison between configurations.
- The **sidebar virtualisation** the roadmap mentions as conditioned on these measurements was **not** examined here: these figures concern the conversation log.

**I therefore do not present these measurements as the proof that unblocks full virtualisation.** They give an order of magnitude and move the question: the bottleneck observed is the script, not the layout.

## Restoration

Original log rewritten and **verified**: 21,205 bytes, `hasSynthetic: false`. No profile state left modified.

## State of M1-13

| Criterion | State |
|---|---|
| DOM window bounded over 2,000 entries | measured |
| Incremental loading (scroll + button) | measured |
| Finder outside the window | measured |
| Rendering cost and memory | **order of magnitude obtained**, on a development build |
| Native assistive qualification | **not exercised** |
| macOS / Linux | out of scope |

**M1-13 stays open**: assistive qualification is not done, and these performance measurements hold only for a development build on one machine.
