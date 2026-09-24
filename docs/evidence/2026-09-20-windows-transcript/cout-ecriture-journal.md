# Log write cost — measured (M1-13, 20 September 2026)

Measuring a lead I had identified without quantifying: **`appendLog` re-reads and rewrites the whole log** on every append.

```ts
export function appendLog(sessionId: string, entries: LogEntry[]): void {
  if (entries.length === 0) return;
  const cur = loadLog(sessionId);                          // re-reads EVERYTHING
  write(logKey(sessionId), [...cur, ...entries].slice(-MAX_LOG_ENTRIES));  // rewrites EVERYTHING
}
```

## Protocol

```powershell
node --experimental-strip-types scripts/bench-log-append.mts
```

The bench imports the **real** `appendLog` / `saveLog` / `loadLog` functions from `src/lib/persist.ts` and exercises them against an in-memory `localStorage`. It seeds a log of a given size, then measures **60 single-entry appends**, after one warm-up append.

## Result — three passes

| Log size | Pass 1 | Pass 2 | Pass 3 | ×base | Storage |
|---|---|---|---|---|---|
| **100** | 0.101 ms | 0.109 ms | 0.113 ms | 1.0 | 19 KB |
| **500** | 0.294 ms | 0.311 ms | 0.305 ms | 2.8 | 68 KB |
| **1000** | 0.583 ms | 0.579 ms | 0.604 ms | 5.5 | 129 KB |
| **2000** | **1.154 ms** | **1.187 ms** | **1.208 ms** | **11.0** | 246 KB |

**Growth is linear, not quadratic.** A ×20 increase in size (100 → 2000) gives a ×11 increase in cost per append. The three passes agree to within 5%.

The cost is therefore proportional to the log's size, and a turn's **total** cost is too: `O(size × number_of_appends)`.

## What that means for a real turn

Taking **1.15 ms** per append on a 2,000-entry log:

| Append granularity | Turn's write cost |
|---|---|
| 100 appends | ~0.12 s |
| **500 appends** | **~0.58 s** |
| 2,000 appends | ~2.3 s |

**Set against an independent measurement**: at round 22, I measured a `ScriptDuration` of **2.02 s** on the real application to display a 2,001-entry log. The write cost computed here for 500 appends (~0.58 s) is in the same order of magnitude as that script expenditure — so **not negligible**, but not dominant either.

## Conclusion

**There is no defect.** The full rewrite is an expensive choice but of linear complexity, and the `MAX_LOG_ENTRIES` ceiling bounds it: at the ceiling, an append costs **about 1.2 ms**. For normal use, that is acceptable.

The only case that would deserve attention is a **very high append granularity** — if the stream split the answer into thousands of appends, the write cost would approach 2 seconds per turn, which would become noticeable. I did not measure the stream's real granularity in the application.

## Scope — what this measurement does not say

- **Measured in a node process**, against an in-memory `localStorage`. The real cost inside WebView2 — serialisation to the engine's storage, disk writing — is **probably higher**, and I did **not** measure it. The figures above are a **lower bound**.
- **No measurement of real granularity**: I do not know how many appends a typical turn produces in the application. The "for a real turn" table is a calculation, not an observation.
- The log values are **synthetic** entries of plausible length (~70 characters). A log of very long messages would cost more, since the cost follows the number of **bytes** serialised, not only the number of entries (confirmed: 2000 entries ≈ 246 KB).
- **No alternative implemented or evaluated**: I did not test whether keeping the log in memory and writing in batches would be cheaper. That a cost is acceptable does not mean it is optimal.
- Three passes on **a single machine**, with no isolation from system noise.
