# Reasoning effort: the picker aligned with the Muse Spark levels

Campaign date: 27/09/2026 · Platform: Windows 10 · CLI binary measured: `muse-bin-1.3.0-R3401.1` (`C:\Users\etien\Programs\…\muse.cmd`)

## The question asked

"We were supposed to have aligned this with the Muse CLI's real values and I
have the feeling the choices are not consistent (today we have 8 choices and
that seems a lot compared with what Muse Spark offers)."

## Measurements (sources of truth, no interpretation)

**1. `muse --help`** — the CLI's flag:

```
--reasoning-effort <EFFORT>
    Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
    (default: high)
```

**2. `muse schema generate-json-schema --out <dir>`** — an **offline and exact**
export from the binary; `$defs.ReasoningEffort`:

```
enum: none, minimal, low, medium, high, xhigh, max, ultra   (x-msp-openness: closed)
```

with the contract's description: *"The **same closed tier vocabulary** on both
the fresh-turn and steer lanes… `none` is a tier of the vocabulary (ask for no
reasoning), not a way to say "unset"."* — the same type serves
`turn/start.reasoningEffort`, `session/setReasoningEffort` and
`session/reasoningEffortChanged`.

**3. The CLI's persistent levels** (the product's guidance, already recorded on 21/09
in [regles-du-dossier.md](../2026-09-21-ux/regles-du-dossier.md)):

> For Meta, the persistent effort tiers are `minimal`, `low`, `medium`, `high`,
> `xhigh`, `max`, and `ultra`. `high` is the default Meta baseline; `xhigh` is
> the opt-in premium precision tier. `ultra` remains the saved client selection,
> uses `max` reasoning on the Meta wire, and currently enables proactive
> workflow/delegation guidance…

So **two real vocabularies**: 8 values on the wire, **7 persistent Muse Spark
levels** (without `none`). And `ultra` is not a notch of depth above
`max`, it is `max` **plus** autonomy.

## Decision (the user's choice)

The picker exposes **the seven Muse Spark levels**: `minimal, low, medium,
high, xhigh, max, ultra`.

- `none` **leaves the picker**: the CLI never persists it as a level, it
  stays a wire value ("ask for no reasoning").
- The labels use the **CLI's spelling** (`xhigh`, not "Very high")
  so the list reads like the product it drives.
- `ultra` stays **distinguished**: "Max depth plus proactive workflow and
  delegation guidance; can raise token usage quickly".

## Compatibility, by design

- `reasoningEffortChoices(current)`: a value **already persisted** that is
  no longer offered (today `none`) stays displayed at the top of the list.
  Removing it silently would rewrite the user's level on the next save — the
  "keeps a legacy `none` selection visible" test locks that behaviour down.
- The **wire vocabulary stays complete**: `REASONING_EFFORTS` (8) serves to parse
  and validate everything coming from the host, and `validate_reasoning_effort` on
  the Rust side still accepts all 8 (that is what the contract declares; it is also
  how `max` was lost in its day, by narrowing our list).

## Files

- `src/lib/reasoning.ts`: `REASONING_EFFORT_CHOICES` (7 levels),
  `reasoningEffortChoices(current)`, the `xhigh` label, doc of the two vocabularies.
- `src/components/ReasoningEffortControl.tsx`, `SettingsPanel.tsx`,
  `ProjectsPanel.tsx`: iterate over `reasoningEffortChoices(...)` instead of the
  wire list.
- `test/reasoning.test.ts`: +3 tests (the list of 7, legacy `none` kept,
  CLI labels).
- `src-tauri/src/main.rs`: **unchanged** — the validator keeps all 8 values.

## Evidence (replayable)

| Step | Command | Result |
| --- | --- | --- |
| Wire vocabulary | `muse --help` | `none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra` (default `high`) |
| Contract | `muse schema generate-json-schema --out <dir>` then reading `$defs.ReasoningEffort` | closed enum of 8, `none` = "a tier of the vocabulary… not a way to say unset" |
| Persistent levels | CLI guidance (`For Meta, the persistent effort tiers are…`) | 7: `minimal, low, medium, high, xhigh, max, ultra` |
| Tests | `npm test` | 0 failures, including the 3 new ones (7 choices, legacy `none` shown but not offered, CLI labels) |
| Typing | `npx tsc --noEmit` | clean |
| Native app | `npm run build` + `cargo build` + relaunch, then `scripts/cdp-drive.mjs eval` on the `Reasoning effort` popover | **7 options, no "None"**; label `Xhigh` |
