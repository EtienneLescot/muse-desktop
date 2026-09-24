# Finder jumping to a result outside the window — inconclusive test (M1-13, 20 September 2026)

An attempt to cover M1-13's last measurement criterion: **the finder jumping to a result outside the DOM window**.

**The test did not succeed, and the failure comes from my script, not the application.** I record it so the criterion is not assumed covered.

## Intended protocol

1. write 2,000 entries with a unique marker at index **137** — well above the initial window;
2. reload, scroll to the top to trigger a load, and check the window is far from 137;
3. open `Find in conversation`, type `FINDER-NEEDLE-137`, select the result, confirm;
4. check that the window **moved to include index 137**.

## What happened

| Step | DOM window | Articles | `posinset` | Finder open |
|---|---|---|---|---|
| initial | 1720 – 1880 | 160 | 1721 | yes |
| after scrolling to the top | 1600 – 1760 | 160 | 1601 | **no** |
| query sent | 1600 – 1760 | 160 | 1601 | **no** |
| selection | 1600 – 1760 | 160 | 1601 | no |
| confirmation | 1600 – 1760 | 160 | 1601 | no |

The window **never moved** after step 2, and the finder was found **closed** before the typing even began.

## Cause identified

My selector looked for a button whose text contains "Find in conversation". But that text belongs to the **finder's container** (`.stream-find`, `aria-label="Find in conversation"`), not to an opening button. The click therefore **closed** an already-open finder instead of opening it, and the field lookup that followed failed — no field being mounted. The query was never typed, and no selection could be clicked.

**Method lesson:** targeting a label by substring without checking the element's **tag** is fragile. The container carried the same text as the action sought.

## What the test establishes anyway

Nothing about the finder. On the other hand, two **valid** measurements were obtained along the way, and they corroborate #166/#167:

- initial window **1720 – 1880** with **160 articles** mounted;
- after scrolling to the top, window **1600 – 1760**: a step back of **120 entries**, DOM stable.

## Restoration

The original log was rewritten and **verified**: 21,205 bytes, 25 entries, no `long-` entry and no `FINDER-NEEDLE` marker. No profile state is left modified.

## What it would take to pick this up

Target the finder's real opening point — the `Ctrl+F` shortcut is already **proved wired** (measured in `docs/evidence/2026-09-20-windows-a11y/M0-12.md`), so opening it by keyboard rather than by click is the safest route. Then locate the field by `aria-label="Search messages"` rather than by substring on a container.

**M1-13 stays open** on this point: the finder outside the window is **not** qualified.
