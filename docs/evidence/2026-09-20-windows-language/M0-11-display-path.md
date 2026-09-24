# `displayPath()` — behaviour covered (M0-11, 20 September 2026)

Fills a gap identified at round 34: `test/navigationDetails.test.ts` locked down **the call** to `displayPath()`, but the function's **logic** had no test.

## Why this function deserves a test

The module's comment explains it: the native layer canonicalises workspaces into the **verbose** `\\?\…` form, correct for identity and system calls but **unreadable in the interface**. `displayPath()` produces the displayable form — and an error here is **silent**:

- the user sees `\\?\C:\Users\…` in their workspace label;
- or worse, on a UNC path, they **lose the server or the share** with no error raised.

## What is covered

```powershell
node --experimental-strip-types --test test/displayPath.test.ts
```

| Case | Expected |
|---|---|
| `\\?\C:\Users\etien\repo` | `C:\Users\etien\repo` — verbose prefix removed |
| `\\?\D:\` | `D:\` |
| `\\?\c:\temp` | `c:\temp` — drive letter **case insensitive** |
| `\\?\UNC\server\share\folder\file.txt` | `\\server\share\folder\file.txt` — readable share form |
| `\\?\UNC\server\share` | `\\server\share` — with no trailing part |
| `C:\Users\…`, `\\server\share\folder`, `/home/etien/repo`, `relative/path`, `""` | **unchanged** — storage and routing keep the stored value |
| `\\?\UNC\` alone | **unchanged** — both server *and* share are missing |
| `\\?\Volume{abc}\` | **unchanged** — not a UNC path |
| `\\?\UNC\server\share\a b\c d.txt` | `\\server\share\a b\c d.txt` — spaces and final content preserved |
| `\\?\C:\Program Files\Muse` | `C:\Program Files\Muse` |

**The `\\?\UNC\` alone case** is the one I wanted to lock down: the function requires **a server and a share**. A bare prefix must pass through unchanged rather than be truncated into a wrong path — that is the kind of error that only shows up in use.

## Effectiveness verified by mutation, not assumed

Two regressions were introduced into `src/lib/paths.ts`, then removed:

| Regression introduced | Result |
|---|---|
| `return path.slice(4)` → `return path` (the verbose prefix is no longer removed) | **3 failures** out of 6, with the difference shown: `actual: '\\\\?\\C:\\Users\\etien\\repo'` |
| UNC rewrite → `return path` | **2 failures** out of 6 |
| restored | **6/6** |

Without that check, I would have added tests that pass while proving nothing — precisely the error I am trying to avoid.

## Full suite

**948 tests, 217 suites, 948 passed, 0 failures** — against 942 before this commit.

## Scope

- **Unit test only**: the actual rendering of the workspace label in the packaged webview is not verified.
- **No macOS or Linux case**: `displayPath()` handles Windows forms; POSIX paths pass through the function untransformed, which is tested, but no case specific to those systems is covered.
- **Length and very deep paths** untested: no Windows path length limit (`MAX_PATH`, extended paths beyond 260 characters) is tested.
- The function **normalises nothing**: mixed separators, `..` or `.` are not handled, and I have added no test that would suggest otherwise.
