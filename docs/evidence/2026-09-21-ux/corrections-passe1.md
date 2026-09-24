# UX/UI pass no. 1 — fixes and failures (21 September 2026)

Completes [`constats-passe1.md`](constats-passe1.md). This document lists what was **fixed and verified**, and what was **attempted then withdrawn** — the second list counts as much as the first.

## Fixed, with verification

| # | Defect | Fix | Verification |
|---|---|---|---|
| 1 | **The model label wrapped onto two lines** in the composer (`muse-spark-1.3-contributor` in a 168×48 px button) | `white-space: nowrap` + ellipsis at 22ch | 1 line, button 64×32 px |
| 2 | **The light theme violated WCAG AA**: `--muted` at `#78828a` gave **3.62:1** on the sidebar and **3.92:1** on white, against the 4.5 required — all navigation, section labels, the status bar, metadata | `--muted: #6a7279`, a **computed** value (the smallest that passes on both backgrounds: 4.52 and 4.89) | **0 texts below the threshold**, both themes — and **locked by 7 tests** (`test/paletteContrast.test.ts`) whose effectiveness is proved by mutation |
| 3 | **The search modal survived navigation**: after Automations/Extensions/Library, `dialog.task-search` **hid the view's title** (measured: `elementFromPoint` on the `h1` returned `DIALOG.task-search`) | `openPage` now closes `searchOpen` — it already closed `settingsOpen`, the asymmetry was one line (`App.tsx:363`) | after navigation: `modals: []`, `onTopOfTitle: "H1."` |
| 4 | **`outil` in French** in the panel summary (`2 subagent, 0 outil, 0 system`) | `tool` (`ArtifactsPane.tsx:116`) | the `ui-copy.test.ts` guard extended to that file; mutation → a failure naming `} outil` |
| 5 | **Horizontal overflow of the Terminal panel** (+121 px): `.terminal-toolbar` had 411 px for 548 px of content, because `.terminal-actions` is `flex-shrink: 0` and the label block could not shrink (`min-width: auto`) | `min-width: 0` on the label block (`Desktop.css`) | **0 overflow** on Terminal |

## Attempted, measured, withdrawn

### The Desktop panel's grid

**Hypothesis:** `.desktop-control-layout` declared `minmax(180px, .8fr) minmax(240px, 1.2fr)` with `gap: 14px` — a **floor of 434 px** for a panel body of about 405 px. The grid could therefore not fit, and its six descendants reported `scrollWidth > clientWidth`.

**Fix applied:** floors lowered to `minmax(120px, .8fr) minmax(160px, 1.2fr)`.

**Measured result — mixed, so rejected:**

| Container | Before | After |
|---|---|---|
| `.desktop-control-layout` | +65 | **+41** ✅ |
| `.desktop-control-panel` | +49 | **+25** ✅ |
| `.work-panel-body` | +32 | **+8** ✅ |
| `.desktop-window-list` | +25 | **+40** ❌ |
| `.desktop-control-click` | +47 | **+53** ❌ |

**Fix withdrawn** (`git checkout -- src/App.css`). Improving three measurements while degrading two is not a fix, and I do not ship a change I cannot show is better.

> **Update of 21 September (pass 2).** This first attempt stays withdrawn, but **the defect has since been fixed by another route**, and this document's figures came from a faulty instrument. Two different sets of values, not to be confused: the **withdrawn** attempt was `minmax(120px, .8fr) minmax(160px, 1.2fr)`; the **shipped** state is `minmax(140px, .8fr) minmax(190px, 1.2fr)`. The shipped state is therefore:
>
> - `.desktop-control-layout`: `minmax(140px, .8fr) minmax(190px, 1.2fr)`, collapsing to a single column below `1400px` (click row) and `1290px` (grid);
> - `.files-layout`: `minmax(140px, .85fr) minmax(190px, 1.4fr)`, collapsing below `1230px`, in `Desktop.css` **next to** the base rule because of the import order;
> - **0 overflow** across the 7 tabs and across 13 window widths from 720 to 1440 px.
>
> The full story and the valid measurements are in [`debordement-desktop.md`](debordement-desktop.md). **Do not carry over any figure from the section below without re-checking it**: they came from a detector that counted deliberate truncation (`overflow: hidden`, ellipsis, `.sr-only`) as a defect.

