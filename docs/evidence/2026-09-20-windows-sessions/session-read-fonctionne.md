# `session/read` works — correcting a false finding (20 September 2026)

**This document corrects gap no. 1 of [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, which classifies `session/read` and `session/resume` as `unsupported`. That is **inaccurate**, and the error comes from my probe.

## What the probe was doing wrong

`msp-probe.mjs` calls the read surfaces on a session it has **just created** with `session/start` (line 308 onwards):

```js
await attempt("session/read", { sessionId, excludeItems: true })
```

But a freshly created session **has never been persisted** — no turn has written it to disk. The host therefore answers `sessionNotFound`, and the probe translated that into:

```js
return error?.kind === "methodNotFound" ? "unsupported" : `error: ${reason(error)}`;
```

The branch only tests `methodNotFound`. Since the probe nonetheless reported `unsupported` on those two methods, **I concluded the methods did not exist** — without checking the distinction between "missing method" and "missing session".

## What the real measurement gives

On a session **actually present on disk**, with a fresh host:

| Session | Turns | `session/read` | `session/resume` |
|---|---|---|---|
| `01a0bea1` | 11 | **`ok`** | `sessionInUse` |
| `01a0bead` | 1 | **`ok`** | `sessionInUse` |
| `01a0bead` | 2 | **`ok`** | `sessionInUse` |
| `01a0beaf` | 2 | **`ok`** | `sessionInUse` |

**`session/read` answers `ok` on all four.** And `session/resume` does **not** answer `sessionNotFound` but **`sessionInUse`** — a different refusal, meaning the host considers the session **already open**.

## Shape of the `session/read` response

```
{ session, viewCursor, history, pendingRequests }
```

- `session`: the complete object already described in `stockage-des-sessions.md` — `path`, `status`, `turnCount`, `title`, `workspaceRoot`, `providerId`, `modelId`, `lastActivityAt`…
- `viewCursor`: a view cursor, **the pagination surface** the report declared absent under the name `view/page`.
- `history`: the session's history.
- `pendingRequests`: an array, empty here.

## The two failures, now distinguished

The campaign observed two errors and had conflated them:

| Situation | Response | Meaning |
|---|---|---|
| Session **never persisted** (created, no turn) | `sessionNotFound` | the session does not exist on disk — **not** a missing method |
| Session **persisted**, already open elsewhere | `sessionInUse` | it exists, but the host considers it taken |
| Session **persisted**, free | **not observed** | that is the case to test for resume |

## What that changes for M0-02

The report presented `session/read` and `session/resume` as **absent from the protocol**, hence as implementation work on the sidecar side. **`session/read` exists and works.** What stays open is narrower:

1. **`session/resume` on a free session** was not observed — the test only met `sessionInUse`, because the application was running and holding those sessions.
2. **`view/page`** may simply be `session/read` with its `viewCursor`: to verify, since the report classified it as absent too.
3. The resume defect observed in the interface (`sessionNotFound` after Reconnect) concerns sessions **created during the application's session with no completed turn**, or identifiers the new host cannot find. To be revisited in the light of this document.

## What has to be corrected in the gap report

- Gap no. 1 **must no longer present `session/read` as absent**.
- The `msp-probe.mjs` probe must **distinguish** `methodNotFound` from `sessionNotFound` and **test the read surfaces on a persisted session**, not on a freshly created one. Without that fix, the probe will keep producing a false finding.
- `view/page` must be re-evaluated against `viewCursor`.

## Reproducibility

```powershell
node scripts/msp-list-sessions.mjs          # lists the persisted sessions
node scripts/msp-session-survival.mjs       # a session's survival when its host dies
```

**What this document does not say:** I have not yet proved that a **complete** resume works end to end — I only observed `sessionInUse` because the application was holding the sessions. The decisive test remains to be done: host alone, free session, `session/resume` then reading the history.
