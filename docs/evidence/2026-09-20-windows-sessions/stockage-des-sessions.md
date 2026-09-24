# Where conversations really live — a discovery (20 September 2026)

This campaign spent several rounds trying to delete test conversations, with results that "would not stick". The cause is here, and it was not where I was looking.

## The fact

`session/list` returns, for each session, its **storage path**:

```json
{
  "sessionId": "01a0bea1-cddc-7ca2-8c70-5fb41ed02df4",
  "path": "C:\\Users\\etien\\.local\\share\\muse\\sessions\\2026\\09\\20\\01a0bea1-…\\session.jsonl",
  "status": "notLoaded",
  "activeTurnId": null,
  "createdAt": "2026-09-20T11:44:30.172704Z",
  "updatedAt": "2026-09-20T18:55:11.525704Z",
  "workspaceRoot": "\\\\?\\G:\\repos\\openscreen",
  "providerId": "meta",
  "modelId": "muse-spark-1.3-contributor",
  "turnCount": 11,
  "forkedFrom": null,
  "title": "Enumerate the three Musketeers by name.",
  "firstUserPrompt": "Enumerate the three Musketeers by name.",
  "branch": "pr620"
}
```

**Conversations are `session.jsonl` files on disk**, under
`%USERPROFILE%\.local\share\muse\sessions\<year>\<month>\<day>\<sessionId>\session.jsonl`.

The **host owns them**; the application only mirrors them. Hence the behaviour observed during the cleanup: deleting a conversation in the application does not delete the file, and the entry **comes back** as soon as the application asks `session/list` again.

## Fields exposed by `session/list`

`sessionId`, `path`, `status`, `activeTurnId`, `createdAt`, `updatedAt`, `workspaceRoot`, `providerId`, `modelId`, `turnCount`, `forkedFrom`, `title`, `firstUserPrompt`, `branch`.

Seven of those fields — `path`, `status`, `activeTurnId`, `turnCount`, `providerId`, `modelId`, `branch` — **were documented nowhere** in the repository before this measurement.

## Measured inventory (18 sessions on disk)

| Identifier | Lines | Size | Origin |
|---|---|---|---|
| `01a0bb03` | **44,050** | **65,194 KB** | campaign (the largest) |
| `01a0bea1` | 737 | 1,468 KB | campaign |
| `01a0bead` | 384 | 645 KB | campaign |
| `01a0bb00` | 116 | 298 KB | campaign |
| `01a0beaf`, `01a0bec9` | ~165 | ~287 KB | campaign |
| `01a0bead` (2nd), `01a0bf02` | ~110-164 | ~160-282 KB | campaign |
| `01a0be8a` | 73 | 147 KB | campaign |
| `01a0bafe` | 10 | 7 KB | campaign |
| `cd820fec`, `4306ea8c`, `5b38de0b`, `611bba64` | 34-38 | 68-115 KB | **identifiers of a different shape** |
| `803ede85`, `92015b53`, `f63e0cdb`, `72b8c035` | 34-52 | 61-93 KB | same |

**Eleven sessions carry the `01a0…` prefix** — the shape of identifiers generated during this campaign. **Seven carry a different shape**: they do not come from these tests, and I **do not touch them**.

The campaign's sessions total roughly **70 MB**, of which **65 MB is a single one**.

## Why this changes the cleanup diagnosis

The document [`nettoyage-conversations.md`](../2026-09-20-windows-cleanup/nettoyage-conversations.md) concluded that the native side reintroduced the deleted sessions. **That is accurate, and here is the precise mechanism**: the host re-reads its own `session.jsonl` files and re-lists them; the application rebuilds a local entry for each.

The interface's **Delete…** button, for its part, sends the order to **kill the session** — which explains why it works, at least while the host is alive. But **it does not necessarily delete the file**: `01a0bea1` was still on disk after being deleted on the application side, with **1,468 KB** and 737 lines.

## What is left to do, and why I have not done it

Deleting files from `%USERPROFILE%\.local\share\muse\sessions\` **goes beyond the scope of the objective** and touches storage shared with the Muse CLI: that is a decision for you, not me.

**What is certain:** the 11 sessions with the `01a0…` prefix come from this test campaign, and they take ~70 MB.

**What is not certain:** the 7 sessions with a differently shaped identifier. They could be your Muse CLI conversations, or other experiments. I leave them alone.

## Protocol detail discovered along the way

**`session/start` requires a `commandId`** in addition to `workspaceRoot`. Without it:

```
invalid session/start params: missing field `commandId`  [invalidParams]
```

The gap report did not mention it — it listed `workspaceRoot` but not `commandId`. To correct in [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md) at the next update.
