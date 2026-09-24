# Sub-agents: hiding internal children + errors inside the block

Campaign date: 27/09/2026 · Platform: Windows 10 (native build `src-tauri/target/debug/muse-desktop.exe`) · Commit: see the end of this note.

## Symptom reported

Under the agent's answer, unusable "Reminder child session" blocks
appear, with a row of buttons (Close, Reopen, Interrupt, Stop, Resume,
Follow up, Read result, Agent conversation) that **cause errors**:

- a global red banner: `subagent drill-down failed: … {sessionNotFound} [retryable=false]`
- and, inside the block: `The host returned no conversation for this agent.`

## Root cause

1. The host emits items of kind **`reminderchild`** for its own internal use
   ("Reminder child session" is the goal it gives itself).
   `isSubagentItemKind` (phase.ts) and `is_subagent_item_kind` (main.rs)
   route them into the **same interactive lane** as real sub-agents: the full
   US-6 block is therefore mounted, with an 8-command console.
2. These children are **not** real sub-agents: the host publishes no
   `subagent/*` identity for them (supervisor: `agent_id` = item id) and
   `session/read` on their `childSessionId` answers `sessionNotFound`. Every
   control can therefore only fail.
3. The failure was reported twice: the hook put the error in the **global
   banner** (`setError`) *and* the block showed its own local message
   (`failed[entry.id]`). A point left open by the 22/09 audit
   (docs/plans/2026-09-22-audit-sous-agents.md).
4. A latent case bug spotted along the way: delta routing matched
   `"reminderChild"` **case-sensitively** while the table keeps the raw case;
   a lower-case `reminderchild` fell into the **assistant** path
   (polluting the answer).

## Fix

- `src-tauri/src/main.rs`: `itemKind` propagated in the `subagent_event`
  announcements (`item/started` and delta); delta routing through
  `is_subagent_item_kind` (case-insensitive) instead of a literal match.
- `src/lib/phase.ts`: `isInternalSubagentItemKind()` (kind `reminderchild`,
  tolerant of case and separators) + an `internal` flag on
  `upsertReflexivePlaceholder`.
- `src/lib/persist.ts`: a `subagentInternal` field on `LogEntry`;
  **historical logs caught up** on load (`loadLog`): a sub-agent entry with no
  item type whose host label (goal or first line of text) is "Reminder child
  session" is marked internal. The data stays in the log, only the rendering
  changes.
- `src/lib/subagent.ts`: `itemKind` read from the payload (`itemKind`/`item_kind`/`kind`).
- `src/hooks/useMuseSessions.ts`: the flag is set at ingestion
  (`item/started` + `subagent_event`); `subagentDrilldown` /
  `subagentReadResult` failures **no longer reach** the global banner — the
  block is the sole owner of the message.
- `src/components/StreamView.tsx`: `subagentInternal` entries are not
  rendered (no block, hence no buttons that fail).
- Tests: `test/phase.test.ts` (2), `test/subagent.test.ts` (2),
  `test/persistCaps.test.ts` (4).

## Evidence (replayable)

| Step | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | **1141 pass / 0 fail** (1133 before the campaign, +8) |
| Typing | `npx tsc --noEmit` | clean |
| Embedded frontend | `npm run build` | success |
| Native | `cargo build` (workdir `src-tauri`, app closed) | `Finished dev profile` in 25.18 s |
| Internal blocks hidden | CDP: `document.body.innerText` on the "yo" conversation | `hasReminderBlock: false` — the screenshot's 2 "Reminder child session" blocks are gone |
| Data preserved | CDP: reading `muse-desktop.log.v1.*` | "yo" session (`…a98d2f994e78`): 2 `role=subagent` entries whose first line of text = "Reminder child session" — **still present**, simply not rendered |
| No regression (real sub-agents) | CDP: count of `details.msg.subagent` on "Session 01a0c9c0" | **6 lanes rendered** for 6 real entries (goals "Summarize the README…" and so on) |
| Error in the block, not in a banner | CDP: click on `Agent conversation` (title `session/read`, unreadable child) | `anyGlobalDrilldownError: false` · local message `.subagent-failure`: "The host returned no conversation for this agent." |

Replay: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
then `scripts/cdp-drive.mjs eval '<js>'` (JS in single quotes, no `$`
and no double quotes).

## Decisions and limits

- **Hiding, not deleting**: the entry stays in the local log (evidence
  preserved); only the rendering filters it.
- The discriminator is the **item kind**: today it is the only signal
  available (the supervisor announces `agent_id` = item id for every sub-agent
  kind). If the host exposes a distinct sub-agent identity, the rule
  will become "internal unless identified".
- Catching up logs written before the kind was propagated relies on the
  **host's label** ("Reminder child session"), only for entries with no item
  type. A real sub-agent whose goal were exactly that label would be hidden
  wrongly — a risk accepted and documented.
- Still open (22/09 audit): measure `subagent/followupTask` on a finished
  agent; exposing `subagent/close`.
