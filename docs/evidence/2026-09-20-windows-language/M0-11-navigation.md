# Navigation details — wiring verified (M0-11, 20 September 2026)

The second half of M0-11, after the [English copy audit](M0-11-copie-anglaise.md) that covered the first.

## What the "navigation details" half covers

Three elements, all already implemented in `src/lib/`:

| Helper | Role | Existing behaviour test |
|---|---|---|
| `primaryModifier()` | returns `Cmd` on Apple, `Ctrl` elsewhere | `test/a11y.test.ts` |
| `zoomShortcutTitle()` | zoom shortcut tooltip, per OS | `test/a11y.test.ts` |
| `displayPath()` | native path made readable for the user | — |
| `userFacingError()` | centralised error copy | `test/errorCopy.test.ts` |

## The gap I found

The **functions** are tested. What was not, is that the interface **calls** them. A component could hard-code `Ctrl` in a tooltip, or display a raw native path, and **all the existing tests would still pass**.

Checking the real wiring by reading the source — it is broad:

| Surface | Call |
|---|---|
| `App.tsx` | `primaryModifier()`, `zoomShortcutTitle()`, `displayPath(active.workspace)` |
| `SessionSidebar.tsx` | `` `${primaryModifier()}+Tab to switch conversations` `` |
| `InputPanel.tsx` | `` `Send answer (${primaryModifier()}+Enter)` `` |
| **16 components** | `userFacingError(` for their failures |

## The lock added

`test/navigationDetails.test.ts` — 7 tests that fail if a call site disappears or if a helper is redeclared locally (a local copy would drift from the tested implementation).

**Effectiveness verified, not assumed:** by replacing the call in `SessionSidebar.tsx` with a hard-coded `Ctrl` — exactly the regression the test must catch — it **fails**:

```
✖ ../src/components/SessionSidebar.tsx no longer calls primaryModifier()
  — the sidebar shortcut hint switches conversations and is OS-dependent
```

After restoring: **942 tests, 942 passed, 0 failures** (against 935 before).

## Established

- The three navigation helpers are **really wired** into the interface, on the surfaces M0-11 expects them, and that link is now **locked by a test** that fails without it.
- The error copy of the OSS surfaces does go through `userFacingError`, the module whose behaviour is tested elsewhere — **verified across 6 named components**.

## Limits — what is not covered

- The lock is **structural**: it proves the call exists, not that the tooltip **displays correctly** in the packaged webview. A badly rendered, truncated or style-crushed label would not be detected.
- **No verification on macOS or Linux**: `primaryModifier()` tests `navigator.platform`, but only the function's behaviour is tested, not its effect on a real Apple system. The `Cmd` branch is proved by unit test, not by execution.
- **`displayPath()` has no behaviour test**: I only locked down its call. Its edge cases — UNC paths, `\\?\`, spaces, length — are not exercised.
- **Tooltips are not audited exhaustively**: I checked only the call sites listed. Other surfaces may carry hard-coded shortcuts without this test seeing them.
- The **actual rendering of tooltips** (hover, appearance delay, accessibility) is not measured.

## State of M0-11

| Half | State |
|---|---|
| Finish the English | **measured** across 7 surfaces, limits stated |
| Navigation details | **wiring verified and locked**; native rendering and OS branches unexercised |

**M0-11 is not closed.** Both halves now have a reproducible check, but neither has been validated in the packaged webview on all three OSes.
