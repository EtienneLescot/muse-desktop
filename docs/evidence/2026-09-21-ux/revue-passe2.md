# UX/UI pass no. 2 — independent review, measurements and false positives (21 September 2026)

Two independent visual reviews of the 15 screenshots in [`pass1/`](pass1/), then an instrumented verification of each finding. This document replaces the unmeasured findings of [`constats-passe1.md`](constats-passe1.md) with measurements, and **rules out four false positives** — two of which I had relayed myself.

## What the review established

Both reviews worked on pixels, not impressions, and explicitly marked **OBSERVED** or **ASSUMED**. They produced measurements I did not have: panel geometry, ink bands, computed contrast, image diffs.

**They also corrected two of my claims:**

| My (unmeasured) finding | Measured reality |
|---|---|
| "The screenshots are in the dark theme" | **Light theme**: sidebar `#F5F6F8`, conversation `#FFFFFF`, panel `#F8F9FB` |
| "Run in Muse nearly white on white, on **Desktop**" | The unreadable pair is on **Terminal**; on Desktop the palest are at 2.3-3.15:1 |

## Confirmed defects

### 1. Duplicated user message — cause located

**Measured:** two identical "You" bubbles, an exact vertical offset of **127 px**, mean absolute difference **0.05/765** (screenshot 01) and **0.38/765** (screenshot 07), the `09:21:45` timestamp **included**. Areas identical pixel for pixel.

**I checked the source in the data:** session `01a0c2d7`'s `session.jsonl` contains **four occurrences of the text**, but they are **four distinct events of a single turn**:

| Line | `record_type` / `payload_type` | Nature |
|---|---|---|
| 19 | `runtime.command_intake.received` | the command arrives |
| 24 | `runtime.user_intent.accepted` | the intent is accepted |
| 25 | `runtime.session` | the turn starts |
| 60 | `runtime.session` | `assistant_message_committed` answer |

**A single user message in the data.** The duplicate is therefore a **double projection on the client side**, not a double send.

**Probable cause, located:** `mergeHistoryLog` (`src/lib/history.ts:319-343`) deduplicates remote entries against **local** entries through the `used` set, but **never remote entries against each other**. Two records of the same message with different item identifiers therefore both get through. That hypothesis needs verifying before a fix, since deduplicating on text alone would hide two deliberately identical messages.

### 2. Screenshot hygiene — blocking for the next pass

| Screenshot | Problem measured |
|---|---|
| `05-bibliotheque`, `06-profil` | **Search modal still open** (`x451-989`, `y323-577`) + background blur: contents unreadable |
| `15-theme-clair` | light theme **under a dark scrim** (background measured `#87919B` instead of `#F5F6F8`) + an options modal |
| `07`, `08` | already in the light theme, so `15` is a duplicate |

**Consequence:** there is **no readable screenshot** of Library, Settings and the work panel. The reviews had to reason on the right-hand side alone. To redo with `ux-capture.mjs`, which already asserts its preconditions — but apparently refuses overlay closings.

### 3. The Browser tab: a promise not kept

**Confirmed by structure measurement:** the header announces "Embedded preview", but the body goes tab chip → URL field → buttons → "Page controls" → comments → permissions. The largest vertical blank is **~36 px**: **no preview surface, no empty-state message**.

The other tabs have an explicit empty state (Files, Memory, Terminal). Browser is the only one without.

### 4. Panel bottom with no margin

**Measured:** Desktop, last ink line `y=865`, band `y867-870`, border `872` — and the scrollbar proves the content continues. Browser, ink down to `y=871` = the viewport's last line.

### 5. Unstyled native control outlines

