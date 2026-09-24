# The folder's rules, and the real reasoning levels (21 September 2026)

Two subjects, one cause: **the client was inventing a vocabulary the backend does not have.** It kept "project instructions" in `localStorage` while the CLI reads rules from the folder, and it offered seven reasoning levels while the MSP contract declares eight — one of them mislabelled.

## 1. Instructions belong to the harness, not the client

Decision: **we do not touch the user's `AGENTS.md` files.** That file belongs to them, and it is the CLI's job to write it (`muse init`, `/rules import`). Our project `instructions` field therefore disappears — not replaced by a file, simply removed — and what replaces it is a **reading** of what the harness actually loads.

### What the CLI documents, in its own strings

| Fact | Source |
|---|---|
| `muse init` writes `<folder>/AGENTS.md`, "read as project rules when it runs in this directory" | binary 1.3.0 |
| `CLAUDE.md` is probed **only** if `AGENTS.md` is absent | "directly probe the active workspace's `AGENTS.md`; only when it is absent, directly probe its `CLAUDE.md` fallback" |
| Personal rules: `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) | the `/rules import` message |
| Precedence order: user then project, **the deepest file wins** | "If project rules files conflict, the deeper file wins over the shallower one" |
| The host injects a `<rules-file scope="" path="" written-for="">` block itself | template string |
| The CLI has a `/rules` command — "Show which md files govern this session" | command table |

### What MSP does not expose

`muse schema generate-json-schema` (an offline export, exact for this binary): **46 methods, 28 notifications, and none of them is about rules.** The only field containing "rule" is `rulePreview`, on approvals. No definition mentions `AGENTS.md` or `rules-file`.

The client therefore cannot ask the host what it loaded. Reading the same files it reads is the only honest option — hence `rules_scan`, bounded and read only.

### The probe

`src-tauri/src/rules.rs` knows only four roles, never an arbitrary path:

| id | role | status |
|---|---|---|
| `user-claude` | `~/.claude/CLAUDE.md` | `fallback` (subject to the personal-context policy) |
| `user-codex` | `$CODEX_HOME/AGENTS.md` | `fallback` |
| `project-agents` | `<folder>/AGENTS.md` | `governs` if it exists |
| `project-claude` | `<folder>/CLAUDE.md` | `governs` if `AGENTS.md` is absent, otherwise `superseded` |

Three structural guarantees, each tested:

- **no writing** — a test writes an `AGENTS.md`, probes twice, and compares bytes **and** modification time; it also checks the fallback file is not created;
- **a closed vocabulary** — a test pins the four ids, the two scopes and the four statuses, because the renderer switches on them;
- **a cross-language contract** — a test serialises the payload and pins the exact field names (`observedAt`, `governing`, `truncated`…) that `src/lib/harnessRules.ts` reads. A lost camelCase rename would otherwise show up as an empty panel.

### Measured on the live bridge

`node scripts/ux-rules-scan.mjs --workspace G:\repos\openscreen` — the user's real folder, with its **23,417 bytes** of `AGENTS.md`:

```
project-agents   governs     present=true   bytes=  23417  G:\repos\openscreen\AGENTS.md
user-claude      fallback    present=true   bytes=   1320  C:\Users\etien\.claude\CLAUDE.md
user-codex       fallback    present=true   bytes=      0  C:\Users\etien\.codex\AGENTS.md
project-claude   absent      present=false  bytes=      0  G:\repos\openscreen\CLAUDE.md
```

The script checks from Node, not from the payload, that every row matches the disk, and that the files are **unchanged** (bytes + mtime) after the call. Verdict: `PASS`.

On `muse-desktop`, there is no `AGENTS.md`: the summary says "No rules file in this folder; 1 personal rule file applies as a fallback." — not a silence, not an invention.

### The rendering, verified in the application

`node scripts/ux-project-rules.mjs` opens Projects, unfolds `openscreen` and reads the rendered DOM:

- `textarea[aria-label^="Instructions for project"]`: **0** — the removed field has indeed disappeared;
- four rows, statuses `Fallback`/`Fallback`/`Loaded`/`Missing`, each with its explanation;
- summary: "AGENTS.md in this folder governs the session (22.9 KB).";
- **no verbatim path**;
- overflow measured from 1440 to 760 px: **0 px for the rules block**, at every width.

Two leaks remain in the panel at 820 px (`.workspace-root-row +32`, twice) and 760 px (`.project-actions +12`). They **predate** this change: measured to the byte with the rules block hidden then shown, they are identical. The script prints them as such instead of folding them into its verification.

### The trap found by measurement

The first version returned `\\?\C:\Users\…\AGENTS.md`. `canonicalize()` on Windows produces a verbatim path: it is the same file, but not what the user chose nor what the project stores — the panel would have shown a different path from the "Folders" field just above. Fixed with `display_path`, tested on all three forms (verbatim, UNC, POSIX).

Worth noting: `skills::scan` has the same defect, not fixed here so as not to mix two subjects.

## 2. Reasoning levels: seven out of eight, and one false description

The question asked earlier: "does this really match Muse Spark's reasoning levels?" The measured answer: **no.**

The contract (`$defs.ReasoningEffort` in the exported schema, and `muse --help` for `--reasoning-effort`) declares eight values:

```
none, minimal, low, medium, high, xhigh, max, ultra
```

Our list had **seven**: `max` was missing. And two validators rejected it on their side — `validate_reasoning_effort` in Rust, and a hand-copied list in the Projects panel. The visible symptom was therefore the client refusing a value the engine accepts.

Verified against a live host (`scripts/msp-reasoning-tiers.mjs`, eight levels): **all eight answer `accepted` and emit `session/reasoningEffortChanged` with the value sent**, `max` included. The script now reads the announced value rather than `session/read`, which does not project that field — it reported `kept: false` for everyone, which was a measurement artefact, not a downgrade.

The CLI actually carries **two** vocabularies: `WireReasoningEffort` (eight values, the contract's and `--reasoning-effort`'s) and `ReasoningEffortV1` (seven, the persistent settings', without `max`). `none` is on the wire but not among the persistent levels; `ultra` is described there as "the saved client selection". That explains the question asked: both lists exist, and we had copied neither.

The descriptions were also wrong on one precise point. The CLI writes:

> For Meta, the persistent effort tiers are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. `high` is the default Meta baseline; `xhigh` is the opt-in premium precision tier. `ultra` remains the saved client selection, **uses `max` reasoning on the Meta wire** (ADR 19425 D63), and currently enables proactive workflow/delegation guidance when that tool surface is available. It may proactively run multi-agent workflows and increase token usage quickly.

In other words `ultra` is **not** a ninth, deeper level: it is `max` **plus** autonomy (workflows, delegation), at a token cost. Our text said "Maximum reasoning depth; responses may take longer" — false, and the kind of false that makes people choose `ultra` believing they are choosing a depth. Fixed, and a test forbids that wording from coming back.

`none` is not a persistent level on the CLI side, but the contract declares it and the host accepts it: it stays on offer.

## Files

- `src-tauri/src/rules.rs` (new) + `rules_scan` in `main.rs`; `muse_auth::home_dir` shared.
- `src/lib/harnessRules.ts` (new) + `test/harnessRules.test.ts`.
- `src/lib/projects.ts`: `instructions` becomes optional and deprecated, `buildProjectInput` removed.
- `src/lib/reasoning.ts`, `validate_reasoning_effort`, the Projects panel's list: eight levels, a single source.
- `src/components/ProjectsPanel.tsx`: a read-only "Rules" block, a one-off notice about the old instructions.
- `scripts/ux-rules-scan.mjs`, `scripts/ux-project-rules.mjs` and `scripts/ux-legacy-instructions.mjs` (new), `scripts/msp-reasoning-tiers.mjs` (updated).

Tests: **220 Rust, 1102 Node, 0 failures.** Build green.

Migration: the two projects present on this machine had `instructions: ""` — verified in the running application's `localStorage`. Nothing is lost here; a non-empty value stays displayed with **Copy** and **Dismiss**, and is never sent again. That path is exercised for real by `node scripts/ux-legacy-instructions.mjs`: it injects a value, reloads, checks the notice appears, that it says "no longer sent", that there is **no editable field**, that **Dismiss** empties the storage, then restores the original string (the script leaves the application as it found it).

## What stays open

- `workspaces[]` (multi-folder) still has no backend equivalent — to remove.
- ~~"Start in" stays ambiguous next to the folder picker.~~ **Fixed**: the picker is called "Project", its default option "No project", and the folder only appears when it distinguishes. Details: [alignement-cli-projet-dossier](alignement-cli-projet-dossier.md).
- The worktree checkbox at start needs a variant of `git_worktree_create_session` with no parent session.
- `AuthMode::Account` is never produced by `decide()` — the mode is therefore always either `api_key` or `none`. To settle: remove the variant, or distinguish an account login from an API key.
