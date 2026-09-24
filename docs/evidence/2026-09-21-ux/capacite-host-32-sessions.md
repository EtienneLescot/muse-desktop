# Host capacity: 32 loaded sessions, never unloaded

**User report (23/09/2026, Windows).** Around 30 conversations, 27 of them outside any project.
The app shows two errors:

- when switching to YOLO: `YOLO saved locally, but 28 conversations could not update the host.`;
- when starting a conversation: `MSP error -32030: host loaded-session capacity is exhausted
  [commandRejected] (runtime_busy) [retryable=true]`.

## Measurements (Muse 1.3 sidecar, temporary workspaces)

- **32 loaded sessions at most per host.** The 33rd `session/start` is refused with exactly the
  error in the screenshot (`node scripts/msp-loaded-capacity.mjs`). `initialize` announces no
  limit.
- **The host never unloads an inactive session.** 32 sessions loaded, 16 of them put through
  `view/unsubscribe`, `sessionListStream` capability negotiated. For 6 minutes, `session/list`
  reports `idle: 32` every 30 s, no `session/closed` arrives, and every new
  `session/start` is refused.
- **No client-side unloading**: no `session/unload` and no `session/close`, and the schema
  defers to the host's inactivity policy (tdd SS2.8).
- `session/setApprovalMode` with `allowAll` is accepted on a loaded session, even at the ceiling.

Consequence: the limit is on conversations **loaded since the host launched**.
Opening 32 conversations one after another is enough, without ever having several open at
once. Only a new process frees the space.

## Causes on the app side

1. Boot-time resume reloaded **every** stored conversation, which filled the
   host as soon as it launched.
2. Even without that, every conversation opened stayed loaded until the process ended.

## Fix

- **Resume on open** (`selectResumeOnOpen`): only the open conversation is resumed,
  at boot and then on each open.
- **Replacing a full host** (`recycle_full_host`, `main.rs`). When `session/start` or
  `session/resume` receives `-32030 runtime_busy`:
  - that folder's host is replaced by a fresh process, then the request is replayed once;
  - the conversations it carried receive `host_exited` with a dedicated message, then are
    resumed silently when the user reopens them;
  - **the replacement is refused if one of them is working**, so a turn is not killed. The message
    then explains to wait for it to finish.
- The YOLO message quotes the host's first refusal reason. The cause of the 28 failures in the
  screenshot could not be read: the app was closed.

## Limits

- Not replayed in the app yet: neither a start beyond 32, nor the resume after a replacement.
- A real host crash still requires the manual Reconnect. Only a deliberate replacement triggers
  an automatic resume, so a crash does not loop.