**Measured:** `#767676` (field, select, Memory's Save button), `#687075` (the Browser's "New tab" chip, the Desktop's window card), `#545D62` (the "Available" card, ~2 px). Compare with the `#E6E9ED` hairlines of the rest of the design system: **2.5 to 4× darker**. These are not the "nearly black borders" I had described, but they are indeed off the design system.

## False positives ruled out — and they were serious

### A. "Send" and "Run in Muse" at 1.97:1 — no

Both buttons were **`disabled` with `opacity: 0.45`**. WCAG **explicitly exempts** disabled controls from the contrast criterion. Measured after typing a command:

| Button | Active state | Verdict |
|---|---|---|
| **Send** | **4.82:1** | AA compliant |
| "Run in Muse" | disabled | exempt, but see the open question below |

Both reviews announced a major defect; in the state they measured, there is none.

**My own instrument had a bug too**: it read the **parent's** background and ignored the element's own, reporting "blue on white" for a blue button on a light-blue background. Fixed: the element's own background is now composited with its ancestors, then the `opacity` is applied.

### B. Secondary text contrast at 3.63:1 — no

One review announced `--muted` at `#78828A` / 3.63:1 across the six tabs. **That value no longer exists**: `App.css:17` has carried `--muted: #6a7279` since pass 1, and `#78828a` survives only in a comment. Measured in the DOM: the Terminal's "Close" at **4.89:1**. The token is compliant.

### C. "No viewport / glyphs cut at full height" — not demonstrated

The review itself classified it **ASSUMED**; the measurement shows no glyph cut at full height, only content reaching the edge.

## Open question, unsettled

### "Run in Muse" stays disabled although the host grants `userShell`

**It is a real disagreement, measured at four levels:**

| Level | Result |
|---|---|
| `restore_sessions` (Rust bridge) | `granted_capabilities: ["userShell"]` for the active session `01a0bb03` |
| React prop `canRunThroughMuse` (read off the fiber) | **`false`** |
| The button's `disabled` | **`true`** |
| `title` | "This Muse host did not grant the userShell capability" |

**Ruled out by measurement:**
- it is not the typing: **real** typing (CDP keyboard events) does update `command` — "Send" enables and disables correctly;
- it is not the per-workspace cache: `restore_sessions` walks the live hosts and reads `host_capabilities` at the exact key where `initialize` wrote it;
- calling `restore_sessions` again does not change the renderer's state, so that call is not what feeds `grantedCapabilitiesBySession` in this state.

**Unsettled:** the call that actually feeds the renderer's state in this scenario, and whether the message displayed ("did not grant") is accurate or misleading. I am not fixing it before I know: changing the chain on a hypothesis would be this campaign's ninth false diagnosis.

## Fix applied and verified

### `model_id` was not passed to the renderer

`session_meta_from_list_row` read `session_durability`, `approval_mode` and `granted_capabilities` but **ignored `modelId`**, although `session/list` publishes it. The composer therefore showed "Model".

Fixed on the Rust side (`SessionMeta::model_id`, a `session_model_id` helper accepting `session/list`'s flat form and `setModel`'s nested form) **and** on the renderer side (`restore_sessions` did not carry `model_id` into the merge).

**Verified at three levels:** `restore_sessions` returns `"model_id": "muse-spark-1.3-contributor"` for all **11 sessions**; and the pass 2 screenshot shows the real model in the composer instead of "Model".

### Duplicated user message — cause found and fixed

The sub-agent read the **logs persisted in the application's `localStorage`** and found two `role: "user"` entries there for a single send:

| # | `itemId` | `clientMessageId` | `ts` |
|---|---|---|---|
| 1 | **`null`** | client identifier | 1789975305622 |
| 2 | **`e948ccf8…`** (the host's item id) | the host's command identifier | 1789975305697 |

75 ms apart, hence **the same displayed second** — which explains the identical timestamp. Reproduced in a second session (160 ms apart).

**The mechanism, in three steps:**

1. On send, the client creates an optimistic user bubble **and** an empty assistant placeholder.
2. The real-time reducer binds the `itemId` of the host's **user** item to that placeholder, because the incremental item lane has no "user" role.
3. `mergeHistoryLog` looks up by `itemId` **with no role check** (`src/lib/history.ts:323-325`), so the remote user item **overwrites the role** of the placeholder (`:332`, the spread order) instead of being recognised as a message already represented. The optimistic bubble stays behind as an unconsumed leftover.

**My initial hypothesis was wrong**: I blamed a lack of deduplication between remote entries. The sub-agent **disproved it with the data** — an unmatched remote entry keeps an identifier prefixed `history:`, and no identifier of that kind exists in the persisted logs.

**Fixed**: matching by `itemId` now requires the **same role**. Two tests added, written **before** the fix:

- `does not turn an assistant placeholder into a second user bubble` — **failed** before, passes after;
- `still binds a remote item to a local entry of the same role` — keeps the legitimate behaviour.

`npm test`: **1074 tests, 0 failures** (against 1072).

### The redundant "Local" — composer chip removed

Product decision: the composer's chip is removed, the header pill and "Local execution" in the status bar stay. **Verified in the DOM**: a single occurrence of "Local" on its own remains (the header pill).

### The Browser tab — empty state added

**A correction to my own diagnosis:** a preview surface *does* exist — a same-origin `iframe` (`BrowserPanel.tsx:884`) — but it is only rendered once a displayable URL exists, and **nothing was displayed in the meantime**. It was the only one of the 7 tabs with no empty state.

Added: a dashed frame "No page loaded yet. Enter an http or https address above and press Go.", the iframe's height to avoid any shift when the preview appears. The "Embedded preview" subtitle becomes "**Same-origin preview**", which describes what really exists.

**Verified** in the DOM and by screenshot: empty state present and visible, subtitle exact.

### The "Close panel" touch target

**16 px wide**, below the 24 px minimum: `padding: 15px 1px` reduced the button to the glyph's width. `min-width: 24px` on `.icon` → **24×50 px**, without touching the other buttons (28×30, 32×32). The audit now reports only 2 gaps, both legitimate and documented.

## Instruments added

| Script | Role |
|---|---|
| `ux-terminal-contrast.mjs` | the real WCAG contrast of the controls, active and disabled, preconditions asserted |
| `ux-session-meta-probe.mjs` | reads the Rust bridge's raw projection (the authority over what is rendered) |
| `ux-react-state-probe.mjs` | reads a React prop off the fiber, when the DOM and the bridge contradict each other |
| `ux-contrast-audit.mjs` | a measurement targeted by selector, own background composited |
| `ux-verify-pass2.mjs` | checks the pass 2 decisions in the DOM and by screenshot |

**The visibility predicate, fixed everywhere.** `ux-capture.mjs`, `ux-capture-conversation.mjs`, `ux-force-conversation.mjs` and `ux-target-size-audit.mjs` used `offsetParent !== null`, which is `null` for `<body>` and for every `position: fixed` element: a whole positioning mode escaped the audit. The predicate is now `getClientRects()` + `display`/`visibility`, with preconditions asserted. Flagged by CodeRabbit on `ux-target-size-audit.mjs`; the audit now sees 43 controls instead of 46 depending on the state, and correctly reports 0 elements outside the viewport.

The same predicate survives in the **older** `cdp-*` tooling and in `beta-smoke.mjs`: outside the scope of this report, not modified so as not to risk a regression in scripts backing evidence already published.

## The lesson

**Two independent reviews, on the same screenshots, produced two major false positives and corrected two of my claims.** The cause is the same on both sides: **measuring a state without checking which one**. The buttons measured were disabled; the token measured was no longer in the stylesheet.

And **my hypothesis about the duplicate was wrong too**, for a different reason: I had read the code and concluded a lack of deduplication between remote entries, without going to look at the **data actually persisted**. A single `localStorage.getItem` settled it — no identifier prefixed `history:` exists, so the path I was blaming had never been used. The cause was elsewhere, in an `itemId` match with no role check.

It is the same error this campaign has already paid for eight times, in a new form: **reasoning about the code instead of measuring the state**. The remedy does not change — instrument, assert, and prefer the data to the deduction. When two sources contradict each other, instrument a third (here: the persisted log, then the React fiber) rather than picking the convenient one.
