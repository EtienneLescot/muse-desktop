# The composer was clipping its own model picker (21 September 2026)

Reported with a screenshot: in the composer, the model pill runs out of the frame and its label is cut mid-glyph, while the other four controls fit on the row.

## The cause: a fix that stopped applying

The defect had **already** been fixed once. Pass 1 had diagnosed it as "the model label wrapped onto two lines" and fixed it with:

```css
.composer-model > button {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
}
```

Then the "model" button was **replaced** with a `<details>` + `<summary>` picker (UX-212, the same day) so the click opens a list instead of the Settings panel. The CSS selector no longer matched anything: no more cap, no more ellipsis. The dead rule stayed in the stylesheet, and reading it alone was enough to believe the subject was dealt with.

And the label became long again at the same moment, for another reason: `model_id` is now passed on by Rust, so the pill shows `muse-spark-1.3-contributor` instead of the generic word "Model" that was hiding the problem.

## What the measurement established

`node scripts/ux-composer-overflow.mjs`, before the fix (1296 px window, the real width of the test window):

| Measurement | Value |
|---|---|
| Composer inner width | 538 px |
| `.composer-actions` scroll width | **579 px** |
| Model pill: content / box granted | **199 px / 154 px** |
| Label at 1100 px | **0 px** — the pill becomes empty |
| Failing widths | **10 out of 11**, from +43 px to +305 px |

The composer is **not monotonic** with the window: 416 px wide at a 1024 px window, 610 px at 900 px (the work panel takes its share). A media query on the window width would therefore have triggered in the wrong place — the measurement ruled it out before the writing, not after.

## The fix

1. **The row can wrap to a second line** — `.composer-context { flex-wrap: wrap; row-gap: 6px }`. The four fixed pills cannot shrink (`white-space: nowrap`), so a row that cannot break has only two outcomes, both wrong: crush the model pill until it is empty, or let it run out of the frame.
2. **The pill no longer sticks to the right** — `margin-left: auto` removed from `.composer-model`. On a full row it had no effect; on a broken row it sent the pill alone to the right, which read as an element that had fallen out of the group.
3. **The ellipsis stays, as a last resort** — the label keeps `overflow: hidden` + `text-overflow: ellipsis` with `min-width: 0`, for an identifier longer than a whole line.

Verified: `11 widths tested, no clipping`. The label tested — `muse-spark-1.3-contributor`, 25 characters — stays **whole** (171/171) at every width: it is the wrapping that protects it, not the truncation. The ellipsis remains the accepted fallback for a label longer than the line, which the host's catalogue can supply (`displayLabel` comes from the host): the guard rail **reports** it without counting it as a failure, since it is intended.

| | Before (`pass3/composer-avant.png`) | After (`pass3/composer-apres.png`) |
|---|---|---|
| 1296 px | pill cut by the card's right edge | row broken, pill whole, aligned under Attach |
| 1366 px | +43 px overflow | 0 |
| 640 px | +305 px | 0 |

## The guard rail, and its proof

`scripts/ux-composer-overflow.mjs` sweeps 11 widths and checks three things: the row does not scroll, the context does not scroll, no descendant paints outside the composer's padding box, and the model pill does not crush below 90 px. The precondition is asserted — with no open conversation there is no composer, and measuring zero would have proved nothing.

Truncation of the label, for its part, is **reported and not counted as a failure**: the ellipsis is the intended fallback when a host `displayLabel` overflows the line.

**The guard rail can fail**: with the fix removed (`git stash push -- src/App.css`), it reports **10 widths out of 11** failing with the values above. Put back, it reports 0.

A probe trap along the way, of the same kind as the earlier ones: the content of a closed `<details>` **keeps a rectangle**. Chrome hides it through `content-visibility`, so `display`, `visibility` and `getClientRects()` all say "rendered". The model popover, 300 px wide, was counted as overflowing by more than 200 px **at every width** — a plausible and entirely false report. The predicate now excludes `details:not([open])`.

## Picking it up again: the guard rail failed wrongly, and did not exercise the case

A second report of the same symptom, screenshot included: the pill cut by the card's right edge. The fix above was nevertheless in place and `flex-wrap: wrap` active. The measurement established something else — and first **against the guard rail itself**.

### It failed on its own threshold

On the first pass, the host's catalogue had not answered yet: the pill showed the fallback label **"Model"** (`title="The host catalog is unavailable"`), that is **65 px**. But the guard rail refused any pill under **90 px**: `11 widths out of 11` failing, **on a healthy composer**. A threshold that encodes a label's length proves nothing about a layout — it only measured whether `model/list` had answered.

The rule is now exact and constant-free: **a truncated label is only legitimate if the pill is alone on its row.** Flexbox only shrinks an element once its row is full; on a shared row, truncation therefore means the pill was crushed while it still had a line to itself. The report now states the row (`alone` / `shared`), and the width **1280 px** — the real width of the test window — was missing from the list swept.

### It did not exercise the configuration that failed

The composer does not follow the window's width: capped at **728 px** with the work panel closed, it drops to **528–624 px** with the panel open, and that is where the row breaks. Panel closed, the five pills fit (563 px in 728): the check only measured the easy case, and would have passed **with the fix removed**. Panel open, it measures what matters:

| Width | Composer | Row | Context | The pill's row | Label |
|---|---|---|---|---|---|
| 1440 px | 624 px | 0 | 0 | shared | 171/171 |
| 1280 px | **528 px** | 0 | 0 | alone | 171/171 |
| 1024 px | 384 px | 0 | 0 | alone | 171/171 |
| 640 px | 318 px | 0 | 0 | alone | 171/171 |

No overflow, label whole everywhere: it is the **wrapping** that protects it, not the truncation. Visual proof (`composer-1280.png`, `composer-1024.png`, the composer region, panel open): the pill is whole on its own line.

### It can still fail, and without touching a file

The previous check removed the fix through `git stash`. With two sessions working in the same repository, file editing was replaced by **an injection into the page**: the removed declaration is reapplied (`.composer-context { flex-wrap: nowrap !important }`), and the script reports **11 widths out of 12** failing — including `label truncated on a shared row` on 11 of them, plus row and context overflows at the tight widths. Mutation removed, `12 widths tested, no clipping`.

## What was not done

- The catalogue offers **no shorter label**: `model/list` returns the identifier as its own `displayLabel` for all four models. Shortening the pill is therefore a product decision (what form?), not a display fix — truncation and wrapping are the only two honest options in the meantime.
- The two other long pills (`Attach`, `Voice`) are not concerned: they are short by construction.
