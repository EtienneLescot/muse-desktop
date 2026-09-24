# Double send — a single turn admitted (M0-03, 20 September 2026)

M0-03's last reachable criterion: "double-click". Checks that a fast double submission does **not** create two turns.

## Protocol

```powershell
node scripts/cdp-double-send.mjs
```

The script opens a conversation, types a unique marker (`DOUBLE-CLICK-PROBE-4187`), then sends **two `Enter` presses 120 ms apart** — the equivalent of double-clicking the send affordance. The conversation's identity is recorded at each step.

## Result

### On screen

| Step | `activeId` | Entries | Composer | Working | Warning | Outbox |
|---|---|---|---|---|---|---|
| opened | `01a0bea1-…` | 32 | empty | no | no | 0 |
| after-double-enter | **identical** | 35 | **cleared** | **yes** | **no** | 0 |
| after-8s | identical | 36 | cleared | yes | no | 0 |

A **single** progression is visible (`working: true`, one transition), the composer clears **once**, and **no "already in progress" warning** appears.

### In the full log — the measurement that settles it

The on-screen observation is not enough: the DOM window only mounts the last 160 entries, so a DOM count can miss an occurrence further up. The **full** log was therefore read back:

| Measurement | Value |
|---|---|
| Log entries | 38 |
| **Marker occurrences** | **1** |
| Roles | `["user"]` |
| **Distinct identifiers** | **1** — `80270120-d64b-48e7-b…` |
| Outbox entries | **0** |

**Established:** two consecutive `Enter`s produce **a single send**, with **a single client identifier**. The pipeline's guard ("a send is already in progress for this conversation") does its job: the second submission is discarded instead of creating a second turn.

That is the expected behaviour: the outbox module documents that "one logical send can never become two accepted turns", and the measurement confirms it in the log — not only in the display.

## Scope

- **What is proved:** two closely spaced submissions by **keyboard** (Enter) admit only one turn.
- **What is not:** a **mouse** double-click on the send button. The button is an icon with no usable label, and I verified at round 20 that a mis-aimed click reaches the wrong element. The keyboard path is the documented one ("Enter to send") and it is the one measured.
- **Also unexercised:** the IME and the close/reload, M0-03's other two criteria.

## State of M0-03 after this measurement

| Criterion | State |
|---|---|
| Lose no text on a rejected send | **proved** (`M0-03-envoi-rejete.md`) |
| Double-click → a single turn | **proved** (this document), by keyboard |
| IME | not exercised |
| Close / reload | not exercised |

**M0-03 is not closed**: two criteria remain. But its loss and duplication criteria — the most important for the user — are now measured, with deterministic reproductions.
