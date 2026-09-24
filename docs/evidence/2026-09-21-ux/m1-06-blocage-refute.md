# M1-06 — the "blocking finding" was a measurement artefact (21 September 2026)

**Verdict: the blocker attributed to the host does not exist.** `session/userShell` runs the command and publishes its result. The "blocking finding" of 19 September came from a probe that requested the capability in a shape the host reads as "no capability requested".

## What the roadmap claimed

> **Blocking finding (Windows, 19/09/2026):** `--exercise-user-shell --exercise-user-shell-slow` got `accepted` on both sides, but **no** `item/started`, no notification carrying the `commandId`, and no witness file 14 s after admission. Admission alone proves neither execution nor return — **the blocker is on the host side**.

That sentence steered the campaign: it classified M1-06 among the tickets that "no client fix will close", and pointed to `SIDECAR-CONTRACT-GAPS.md`.

## The cause: a misplaced capability key

`scripts/msp-user-shell-items.mjs` sent:

```js
capabilities: {},                        // empty
requestedCapabilities: ["userShell"],    // at the top level
```

The application has always sent (`src-tauri/src/main.rs`):

```rust
"capabilities": {"requestedCapabilities": ["userShell"]}
```

The key has to be **nested**. With the flat shape, the host sees no capability requested: it grants nothing, and answers the call with `capabilityRequired`. The probe concluded no item is published — when **it had never run the command**.

That is also why the desktop app does get `userShell` granted and enables the button: it used the right shape. **Two measurements of the same contract contradicted each other, and the wrong one was published.**

## Measurements, before and after the fix

| | Flat shape (wrong) | Nested shape (the application's) |
|---|---|---|
| `grantedCapabilities` | `[]` | **`["userShell"]`** |
| `session/userShell` | `failed`, `capabilityRequired` | **`accepted`**, `commandId` returned |
| Notifications | **none** | **`item/started`** then **`item/completed`**, kind `userShell`, at 1,867 and 1,922 ms |
| Command output | — | **marker returned** (`markerEchoed: true`) |
| The probe's verdict | "the gap is confirmed outside the suspect harness" | "**the host DOES publish 2 userShell item(s) — the gap report is wrong here**" |

The script already carried, in its own comment, the warning that the claim came from a harness **already proved falsely negative** ([`harness-faux-negatif.md`](../2026-09-20-windows-sessions/harness-faux-negatif.md)). It reproduced the same error of method with a different cause.

## What stays true, and what no longer does

**Disproved:** "the host does not publish a `userShell` item". It publishes two, with the output.

**Confirmed, but it is the client:** the output is **not rendered in the transcript**. `BETA-0.1.0-SCOPE.md` already said the exact opposite of the blocker — "the host provides the item, the client does not display it" — and that reading is the right one. The "Add output to prompt" fallback works.

**Confirmed, different cause:** `Run in Muse` fails with `sessionNotLoaded` on a conversation that was never started. The host **admits** the session at rest (it appears in `session/list`) but only **loads** it on its first turn. The client enables the button in that state and the failure arrives only after the click.

**To re-check:** M0-04 and M1-11 rested on the same harness (`--exercise-user-shell`), whose capability shape was wrong. Their blocker must be re-measured before being cited again.

## The client path, verified end to end

| Layer | Measurement |
|---|---|
| Rust projection | `restore_sessions` returns `granted_capabilities: ["userShell"]` for all 11 sessions |
| Renderer merge | `grantedCapabilitiesBySession` (hook #82) holds `["userShell"]` for the active session |
| React prop | `canRunThroughMuse` turns **`true`** as soon as a command is typed |
| Button | `disabled=false`, tooltip "Run this command through the Muse host (userShell)" |
| Call | reaches the host, which answers `sessionNotLoaded` — the failure is **real** and **reported** |

**A method note on that last point.** An earlier round concluded this button was blocked by the capability. That was false: `disabled` combines three conditions (`!canRunThroughMuse || !command.trim() || runningThroughMuse`), and I had read the `disabled` of an **empty** field. The marker that settles it is the **tooltip**, which changes with the cause: "did not grant the userShell capability" when the capability is missing, "Run this command through the Muse host (userShell)" otherwise. **Measure the cause, not the composite state.**

## Instruments

| Script | State |
|---|---|
| `msp-user-shell-items.mjs` | **fixed** — nested capability shape, with the reason in a comment |
| `ux-run-in-muse.mjs` | exercises the UI path: typing, enabling, clicking, waiting for the item |
| `ux-read-logs.mjs` | reads the transcript from the hook's state, not from the DOM |
| `ux-terminal-state.mjs` | reads the state of both send actions **and the reason** they are unavailable: distinguishes "failed" from "never attempted" |
| `check-scripts-parse.mjs` | guard rail: every script in `scripts/` must at least compile |
