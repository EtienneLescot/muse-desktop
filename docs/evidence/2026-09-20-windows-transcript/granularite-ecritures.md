# Real granularity of log writes (M1-13, 20 September 2026)

Completes `cout-ecriture-journal.md`, where I quantified the cost of **one** append without knowing **how many** a turn produces. The per-turn cost there was therefore a **calculation**, not an observation. Now it is one.

## Protocol

```powershell
node scripts/cdp-stream-granularity.mjs
```

The script wraps `localStorage.setItem` **inside the page**, at run time, and counts the writes touching the log's key. **No application code is modified.** It then sends a real model turn ("Count slowly from one to thirty") and samples every 4 s until the turn ends.

## Result

| Measurement | Value |
|---|---|
| **Log writes** | **33** |
| **Total volume written** | **1,231 KB** |
| Payload per write | **~37 KB** (maximum 38 KB) |
| Log entries before / after | 74 → **79** |
| Writes **outside** the log | 17 |

The first 12 writes are **all 37 KB**, a constant value.

### Distribution over time

| Sample | Writes | KB written | `working` |
|---|---|---|---|
| 1 to 16 | **27** | 1,005 | yes |
| 17 (end) | 33 | 1,231 | no |

The 17 samples cover **more than a minute**. The counter stays at **27 writes from sample 1 to sample 16**: the writes are **grouped at the start of the turn**, then nothing while the turn continues. Six more writes happen at the end.

## What that corrects in my reasoning

**Volume dominates, not frequency.** The turn wrote **1,231 KB** while the log itself weighs only **~9 KB** (a 37 KB payload for a 74-entry log indicates a serialisation much wider than the log's content alone — the stored object is larger than the entries I counted in it). In other words, **more than** a megabyte written for a thirty-number answer: each write rewrites **the whole** log, and `appendLog` also re-reads before writing.

**The per-turn cost, now observed**: 33 writes. Taking the cost measured at round 41 (**1.15 ms** per append on a 2,000-entry log), that gives **~38 ms** of persistence for that turn — negligible for the user.

The "one append per token" model I feared is **disproved**: thirty numbers did not produce thirty writes, and the writes cluster at the start rather than following the stream.

## Conclusion

**No performance problem.** Persistence costs a few tens of milliseconds per turn, against a total of **2.02 s** of `ScriptDuration` measured at round 22. The persistence cost is **marginal** next to the rendering cost.

The point deserving an eye is not the time but the **volume**: 1.2 MB written per turn for a small answer, because every write rewrites the entire log. With long answers and a log at the ceiling, the volume grows, and it is **storage latency** — not measured here — that could start to show.

## Scope — limits

- **A single turn**, a short one (30 numbers). A long answer would produce more writes and a larger volume; I did not measure it.
- The counter is **global to the page**: if another surface wrote to a `muse-desktop.log.v1.*` key, it would be counted. With a single active session the risk is low but not nil.
- **`setItem`'s real latency is not measured**: I count the calls, not their duration. The round 41 bench measures the in-memory cost; the cost inside WebView2 may be higher.
- **The 17 "outside the log" writes** are not attributed: I do not know which keys they touch.
- **`working` stays true** after the writes apparently end: I do not know whether the turn had finished or the stream was simply quiet.
- The "37 KB for 74 entries" ratio is **not explained**; I report it as an observation without concluding on its cause.
