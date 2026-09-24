# `sessionDurability` changed: `ephemeral` → `durable` (20 September 2026)

**This document corrects a claim in [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md) §5**, which presents `ephemeral` as a property of the host. The measurement does not confirm it.

## The two measurements

| When | Measurement | Host |
|---|---|---|
| Rounds 15–23 (morning and early afternoon) | **`sessionDurability: "ephemeral"`** | `initialize` on two real hosts, `msp-probe` and `native-smoke` |
| Round 50 (evening), **four times** | **`sessionDurability: "durable"`** | four fresh hosts, launched one by one |

The later measurement is **reproducible**: obtained four times in a row, with and without `requestedCapabilities: ["userShell"]`, on fresh processes.

## What I checked to rule out false leads

- **The configuration did not move**: `~/.config/muse/settings.json` dates from **19/09 21:30** and `auth.json` from **19/09 20:47** — that is, **before** the first `ephemeral` measurement. Neither contains a durability field.
- **It is not an effect of `clientInfo.name`**: `muse_durability_check` and `muse_list_sessions` both give `durable`.
- **It is not an effect of the requested capabilities**: with and without `userShell`, the result is identical.

## What I do not know

**I cannot explain the change.** I do not have the cause, and I would rather write that than invent a theory. What is certain is that **`sessionDurability` cannot be documented as a constant of host 1.3.0** — its value changed on the same machine, on the same day, with no configuration change.

## The implication, and it matters for M0-02

`session/list` enumerates **9 sessions** the host knows, each with its **storage path**:

```
%USERPROFILE%\.local\share\muse\sessions\<year>\<month>\<day>\<sessionId>\session.jsonl
```

and complete metadata: `title`, `turnCount`, `status`, `workspaceRoot`, `branch`, `updatedAt`. **Nine sessions, eleven turns for the longest, persisted on disk.**

In other words, when the gap report asked for `session/read` and `session/resume`, it presented them as the means of **recovering a history**. But **the history is already there, persistent and enumerable** — what is missing is the API to read the content from a client.

## What is left to test, and could close M0-02

The campaign README records that after clicking **Reconnect**, the application shows:

> `This conversation could not be resumed. — MSP error -32020: session … was not found [sessionNotFound]`

**Untested hypothesis:** if the host is now `durable` and `session/list` enumerates these sessions, then **the host knows the session** — and the resume failure would come from the **client**, which starts a new host and does not reconcile against the sessions already present. That would be a **client-side defect, fixable**, and not a sidecar blocker.

That is a hypothesis, not a result. It is testable: restart the application, check whether `session/list` still sees the session after the restart, and whether the client offers it for resume.

## Method

```powershell
node scripts/msp-list-sessions.mjs
node scripts/msp-list-sessions.mjs --json
```

The script launches a host, performs the **complete** handshake (`initialize` then the `initialized` notification, without which every later call answers `Not initialized`), queries `session/list` and prints the metadata. **Read only**: it writes and deletes nothing.

## Correction to carry into the gap report

§5 should say: `sessionDurability` **varies** — `ephemeral` observed early in the campaign, `durable` at the end, cause unidentified. The conclusion "durable resume is not demonstrated" still stands, but **not for the reason given**.
