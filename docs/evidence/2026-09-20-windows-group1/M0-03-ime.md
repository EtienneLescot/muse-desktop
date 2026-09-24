# IME composition — Enter does not submit (M0-03, 20 September 2026)

M0-03's last criterion: "IME". In the previous round I announced I could not test it; **that was premature**. CDP exposes `Input.imeSetComposition`, which drives a real composition.

## The real risk, and why it is not "losing text"

With an IME, **Enter confirms the candidate, it does not submit the message**. The danger is therefore not losing text but **sending prematurely**: the user types "にほんご", presses Enter to choose "日本語", and the message goes out with the text still being composed — or worse, empty.

That is the scenario tested.

## Protocol

```powershell
node scripts/cdp-ime-compose.mjs
```

The script installs real listeners on the composer's `compositionstart`, `compositionupdate` and `compositionend` — to **observe** the events, not assume them — then:

1. composes `にほんご` in hiragana through `Input.imeSetComposition`;
2. **presses Enter while the composition is active**;
3. confirms the composition as `日本語` through `Input.insertText`;
4. sends for real, and checks what goes out.

## Result

| Step | Composer | Log entries | Events observed |
|---|---|---|---|
| opened | `日本語` *(residue from an earlier probe)* | 45 | — |
| composing-hiragana | `にほんご日本語` | 45 | `compositionstart`, `compositionupdate(にほんご)` |
| **Enter during the composition** | **`にほんご日本語` — unchanged** | **45 — unchanged** | same |
| after-commit | `日本語日本語` | 45 | `+ compositionupdate(日本語)`, **`compositionend(日本語)`** |
| real send | **cleared** | **48** | — |

### Established

- **Composition events really arrive**: `compositionstart`, two `compositionupdate`s and one `compositionend` were observed by listeners placed on the element. This is not a simulation of synthetic events — it is the engine's composition path.
- **Enter during a composition does not send the message.** The entry counter stays at **45** and the composer is **unchanged**: the application did not confuse confirming the candidate with submitting. That is the correct behaviour and it is **the IME's main risk**.
- **The committed composition is the text preserved**: after `compositionend`, the composer contains `日本語` — the Japanese text is neither truncated nor corrupted.
- **The real send works afterwards**: composer cleared, log 45 → 48.

### A detail not to over-interpret

The log contains `日本語日本語` (doubled) because the composer already held `日本語` **at the start of the test** — residue from my `Input.imeSetComposition` verification probe run just before, which had left text without sending it. That is not an application defect: my starting state was not clean. The marker appears only **once** in the log, with the `user` role.

## Scope and limits

- A **single composition**, in Japanese from hiragana to kanji. Chinese, Korean and IMEs with multiple candidate stages are not exercised.
- **No real system IME** was driven: `Input.imeSetComposition` reproduces the engine's composition protocol, not the behaviour of an IME installed on the machine. The two ought to coincide since the events are the same, but I did not verify it.
- **Physical keyboard input during a composition** (control keys, Escape to cancel a composition) is not exercised.
- An unclean starting state distorted the reading of the text sent; the protocol should clear the composer before beginning.

## State of M0-03

| Criterion | State | Deliverable |
|---|---|---|
| Lose no text on a rejected send | **proved** | #177 |
| Double-click → a single turn | **proved** | #178 |
| Close / reload | **proved** (2 scenarios) | #179 |
| IME | **proved** — Enter does not submit during a composition | this document |

**All four criteria listed by the ticket now have native measurements.** M0-03 is not declared closed for all that: each criterion is covered on **one** scenario, not across all its variants — partial IMEs (Korean, Chinese), reload before acknowledgement, mouse double-click. The limits are listed above and in the linked documents.
