# M1-11 — Effective model: the switch is proved on the host side, the UI label is not per session (27 September 2026)

**A two-part result:** the model switch **works** (a `session/setModel` call per session,
`is_active` follows, the `model_id` in session responses is consistent) — but **the picker's label
is not refreshed per conversation**: when moving between two open conversations, the UI
announces the last model chosen anywhere, not the effective model of the conversation displayed.

## 1. What is proved (functional)

**Switch + wire** — selecting in the Model picker:

```json
{"cmd":"set_model","payload":{"sessionId":"01a0c96d-…","modelId":"muse-spark-1.2-contributor","providerId":"meta","profile_id":"tbh"},"result":"null"}
```

then `list_models` refreshed **for that session**: `is_active` follows the selection.

**State really per session on the host side** — two conversations in the same workspace, same hosts:

| Session | Action | Effective `model_id` |
|---|---|---|
| A `01a0c96d-…` | `set_model` → `muse-spark-1.2-contributor` (success) | `muse-spark-1.2-contributor` |
| B `01a0c955-…` | `resume_session` (no switch) | **`muse-spark-1.3-contributor`** (default) |

B resumes its **own** model although A had just been switched — the host's state really is
**per session**, not global per host.

**The UI label matches the effective model after hydration** — after B's `resume_session`:
`model_id: "muse-spark-1.3-contributor"`, `list_models(B)` → `is_active: true` on
`muse-spark-1.3-contributor` (and `is_default: true`), and the picker's trigger shows
exactly `muse-spark-1.3-contributor`. ✓

## 2. Defects measured

### 2.1 The label is not per conversation (blocking closure)

Sequence: switch B to `muse-spark-1.3` (success, `is_active: true` for B) → back to A.

- label shown on **A**: `muse-spark-1.3`
- **A**'s effective model: `muse-spark-1.2-contributor` (its own switch, `set_model` → `null`)

**The UI announces a model the conversation will not use.** Mechanism observed: the label
is updated by the picker's actions and by `resume_session` hydration, but **not on
a conversation change** (no `list_models` emitted on the switch — a shared cache).

### 2.2 Switching on an unloaded conversation: a clean rejection but an active picker

`set_model` on a saved conversation with no engine:

```json
{"result": "\"conversation engine is unavailable — start or restore the conversation first\""}
```

The label does not move (no optimistic lie ✓) and an honest **Reconnect** button
("Reconnect this saved conversation to its workspace engine") is offered —
but the picker stays usable and does not explain the rejection. After Reconnect, the switch
works.

## M1-11 Windows verdict

- **Switching between open conversations: the capability exists and the state is per session** —
  but **the acceptance criterion fails**: "the label the UI announces matches the model
  actually sent to the host" is false on a conversation change (2.1).
- **Remaining:** refresh (or store per session) the model displayed on a switch — through a
  per-session `list_models` or a local state keyed by `session_id`; persistence of the
  switch after an app restart still to replay; `contextUsage` unchanged during the turn,
  not replayed today.

## Reproducibility

- Commit `2f80148`+; Windows 11 26200, WebView2, CDP 9222; `muse` sidecar 1.3.0.
- Sequence: `node scripts/ux-model-picker.mjs --port 9222` (opening the popover, 4 options,
  label on selection) → manual switch with a `window.fetch` trace (through
  `scripts/cdp-drive.mjs eval`): `set_model` + `list_models` per `sessionId`; label/effective
  divergence measured by moving between `button.session-select` entries.
