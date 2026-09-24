# Why the composer shows "Model" — diagnosis (21 September 2026)

UX pass no. 1. The composer shows the generic word **"Model"** instead of the name of the model in use. This document establishes the complete chain, from the visible effect to the cause.

## The effect, measured

| Panel state | Composer width | Button text | Lines | Button |
|---|---|---|---|---|
| open | 656 px | **`Model`** | **1** | 64×32 |
| closed | 760 px | **`Model`** | **1** | 64×32 |

**Two things follow:**

1. **The wrapping fix holds**: `white-space: nowrap`, a single line, in both states. The visual review judged a screenshot taken **before** the fix, and I understand why — the short label makes "truncated" indistinguishable from "name absent". **The review was wrong on that point, and my initial check was right, but for a reason I had not identified.**

2. **The real defect is the generic fallback.** The user does not know which model they are using.

## The chain, from the visible to the cause

`App.tsx`, the composer's control:

```tsx
{liveModels?.find((model) => model.isActive)?.displayLabel   // 1st choice
  || active.model_id                                          // 2nd choice
  || "Model"}                                                 // fallback
```

Three possible causes for falling back to `"Model"`: `liveModels` empty, or `model_id` absent, or both. **Measured: both.** `0 / 3` stored sessions carry a `model_id`, and `liveModels` provides no active entry.

**Why `model_id` is absent** — searching the code:

| Location | Writes `model_id`? |
|---|---|
| `useMuseSessions.ts:4059` | yes, in `setSessionModel` — **only when the user explicitly changes model** |
| `:4282`, `:4659` | yes, at creation, if a model was requested |
| `:4732`, `:4751` | yes, by inheritance on a fork |
| **Restoring an existing session** | **no** |

**Nothing fills `model_id` when a session is restored.** A session created before the field was introduced, or restored with no model change, therefore never has one.

## The structural cause

`session/list` **exposes `modelId` for every session** — I measured it: `modelId`, `providerId`, `turnCount`, `title`, `status`, `branch`, `workspaceRoot`…

And the Rust side **already reads that response** to extract other fields:

```rust
fn session_meta_from_list_row(root: &Path, session: &Value, …) -> Option<SessionMeta> {
    Some(SessionMeta {
        session_id,
        workspace,
        running,
        session_durability,                          // ← reaches the interface
        approval_mode: session_approval_mode(session), // ← reaches it, with a comment
        granted_capabilities,                        // ← reaches it
    })
}
```

**`modelId` is ignored.** The asymmetry is clear: the approval mode and the durability are passed to the renderer, the model is thrown away — although **the Rust code already knows how to extract a field from a `session/list` row**, as `session_approval_mode(session)` proves.

## What the fix would require

1. `session_meta_from_list_row` reads `session.get("modelId")` and puts it into `SessionMeta` (the same pattern as `approval_mode`).
2. `SessionMeta` (Rust) and its TypeScript type gain `model_id`, serialised when present.
3. The renderer applies `meta.model_id` to restored sessions, as it already applies `meta.approval_mode`.

**I am not applying that fix in this pass.** It touches the data structure shared across all three layers — Rust, TypeScript bridge, renderer — for a display improvement. It deserves its own change, with the Rust tests that already exist around `session_meta_from_list_row` (`main.rs:7225`), rather than an addition at the end of a UX pass where I could not verify it across the three layers.

## What this diagnosis corrects in the pass

The visual review had flagged "the model label is still cut off with the panel unfolded". **That is false** — but its observation rested on a screenshot predating the fix, and the short `Model` label made it impossible to settle. **Twice in this pass, a valid observation turned out to be misattributed**: here through the screenshot's age, and for the Desktop panel through confusing structure with content. Measurement settles it, the eye alone does not.
