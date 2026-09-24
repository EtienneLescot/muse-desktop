# Scheduled-run ledger, and a testability guard (M3-07, 20 September 2026)

Follows `modules-inaccessibles-aux-tests.md`, which had made `scheduleRunLedger.ts` importable without testing it.

## 1. `scheduleRunLedger.ts` covered

A contract **parallel** to `notificationLedger.ts`, with one difference: this module exposes **no** write queue — `useMuseSessions.ts` passes `saveNativeScheduleRuns` straight to `createLatestWriteQueue`.

```powershell
node --experimental-strip-types --test test/scheduleRunLedger.test.ts
```

| Test | What it locks down |
|---|---|
| declared schema | the constant written into the native payload |
| inert outside a Tauri webview | both directions refuse instead of importing the API |
| inert with no `window` | the guard does not throw in a worker |
| IPC unreachable | **`null` on read, no exception** |
| **never rejects** | 6 absurd entries (`undefined`, `null`, `[]`, a string, an object, `42`) → `null` / `false` |
| guard order | the runtime check precedes the Tauri API import |

The "IPC unreachable" test locks down the contract the **module's comment** states: an unreadable mirror must **fall back** to the renderer's ledger, and the next successful write repairs the mirror. That means `null`, never an exception.

## 2. A guard so it does not happen again

`test/moduleReachability.test.ts` **imports every module in `src/lib`** and fails if one becomes unreachable.

That is the right formulation: simply scanning for extensionless imports **over-reports** the problem, since `import type` statements are erased by type stripping and never bothered anyone. Only an actual import attempt settles it.

**Effectiveness verified, not assumed**: by creating a temporary module `src/lib/tmp-unreachable.ts` with `import { isTauriRuntime } from "./env";`, the guard **fails**:

```
✖ tmp-unreachable.ts can be imported by a test
```

After deletion: **93/93**.

## 3. An error of mine

My first version of the guard failed on **92 modules** — all of them. The cause was not the modules but a **final line I had added for no reason**:

```ts
assert.equal(pathToFileURL(url.pathname).pathname, url.pathname);
```

It looks **tautological**, and is **wrong on Windows**: `pathToFileURL("/C:/…").pathname` gives `//C:/…` where `url.pathname` gives `/C:/…`. All imports were succeeding; it was my useless assertion that made them all look broken. Line removed, the now-useless import dropped.

That is the second time in this campaign that a check I added "to be sure" produced a massive false negative — after the false positive on the focus indicator.

## Result

| Measurement | Before this round | After |
|---|---|---|
| Tests | 966 | **1065** |
| `src/lib` modules with no dedicated test | 2 | **0** |
| Guard against non-importability | none | **1 test per module** |

**1065 tests, 223 suites, 0 failures.** Build green.

## Limits

- The `scheduleRunLedger` tests stay **on the side reachable** by a node process: runtime guard, failure contract, order of checks. The **real IPC call** is not exercised.
- The testability guard proves a module **imports**, not that it **works** nor that it is tested — `env.ts` still has no dedicated test.
- The guard **loads all 92 modules** on every test run: fast here (a few seconds) but a cost that will grow with `src/lib`.
- A module importing a **native dependency** unavailable in node would fail this guard without actually being defective; no such case today, but the guard has no exception list.
