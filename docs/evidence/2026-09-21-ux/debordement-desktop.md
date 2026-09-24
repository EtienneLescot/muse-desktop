# Work panel overflow — real defects and a repaired instrument (21 September 2026)

Replaces the previous version of this document, in which **every figure was wrong**: they came from a detector that counted deliberate truncation as a defect. What follows was measured with an instrument whose self-test passes, and verified across 13 real window widths.

## Why the previous figures were unusable

The detector counted any element with `scrollWidth > clientWidth`. It therefore flagged as defects:

- `.sr-only` — a **1×1 px** box with `overflow: hidden`. Its **753 px** "overflow" was the length of the hidden text, invisible by design;
- the stylesheet's **51 `text-overflow: ellipsis` rules** — that is, elements doing exactly their job.

It also suffered from three bugs that compensated for each other and produced plausible reports:

| Bug | Effect |
|---|---|
| `offsetParent !== null` as a visibility test | `null` for `<body>` **and every `position: fixed` element** → the control probe declared itself invisible |
| `getComputedStyle().paddingRight` returns the **string** `"0px"` | `"0px" * 1` → `NaN` → `NaN > worst` always false → **every** element silently discarded |
| Rows were named after the **child** that overflowed | the faulty container was announced under its descendant's name → **every report pointed at the wrong element** |

The detector now carries a **blocking self-test**: a 300 px probe inside a 100 px box must be reported at **+200 px**, and the same probe with `overflow-x: hidden` must be **ignored**. No figure is printed if either case fails.

## Real defects, fixed

Three distinct causes, all **intrinsic floors** the grid could not get past.

### 1. Files — fixed floors set too high

`grid-template-columns: minmax(180px, .85fr) minmax(250px, 1.4fr)` + `gap: 12px` imposes **442 px** for **411 px** available. Both columns were at their `min-content` width (172 and 248 px): they could not shrink.

**Fixed**: floors lowered to 140 / 190 px, `min-width: 0` on both columns.

### 2. Desktop — an intrinsic floor wider than the panel

The grid demanded **434 px** for **405 px**. Measured cause: window titles are unbreakable tokens — `Cua.AgentCursorOverlay.default` has a `min-content` width of **223 px**, and its secondary line 207 px. Since `min-width: auto` on a grid item forbids going below that value, the column imposed its floor.

**Fixed**: `min-width: 0` on both columns **and**, above all, a real usability fix — those buttons are 152 px for 223 px of content, so the text was **clipped clean with no marker at all**. They now carry `text-overflow: ellipsis`.

### 3. `.desktop-control-click` — four tracks for 218 px

`auto 68px 68px auto` asks for **265 px** in a 218 px column. `auto` has a `min-content` floor, so the "Click inside window" label imposed the width and the button left the panel.

**Fixed**: the label takes its own full-width line, the two fields and the button share the next.

## Two method traps, which cost the most time

### The cascade trap

`main.tsx` imports `App.css` **then** `Desktop.css`. At equal specificity, the **file imported last wins** — so my media query in `App.css` lost to `Desktop.css`'s base rule, and the Files grid stayed at two columns down to a 720 px window, with up to **104 px** of overflow.

**Rule kept**: a base rule and its fallback media query live **in the same file**. `App.css`, imported first, cannot reliably override `Desktop.css`.

### The proportional threshold trap

The panel's width **does not follow the window proportionally**. Measured on this build:

| Window | Panel |
|---|---|
| 1440 | 478 |
| 1080 | 340 |
| 900 | **369** |
| 760 | 305 |

The value **rises again** between 1080 and 900 px: the conversation column reaches its own minimum and the panel recovers the difference. Reasoning in terms of "40% of the window" is therefore wrong **at both ends**. The thresholds kept come from a sweep of real widths, not from a calculation.

### And a third, on my own screenshots

`ux-review-captures.mjs` forces the panel's width **without** changing the window's. Since the responsive rules react to the window, that produces a state **no real window can reach**: a narrow panel inside a wide window, where the grid legitimately stays at two columns. The matching screenshots were deleted and the script now carries the warning.

## Verification

```
7 tabs · self-test OK · 0 overflow
```

| Width | Files (tracks) | Desktop (tracks) | Deep leaks |
|---|---|---|---|
| 1440 | 2 | 2 | 0 |
| 1366 | 2 | 2 | 0 |
| 1280 | 2 | 1 | 0 |
| 1200 → 720 | 1 | 1 | 0 |

**13 widths tested, 0 overflow**, shallow **and nested** measurements. The sweep measures every descendant of the panel, not only the three grids — precisely the restriction that had let an 8 px leak through in the observation block.

The Desktop panel's original side-by-side layout is **kept from 1366 px up**; stacking is reserved for widths where two columns genuinely do not fit.

## Tools

| Script | Role |
|---|---|
| `scripts/ux-panel-overflow.mjs` | overflows per tab, blocking self-test, preconditions asserted |
| `scripts/ux-breakpoint-sweep.mjs` | a sweep of 13 widths, shallow and nested |
| `scripts/ux-review-captures.mjs` | screenshots + structural assertions |

## What should have happened

The initial 31 px defect on Files was real and **the fix fitted on one line**, but it was drowned under 700 px of false positives: `.sr-only` at 753 px, `.terminal-meta` truncating cleanly, `.file-name` with its ellipsis. **An instrument that reports deliberate truncation as a defect makes the real defect invisible** — and made me write and then withdraw two fixes that treated nothing.