### What the measurement ruled out

I then looked for the widest **leaf** in the panel, assuming a content element was imposing its intrinsic width on the whole chain:

```
panel width      : 437 px
widest leaf      : 405 px  (P.muted, "Actions are local, bounded…")
```

**The widest leaf fits in the panel.** No leaf exceeds its width. The overflow therefore comes from the **structure** (intrinsic widths of nested containers), not from a content element — which invalidates my hypothesis and explains why lowering the grid floors only moved the problem around.

That is the **sixth false diagnosis** of this campaign on the same pattern: a plausible cause accepted without checking it accounts for **all** the measurements.

## Still open, measured

State on **21 September, after pass 2** ([`revue-passe2.md`](revue-passe2.md)). Rows **6, 8, 9 and 10** are **fixed**, rows **7, 11 and 12** were **false positives**, and the others are requalified by measurement.

| # | Defect | State | Measurement / proof |
|---|---|---|---|
| 6 | **Desktop panel**: six containers overflowed in cascade | **FIXED** | 3 distinct causes (`minmax` floors, `min-width: auto`, click row); **0 overflow** across 13 widths |
| 7 | **Review**: `.work-panel-body` overflowed | **FALSE POSITIVE** | measured with an instrument counting deliberate truncation; 0 real overflow |
| 8 | **Files**: `.files-panel` overflowed | **FIXED** | floors 180/250 → 140/190 + `min-width: 0`, collapse below `1230px` |
| 9 | **Browser panel**: "Embedded preview" promised, **no preview surface** and no empty state | **FIXED** | `BrowserPanel` now explains the empty state ("No page loaded yet. Enter an http or https address above and press Go."); screenshot `pass2/pass2-browser-etat-vide.png` |
| 10 | **Duplicated user message**: two identical bubbles, same timestamp | **FIXED, cause confirmed** | real cause: `mergeHistoryLog` looked up the bubble by identifier **without checking the role**, so a remote user message overwrote the assistant placeholder's role. Fixed (role comparison) **and locked by a test**, written before the fix. The "remote deduplication" hypothesis had been **disproved** by the persisted data |
| 11 | The model label would be cut off with the panel unfolded | **FALSE POSITIVE** | measured in the right state; the generic "Model" label came from `model_id` **not passed on by Rust** — fixed and verified across 11 sessions |
| 12 | "Run in Muse" nearly white on white | **FALSE POSITIVE** | a **`disabled` + `opacity: .45`** button, which WCAG exempts; the active "Send" measures **4.82:1** |
| 13 | Two Desktop panel boxes with a ~2 px thick border | **REQUALIFIED** | unstyled native outlines `#545D62`/`#687075`/`#767676` against `#E6E9ED` elsewhere: **off the design system**, not "nearly black" |
| 14 | Bottom of the transcript cut mid-glyph | **NOT DEMONSTRATED** | the measurement shows no glyph cut at full height, only content reaching the edge |
| 15 | Inconsistent header hierarchy (upper-case kicker on Review/Desktop) | **OPEN** | confirmed: header height 100 px (Review) against 26 px (Memory) |
| 16 | **"Close panel" 16 px wide** | **FIXED** | `padding: 15px 1px` reduced the target to the glyph's width; `min-width: 24px` on `.icon` — 24×50 px, and the other buttons (28×30, 32×32) unchanged |
| 17 | **"Run in Muse" stays disabled** although the host grants `userShell` | **OPEN, unsettled** | bridge: `["userShell"]` · React prop read off the fiber: `false` · tooltip: "did not grant". Gap proved, chain not elucidated |

## What was verified as correct

- **Tab strip**: pixel-identical across the six panels, active underline always under the right tab, no offset or reordering.
- **Light theme**: fully applied, no area left dark.
- **Interactive targets**: none under 24×24 px apart from the attach-file input, deliberately hidden.
- **No horizontal scrolling** at the document level.
- **Files** and **Memory** panels: their empty states are explained.
- **Ellipsised paths**, badges and timestamps on the tool cards stay readable.
