# Two modules out of reach of the tests — fixed (M3-07 / M3-09, 20 September 2026)

While looking for one last verification gap, I found a **testability** defect touching production code.

## The measurement

I tried to **import** each of the 92 modules in `src/lib` from a node process, as a test does:

| Result | Count |
|---|---|
| Importable | **90** |
| **Not importable** | **2** — `notificationLedger.ts`, `scheduleRunLedger.ts` |
| Error | `ERR_MODULE_NOT_FOUND` |

## The cause, and a correction to my own diagnosis

Those two modules imported **values** without an extension:

```ts
import { isTauriRuntime } from "./env";                    // breaks
import { createLatestWriteQueue } from "./writeQueue";     // breaks
```

Node ESM requires the extension, even with `--experimental-strip-types`.

**I was wrong at first**: by scanning for extensionless imports, I listed **15 modules** as "not importable". That was false. Most of those imports are **`import type`** statements, which type stripping **erases** — `compact.ts` and `phase.ts` import only types that way and pass their tests without trouble. Only an actual import attempt gives the right answer: **2 modules**, not 15.

## Why it matters

The two modules concerned are not dead code: `useMuseSessions.ts` uses them in production (imports at lines 296 and 341-343, write queues at lines 1673 and 1684, loading at lines 2406 and 2431). They form the **native mirror** of the notification inbox (M3-09) and of the scheduled-run registry (M3-07).

They were therefore **strictly out of reach of any test**: no test file could import them.

## The fix

Added the extension to the **value imports** in both files. `tsc --noEmit` and Vite accept it (verified: build **exit 0**).

## The test added

`test/notificationLedger.test.ts` — 8 tests that stay on the side of the boundary a node process can reach:

| Test | What it locks down |
|---|---|
| declared schema | the constant written into the native payload |
| inert outside a Tauri webview | both directions refuse instead of importing the Tauri API |
| inert with no `window` | the guard does not throw in a worker |
| IPC unreachable | returns `null` / `false` instead of throwing |
| **never rejects** | 5 absurd entries → `null` / `false`, with no exception |
| synchronous queue | the enqueue call does not return a promise |
| **write coalescing** | a write in flight absorbs the following ones, the last state wins |
| failed write | the queue **continues** after a rejection, it does not jam |

## A second error of mine

My first queue test asserted that **every** enqueue reaches the writer. It **failed** (1 write seen instead of 3) — and it was **the test that was wrong**.

`createLatestWriteQueue` is a **last-write** queue: intermediate states are **deliberately coalesced** while a write is in flight, so the native mirror never lands on a stale value. The name says so. I rewrote the assertion to describe the real contract — one write starts, the following ones are coalesced, the last wins — and it passes.

That is exactly what measurement brings: without that test, I might have "fixed" correct behaviour.

## Result

| Measurement | Before | After |
|---|---|---|
| `src/lib` modules importable by a test | 90 / 92 | **92 / 92** |
| Tests | 958 | **966** |
| Build | green | green |

## Limits

- The **real IPC call** is not exercised: a node process cannot reach `invoke`. What is tested is the runtime guard, the failure contract and the ordering.
- `scheduleRunLedger.ts` became **importable** but **has no test yet** — the obvious next candidate, since its contract parallels `notificationLedger`'s.
- The "IPC unreachable" test depends on the **absence** of the Tauri package from `node_modules` for a node test; if it became resolvable, the test would change meaning without failing.
- No verification that the native mirror **actually writes** durably in the packaged application.
