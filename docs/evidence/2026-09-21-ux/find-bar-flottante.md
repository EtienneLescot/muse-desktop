# The "Find in conversation" bar — the real cause (21 September 2026)

Report: "ctrl f find widget is weirdly floating over conversation". The symptom described was accurate; **my first explanation was not**, and this document keeps both because the path matters.

## Two false hypotheses, ruled out by measurement

### "The background is transparent, the text shows through"

**False.** `getComputedStyle` gives an **opaque** background and pixel sampling confirms it: over an empty area of the bar, **384 pixels out of 384** are exactly `238,243,251`, the bar's background colour. No ink from the transcript.

### "The `z-index` loses the arbitration"

**False.** The stack at the same point is `["stream-find", "stream-find-dock", "msg-footer"]`: the bar wins. A message at `static; z-index: auto` cannot pass in front of a `sticky; z-index: 2` element with an opaque background.

Those two checks cost time, and they were **necessary**: without them I would have "fixed" a non-existent transparency.

## The real cause, geometric

| Measurement | Value |
|---|---|
| Width of the conversation flow | **1034 px** |
| Width of the search card | **760 px** |
| Space on each side | **137 px** |

The bar was **itself** the `sticky` element: a centred 760 px card in a 1034 px flow. The text therefore **scrolled in the 137 px on each side** while the card stayed still in the middle, with nothing anchoring it to the edge.

That is precisely what "floating over conversation" describes: not text *behind* the card, but content that keeps scrolling **beside** an element that no longer moves. The drop shadow (`box-shadow: 0 6px 18px`) strengthened the effect by detaching it from the background.

## The fix, in two stages

### First stage: anchoring the bar (insufficient, replaced)

I first gave the bar a **full-width** container carrying the `sticky` and an opaque background, so nothing scrolled beside it. The strip was then **980 px** wide and covered the 137 px on each side.

**That was an improvement, not a solution.** The next report was: "the bar still takes too much room". Measurement: the strip took up **61 px permanently**, that is 69 px of head room above the first message. Anchoring a bar does not solve the fact that it should not be there.

### Second stage: on demand (kept)

**The distinction that was missing** — and the user drew it:

| Control | Role | Treatment |
|---|---|---|
| `Ctrl/Cmd+F` | find text in **the conversation you are reading** | UI **on demand**, no space at rest |
| `Ctrl/Cmd+K` | search **every conversation** | its own entry point, a header icon |

The bar is therefore **no longer rendered at all** until `Ctrl+F` is pressed. The container has `dockHeight: 0` at rest.

**Space given back, measured: 69 px** of head room (`headroom`: 85 px → 16 px, the 16 px being the flow's normal `padding-top`).

### And the entry to global search

The "Search conversations" dialog already existed and opens from the sidebar — but **it disappears when the sidebar is folded**. A search icon was therefore added in the header, next to the other controls, with `Ctrl+K` in its tooltip: the same dialog, not a second implementation.

**Then removed.** That icon duplicated the sidebar's, and the sidebar is unfolded by default: two buttons for one dialog, one of them permanently visible. `scripts/ux-search-entrypoints.mjs` records the addition **and** the removal. **A single entry** for global search therefore remains, in the sidebar. `Ctrl+F` still opens the search **for the current conversation**, which is a different control.

## Verifying the four states

| State | Search bar | Global dialog |
|---|---|---|
| At rest | absent | closed |
| After `Ctrl+F` | **present** | closed |
| After `Escape` | absent | closed |
| Clicking the sidebar entry | absent | **"Search conversations" open** |

`Ctrl+F` is sent through real keyboard events (`Input.dispatchKeyEvent`), not by calling the setter — otherwise the test would only prove React knows how to render a state.

## What was verified after the change

| Check | Result |
|---|---|
| Overflow across the panel's 7 tabs | **0** — no regression |
| Tests / build | **1085, 0 failures** / green |

## A method note

I tested the search with "audio" and got **"0 matches"**, which I first took for a defect. It was my own test searching in the wrong conversation. The check that settles it is to search for a term **first verified to be in the transcript**: `ux-find-bar-finds.mjs` read the flow's text, confirmed the term was there, then searched. A null result then becomes proof instead of an ambiguity.

That is the same lesson as the rest of this campaign: **a passing test is worth nothing if it cannot fail**, and an observed absence is only an absence of capability if you have checked you were looking in the right place.

## The real teaching of this defect

I treated the same symptom **three times** before finding the right level:

1. `sticky` with an opaque background — the bar was correct, the problem was the width;
2. a full-width pinned dock — the side scrolling is solved, the clutter remains;
3. **on demand** — the symptom disappears.

The first two answers were **technically correct fixes to a badly framed defect**. The report said "floats" and "too much room"; I treated "floats" before hearing "too much room", although **the second phrase held the real request**: this element should not be there permanently.
