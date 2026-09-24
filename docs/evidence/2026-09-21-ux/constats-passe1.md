# UX/UI pass no. 1 — measured findings (21 September 2026)

The first pass before the 0.1.0 beta. Method: **capture** each surface, then **measure** what can be measured, and leave to visual judgement only what cannot.

All screenshots are in [`pass1/`](pass1/) — 15 images. The probes can be replayed:

```powershell
node scripts/ux-capture.mjs --out <dir> --port 9227          # 13 surfaces
node scripts/ux-force-conversation.mjs --out <dir> --port 9227 # conversation + tabs
node scripts/ux-contrast-audit.mjs --port 9227 [--theme light]
node scripts/ux-target-size-audit.mjs --port 9227
```

## Defects found, fixed and verified

### 1. The model label wrapped onto two lines

**Measurement:** `Range.getClientRects()` returned **2 lines** for `muse-spark-1.3-contributor` in a 168×48 px button, although there was room left on one line.

**Cause:** a bare `<button>` inside `.composer-model` (`display: inline-flex; min-width: 0`) — nothing stopped the text from wrapping.

**Fix:** `white-space: nowrap` + `text-overflow: ellipsis` at 22ch on the button.

**Verification:** after reloading, `white-space: nowrap`, **1 line**, button 64×32 px.

### 2. The light theme violated WCAG AA on all secondary text

**Measurement:** 23 texts below the threshold, all carried by the same variable.

| Context | Background | Ratio | Required |
|---|---|---|---|
| Sidebar, section labels, status bar | `#f5f6f8` | **3.62** | 4.5 |
| Transcript metadata, search field | `#ffffff` | **3.92** | 4.5 |

**Cause:** `--muted: #78828a` in the light palette (`App.css`). The dark theme uses another value (`#92a2ad`) and **already passed**.

**Fix:** `--muted: #6a7279` — a **computed** value, not picked by eye: the smallest correction that passes on both backgrounds (4.52 and 4.89), while staying clearly quieter than `--text` (`#182329`, ≈14:1).

**Verification:** **0 texts below the threshold**, in both themes.

## What was measured and is fine

| Check | Result |
|---|---|
| Contrast, **dark** theme | **0 failures** |
| Contrast, **light** theme after the fix | **0 failures** |
| Horizontal scrolling | **none** (document 1440 px = viewport) |
| Elements outside the viewport | **none** |
| Interactive targets under 24×24 px | **2**, both legitimate: a `+` at 20.3×28 px (a tiny margin) and the attach-file **hidden 1×1** `input`, triggered by the "Attach" button |

## A false positive ruled out, and it has to be said

My first audit announced **20 serious anomalies in the dark theme**, including menu options at **1.16:1** (light text on a white background) — I believed in a major display bug.

**It was false.** The point tested did not contain the option: `elementsFromPoint` returned the transcript. The popovers were **closed**, and the audit counted their content, which the browser does not paint. The white came from Chrome's default button background, never displayed.

**Fix applied to the tool**: the audit now excludes `details:not([open])` and `content-visibility: hidden`. The 20 failures disappeared.

Without that check, I would have "fixed" a non-existent bug.

## Visual findings, not measured — to confirm

These points come from examining the screenshots. I have **not** instrumented them, so I give them as observations.

| # | Observation | Screenshot | Presumed severity |
|---|---|---|---|
| 3 | **The composer is very tall**: the "Ask Muse to continue…" placeholder occupies a large empty area and the control row is vertically centred, for ~160 px in total | `08-panneau-deplie` | MAJOR |
| 4 | **"Local" appears three times**: header pill (`App.tsx:851`), composer pill (`:1430`), "Local execution" in the status bar (`:1802`). The two bare pills are redundant with each other | `07`, `08` | MAJOR |
| 5 | **The model shows as "Model"** when `model_id` is absent from the session, instead of the real name | measured in the DOM | MAJOR |
| 6 | **Cramped sub-agent event row**: `▸ Agent b44a4ae3-6c20-… Reminder child se… \| Completed \| 09:21:48` — a truncated identifier and text fight over the same line | `08` | MINOR |
| 7 | **"Find in conversation" bar mounted permanently** above the messages, although a `Ctrl/Cmd F` shortcut exists | `08` | MINOR |
| 8 | **Title truncated twice**: `Reply with exactly the word: BETA-17899752…` in the breadcrumb **and** in the `h1` | `08` | MINOR |

Points 3 to 8 are under an independent visual review in progress; I do not fix them before it confirms or refutes them — that is the rule this campaign set itself after ten mistaken findings of absence.
