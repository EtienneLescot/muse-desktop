# English product copy — rendering audit (M0-11, 20 September 2026)

M0-11 asks to "finish the English". The repository had a test (`test/ui-copy.test.ts`) checking a **blacklist of nine French phrases** in **five files**. This audit goes further: it measures the **entire source** and the **rendered interface**.

## 1. Entire source — searching for accents

```powershell
Get-ChildItem src -Recurse -Include *.tsx,*.ts |
  Select-String -Pattern "[éèêëàâäôöûüç]"
```

| Measurement | Result |
|---|---|
| Files scanned | **129** |
| Lines containing an accent | **2** |

Both occurrences are in **multilingual detection patterns**, not in product copy:

- `src/lib/artifacts.ts:109` → `/décision|decision|decided|décidé|approved|approuv|conclu|retenu|choisi|choice|outcome/i`
- `src/lib/compact.ts:179` → the same pattern

These are regular expressions that have to **recognise** French words in the model's output. Translating them would be a defect, not a fix.

## 2. Rendered interface — auditing the real DOM

An accent is not required to write French: "Ajouter", "Aucun", "Fermer" have none. French copy therefore has to be looked for in the **DOM**, not only in the source.

```powershell
node scripts/cdp-language-audit.mjs
```

The script walks the visible text nodes and flags any string containing a **French interface verb** or a **French grammatical word**, then visits seven surfaces.

### Result: no French copy

First pass, with **case-sensitive** detection (see the correction below):

| Surface | Candidates (pass 1) | Candidates (pass 2, case insensitive) |
|---|---|---|
| home | 2 | **5** |
| new-conversation | 2 | **5** |
| automations | 2 | **4** |
| extensions | 3 | **5** |
| library | 2 | **5** |
| search | 2 | **5** |
| conversation | 2 | **5** |
| **Total** | **7** | **34** |

**None of the 34 strings is French.** They are all false positives, in three families:

| String flagged | Trigger | Verdict |
|---|---|---|
| `Extensions` | truncated marker `Exten` | **English** — the word is identical in both languages |
| `Conversations (…)` | marker `Conversations` | **English** — identical in both languages |
| `Archived conversations` | marker `Conversations` | **English** |
| `Search conversations` | marker `Conversations` | **English** |
| `No imported conversations yet.` | marker `Conversations` | **English** |
| `Fast responses with no extended reasoning` | marker `Exten` | **English** — `Exten` matches "Ex**ten**sions" and "ex**ten**ded" |
| `Curated catalog plus an explicit local MCP probe.` | grammatical word `plus` | **English** — an entirely English sentence |

### A correction made after review

An automated review found two real defects in my first pass:

1. **Marker detection was case sensitive** (`raw.includes(m)`). French copy in lower case — "ajouter", "fermer" — would have gone unnoticed if the marker was capitalised. Fixed by comparing in lower case, then the **audit was re-run**: 7 → 34 candidates, which doubles the pass's sensitivity.
2. **A logging defect**: if the target conversation did not open, the surface was still recorded under the name `conversation`, suggesting a valid measurement. Fixed: the failure is now named `conversation-NOT-OPENED`.

**The conclusion did not change after the fix**, but it now rests on stricter detection and on a measurement whose failure would be visible.

## Conclusion

**Established:** the visible product copy is **in English** across the surfaces audited, and the source contains no accented string outside detection patterns. M0-11's "finish the English" criterion is **measured within this scope**.

## Limits — what this audit does not cover

- **Seven surfaces only.** Panels opened on demand — settings, projects, Git review, terminal, browser, desktop, memory, installed extensions, configured automations — **were not visited**. Each could contain undetected French copy.
- **Dynamically built strings** (concatenation, templates with variables) can escape a text-node sweep if the French fragment is short and carries no marker.
- **Error messages, tooltips, `aria-label`s and tab titles** are not all in visible text nodes; `aria-label` in particular does not appear in `innerText`.
- My heuristic produced **34 false positives out of 34 detections** — that is, no specificity. Truncated markers (`Exten`) and words common to both languages (`Conversations`, `plus`) make it very noisy. In other words: the pass is **sensitive** but its result only holds because I **examined every string one by one**. A future audit must replace those markers with words genuinely exclusive to French, otherwise it will prove nothing.
- **M0-11 has a second half** — "navigation details": `Ctrl`/`Cmd` tooltips, centralised error copy, readable native path. That half is not covered here.

**M0-11 is therefore not closed.** Its language half is measured across seven surfaces, with the limits above; the navigation half is still to be covered.
