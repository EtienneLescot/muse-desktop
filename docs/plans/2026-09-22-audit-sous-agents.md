# Sub-agents: an audit, and what happens the day we really ask for one (22 September 2026)

Trigger: an "Agent … Reminder child session" block whose **six buttons all failed**, with a generic error at the top of the page. The immediate cause was an invented field name (`agentId` instead of `subagentId`, fixed in PR #224). The real question remained: **what is actually in place, and how will it work the day we want sub-agents?**

## 1. The client cannot create a sub-agent. Ever.

The MSP schema exported by the 1.3.0 binary exposes **eight** `subagent/*` methods:

| Method | What it does |
|---|---|
| `subagent/interrupt` | interrupts the child |
| `subagent/stop` | stops it |
| `subagent/resume` | resumes it |
| `subagent/followupTask` | sends it a new instruction (`body`) |
| `subagent/readResult` | reads its result |
| `subagent/close` | closes it |
| `subagent/reopen` | reopens it |
| `subagent/sendMessage` | sends it a message |

**No creation method.** No `spawn`, no `start`, no `create`. The full list of 46 contract methods contains none. Creating a sub-agent is therefore a decision **made by the model during its turn**, not a client command. The eight methods above only *drive* what already exists.

Direct consequence for the interface: **any button suggesting we launch a sub-agent would be lying.** What we can honestly offer is to *ask* the model to delegate — that is, text — then drive and observe what comes of it.

## 2. What the client actually uses, out of the eight

| Method | Called by the client? |
|---|---|
| `subagent/interrupt` · `stop` · `resume` · `followupTask` · `readResult` | yes (the block's six controls) |
| `session/read` for "Agent conversation" | yes |
| `subagent/close` · `subagent/reopen` · `subagent/sendMessage` | **no, never** |

The three unused ones are not necessarily needed — but they exist, and the audit must say why we do not take them, or take them. `close` in particular has an obvious product meaning: a finished child lingering in the lane.

## 3. The false positive, named

The block presented itself as an operational control console. It was not:

- **all six buttons failed** (wrong field), so nothing on offer worked;
- **the buttons accounted for no state**: on a `Completed` agent, "Interrupt" and "Stop" stayed clickable — yet there is nothing left to interrupt;
- **the failure appeared as a global banner**, at the top of the page, although it concerned that block;
- **the raw child identifier** (`child: 7d2adb74-1fa9-4316-9fb9-397055ee3809`) taught nothing.

## 4. What this PR fixes

1. **An availability table** (`subagentControlAvailability`, pure and tested) replaces the ad hoc booleans. It disables only where the reason is **certain** — you cannot interrupt a finished agent — and every disabled control carries **its own sentence** ("This agent has finished; there is nothing to interrupt.").
   - Deliberately, `readResult` and `followupTask` stay available on a finished agent: we have **no measurement** saying the host refuses them, and guessing would reproduce the very defect being fixed.
2. **The child session's label**: the title when the client knows it (identifier kept in the tooltip), otherwise a shortened identifier (`7d2adb74…`) — not a 36-character UUID.

## 5. What stays open, and needs a decision or a measurement

| Point | Nature |
|---|---|
| **The error in the block, not at the top of the page** | needs a per-entry error state; the global banner stays for the conversation. **Done on 27/09/2026**: `subagentDrilldown`/`subagentReadResult` no longer go through `setError`, and the block (`.subagent-failure`) is the sole owner of the message. Verified natively: clicking "Agent conversation" on an unreadable child → the message appears in the block, no banner. Also, the host's internal children (kind `reminderchild`, goal "Reminder child session") are no longer rendered as a sub-agent console. Details and replay: docs/evidence/2026-09-27-qualif-native/sous-agents-enfants-internes.md. |
| **`subagent/close`** | expose it? A finished child accumulating in the lane is a real UX subject. |
| **`followupTask` on a finished agent** | **to measure** before promising or forbidding it. |
| **Asking for a delegation** | the client can only ask; `/fanout` already does it in natural language. To align with that vocabulary rather than invent a "spawn" button that does not exist in the contract. |

## 6. The answer to "the day we ask to spawn one"

**Mechanics:** we do not spawn. We write a delegation request into the turn; the model decides; the host publishes the `subagent` items; the client drives (8 methods) and observes (lanes). Any mechanism claiming otherwise would be a simulation.

**UX:** the vocabulary has to say "ask", not "launch". And the sub-agent lane must make three things readable: who was delegated to (a title, not a UUID), where they are (the host's status), and what can still be done (the controls, with their reasons).
