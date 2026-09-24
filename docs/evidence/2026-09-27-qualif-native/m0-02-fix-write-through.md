# M0-02 — Replaying the "write-through" fix: the fallback is no longer persisted

**Platform:** Windows 11 (build 26200) · native Tauri app (`http://tauri.localhost/`, WebView2,
CDP 9222) · frontend embedded in `src-tauri\target\debug\muse-desktop.exe` (built after
`npm run build`) · **27 September 2026**.

## Context

The cause of the projects/threads loss had been identified (see `m1-05-fix-portable-pty.md`): a
corrupted or missing value hydrates as a `[]` fallback, then the mount's write-through persisted `[]`.
Fix in commit `6039510`: `projectsHydratedRef`/`sessionsHydratedRef` guards — hydrated state
is never written, only mutations are.

## A methodological trap discovered (important)

A first replay seemed to **refute** the fix (`"[]"` reappeared in < 1 s) — the cause:
the app loads the frontend **embedded in the binary** (`tauri::generate_context!`), not the Vite
server. Changing the TS without `npm run build` + `cargo build` + a relaunch changes nothing in the
app being run. Origin measured: `location.href = http://tauri.localhost/`; `fetch('/src/hooks/…')`
returns the HTML shell (the embedded asset handler's SPA fallback).

## Protocol

1. Corrupt `muse-desktop.projects.v1` = `not-json-M02c` (an exact simulation of the loss on kill).
2. `location.reload()`, sample the key at +2 s and +10 s.
3. Compare the old build with the fixed build.

## Result — FIX CONFIRMED

| Sample | Old build | Fixed build (`6039510`) |
|---|---|---|
| +1-2 s | `"[]"` — fallback persisted, value destroyed | **`not-json-M02c`** — intact |
| +10 s | `"[]"` | **`not-json-M02c`** — intact |

The corrupted value **is never overwritten any more**: transient corruption no longer becomes
permanent erasure.

## Side observation — redemption by the host

After replaying the corruption on `sessions.v1`, the app **rebuilt the thread list from
the host's history** (59 sessions restored, titles `Session 01a0c9xx`, workspace
`\\?\G:\repos\openscreen`) and persisted it (a real mutation, the correct behaviour of the fixed
write-through). The threads therefore also survive on the host side, independently of localStorage.

Final restoration: `projects.v1` reinstated from the backup key `m02.bak.p`, and the
`openscreen` project shown again.

## Replaying a real `taskkill /F` — PASSED (a "dirty" kill mid-turn)

On the fixed build, a turn started ("Reply with exactly the word: KILLTEST", writes in flight:
log, session, active) then **`taskkill /F /PID 23040` at +3 s**, relaunch:

| | Before the kill | After the kill + relaunch |
|---|---|---|
| localStorage keys | 36 | **36** ✓ |
| `projects.v1` | 172 bytes (1 project) | **172 bytes (1 project)** ✓ byte for byte |
| `sessions.v1` | 13,557 bytes (59 threads) | **13,578 bytes (61 threads)** ✓ valid JSON, enriched |

**No corruption, no loss**: projects and threads intact after a brutal kill mid-turn.
With the fix, even if a value were corrupted in flight, the fallback would no longer be
persisted (the marker test above) and the host would rebuild the threads (the redemption above).

## The composer's draft — DEFECT: not preserved (M0-02's missing piece)

"Keep unsent work (the draft)" — **not implemented**: `draft-marker-M02-unsent` typed
into the composer (real keyboard, no send), waited 7 s:

- **no localStorage key** contains the marker (no draft-type key exists);
- `taskkill /F` + relaunch: **draft lost** (field empty, storage empty).

The value lives only in the composer's React state — any shutdown (crash, kill, close)
loses it. Expected fix: debounced per-thread persistence of the draft (a
`muse-desktop.drafts.v1` key, for example) with restoration when the thread mounts.

## Reproducibility

```powershell
# 1. fixed build: npm run build ; cargo build (from src-tauri) ; relaunch the exe
# 2. in the CDP console (scripts/cdp-drive.mjs eval):
localStorage.setItem("muse-desktop.projects.v1", "not-json-M02c"); location.reload();
# 3. after 2 s and 10 s:
localStorage.getItem("muse-desktop.projects.v1"); # expected: "not-json-M02c" (before: "[]")
```
