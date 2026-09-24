# Finder jumping to a result outside the window — measured (M1-13, 20 September 2026)

Completes `M1-13.md` and replaces `finder-hors-fenetre-inabouti.md` (the failed attempt at round 20).

## The trap that made the first attempt fail

Two errors of mine, both fixed here:

1. **Selector for the container instead of the opener.** `Find in conversation` is the `aria-label` of the **container** `.stream-find` (`StreamView.tsx:812`), not of an action. My click was closing an already-open finder.
2. **Confusion over entry order.** `streamWindowStart` is an **offset from the end** (`initialStreamWindowStart`), so the window `0–160` corresponds to the **last 160** entries. A marker placed at index 137 was therefore **already visible**: the first test proved nothing about the "outside the window" case.

With 2,000 entries and a 120-entry load, an index **< 1400** is needed to be genuinely outside the window. The measurement kept uses index **900**.

## Protocol

```powershell
node scripts/cdp-finder-jump.mjs --entries 2000 --index 900
```

The script writes 2,000 entries with a unique marker at index 900, reloads, **opens the finder with the `Ctrl+F` shortcut** — whose binding is already proved in `docs/evidence/2026-09-20-windows-a11y/M0-12.md` — targets the field by its `aria-label="Search messages"` (`StreamView.tsx:825`), types the marker, then confirms.

## Result

| Step | DOM window | Articles mounted | `posinset` | Marker in the window |
|---|---|---|---|---|
| initial | 0 – 160 | 160 | 1 | **no** |
| after `Ctrl+F` | 0 – 160 | 160 | 1 | no |
| after typing the query | 0 – 160 | 160 | 1 | **yes** |
| after Enter | **888 – 1048** | **160** | **889** | yes |
| after clicking the result | 888 – 1048 | 160 | 889 | yes |

Search result returned: **1 option**, labelled `USER — FINDER-NEEDLE-900 unique marker placed outsid…`.

**Established:**

- the search **reaches an entry outside the DOM window**: the entry at index 900 is found although the window covered only the last 160;
- confirming **moves the window** to include the result: `888 – 1048`, `posinset` 889 — consistent with a result at index 900;
- the **DOM stays bounded at 160 articles** after the jump: the jump does not blow up the node count;
- the move is obtained with **Enter** on the field, with no need for the click.

**Limit observed:** the results table exposes **8 options**, **7 of them empty** — only the first carries a label. I did not determine whether that is an artefact of my DOM extraction or a real rendering; to check before drawing an accessibility conclusion.

## Restoration

The original log was rewritten and **verified**: 21,205 bytes, `hasSynthetic: false`, `hasNeedle: false`. No profile state is left modified.

## State of M1-13 after this measurement

| Criterion | State |
|---|---|
| DOM window bounded over 2,000 entries | **measured** (`M1-13.md`) |
| Incremental loading (scroll + button) | **measured** (`M1-13.md`) |
| Finder to a result outside the window | **measured** (this document) |
| Performance (memory, rendering time) | **not measured** |
| Native assistive qualification | **not exercised** |
| macOS / Linux | out of scope |

**M1-13 stays open** on performance and assistive qualification — the roadmap explicitly conditions full virtualisation on "a real measurement of memory and rendering time", which these documents do not replace. But its three interface measurement criteria are now covered.
