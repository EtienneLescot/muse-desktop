# Reload mid-send — nothing is lost (M0-03, 20 September 2026)

M0-03's last accessible criterion: "close / reload".

## Protocol

```powershell
node scripts/cdp-reload-mid-send.mjs
```

Two scenarios in the same pass, with the conversation's identity recorded at each step:

1. **Unsent draft** → full webview reload → the text must survive.
2. **Send in progress** → reload during the turn → neither loss nor duplication.

## Result

### 1. An unsent draft survives the reload

| Step | Composer holds the marker | Marker in the log | Entries |
|---|---|---|---|
| typed-draft | **yes** | 0 | 38 |
| **after-reload-draft** | **yes** | 0 | 38 |

The marker is **still in the composer** after a full `location.reload()`. The log has not moved — as expected, nothing was sent.

**Where the draft lives:** `sessionStorage` contains
`muse-desktop.draft.01a0bea1-cddc-7ca2-8c70-5fb41ed02df4` — that is, **one key per conversation**, which prevents a draft ending up in the wrong thread.

### 2. A send in progress does not duplicate

| Step | Marker in the log | Distinct identifiers | Entries | Working |
|---|---|---|---|---|
| sent | 1 | 1 | 41 | yes |
| **after-reload-mid-send** | **1** | **1** | 44 | yes |

**Marker occurrences: 1. Distinct client identifiers: 1.** Reloading during the turn produced **no second send**.

Entries go from 41 to 44: the turn **continues** after the reload (the host is a separate process, unaffected by the webview reloading) and the transcript fills in. No outbox entry was created at any point — consistent, since the send had been acknowledged before the reload.

## Established

- **The user's work is never lost**: an unsent draft survives a full reload, with one `sessionStorage` key per conversation.
- **A send does not duplicate** on reload: a single client identifier, a single occurrence in the log.
- **The turn survives the webview reload**: the host being a separate process, the transcript keeps filling.

## Scope and limits

- The scenario tested is a **webview reload** (`location.reload()`), not an **application close**. A close kills the host and belongs to another question — resume, covered in this campaign's `README.md` and blocked by the sidecar contract (`session/read` / `session/resume` missing).
- **A single "send in progress" case**: the reload happened ~1.2 s after submission, hence after the acknowledgement. The case where the reload falls **before** the acknowledgement — the one where the outbox should switch to an ambiguous `failed` — was **not** exercised, for want of a reliable time window to aim at.
- The **IME** stays unexercised.

## State of M0-03

| Criterion | State |
|---|---|
| Lose no text on a rejected send | **proved** (`M0-03-envoi-rejete.md`) |
| Double-click → a single turn | **proved** (`M0-03-double-envoi.md`) |
| Close / reload | **proved** for these two scenarios (this document) |
| IME | not exercised |

**M0-03 is not closed** — the IME is missing, and the "reload before acknowledgement" case is not covered. But **three of its four criteria** now have native, reproducible measurements, and they are the three about losing and duplicating work.
