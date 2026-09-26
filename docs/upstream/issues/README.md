# Upstream issue drafts — Muse Code host 1.3.0

Three self-contained reports, ready to paste into the Muse tracker. All are
measurement-backed from this repository's qualification campaigns (20–27/09,
25–26/09 and 26/09/2026, Windows 11 build 26200, host `muse-bin-1.3.0-R3401.1.exe`).
Private-repo evidence links were intentionally removed — each report stands alone.

## File 1 — `muse-1.3.0-no-approval-prompts.md`

**Title:** No approval requests are ever raised in `ask`/`onRequest` posture — tools run silently

**Environment:** Windows 11 (26200), Muse host 1.3.0, posture mapped through
`session/setApprovalMode` to `onRequest`. Verified twice, four weeks apart
(20/09 and 25-26/09/2026), including with a sandbox posture where tools execute
successfully.

**Steps to reproduce:**
1. Start a host in `ask` posture; confirm `session/setApprovalMode` is accepted.
2. Send a turn instructing the model to run a shell command itself
   (`echo m05-approval-stamp`).
3. Watch the stream: the tool-call item renders and runs.

**Actual:** the tool executes with **no approval request raised at any point** —
no event, and `approval/listPending` (called with a `sessionId`) returns an
empty set. `promptUnmatched` is accepted as a posture but behaves as "run
everything unmatched". The client cannot render any approve/deny surface.

**Expected:** in `onRequest` posture a tool call should produce a pending
approval (event or `approval/listPending` row) *before* the tool starts.

**Why it matters:** `ask` is the safety posture and it silently auto-runs
tools; desktop clients cannot implement the approval UX the posture promises.

## File 2 — `muse-1.3.0-powershell-tool-hangs-under-sandbox.md`

**Title:** The model's `powershell` tool never returns under the Windows sandbox

**Environment:** Windows 11 (26200), host 1.3.0, `muse sandbox windows check`
reports `backend=windows_elevated status=ready` (WFP ready, users configured).

**Steps to reproduce:**
1. Start the host with `--sandbox-network restricted` (or `enabled`).
2. Send a turn where the model runs `Get-ChildItem -Name` with its `powershell` tool.

**Actual (matrix, four configurations):** the `toolCall` item stays `inProgress`
(10 min, then `tool timed out`; no terminal in 90 s on external probes).
**No `powershell` process is ever created** — the block happens before launch.
The client's own `session/userShell` runs fine under the same sandbox, so the
defect is specific to the model's shell-tool path.

**Works:** the same command completes in **1 s** with `--disable-sandbox`.

**Impact:** with any sandboxed posture, model shell work is impossible; clients
must document `--disable-sandbox` to make the agent usable, weakening the
safety model.

## File 3 — `muse-1.3.0-fork-fails-with-subagent-lanes.md`

**Title:** `session/fork` answers `forkBoundaryInvalid WriteFailed` on sessions
with sub-agent ("child session") lanes, including fresh ones

**Environment:** Windows 11 (26200), host 1.3.0. Measured 26/09/2026 through a
desktop client and via a direct `session/fork` request.

**Steps to reproduce:**
1. Run any turn that spawned a `Reminder child session` lane (most turns now do).
2. Call `session/fork` on the session — with a `cutPoint.lastTurnId` anchor or
   without one.

**Actual:** `MSP error -32023: invalid fork boundary … WriteFailed
[forkBoundaryInvalid] [retryable=false]` for **every** anchor — including the
latest completed turn and anchorless requests. A fresh two-turn session with a
reminder lane refuses exactly the same way; a fresh one-turn session **without**
a lane forked fine on 20/09 with identical request shapes.

**Expected:** `session/fork` branches at the requested boundary ignoring lane
items (they are excluded via `excludeItems: true`), or returns an explicit,
typed "anchor includes lane material" error — not a write failure.

**Impact:** the conversation-branch capability is unusable on current sessions;
clients can only show a recovery message.

## Filing checklist (Étienne)

- [x] **Designate the channel.** Done 26/09 (evening): the **public Muse Code
      SDK tracker** ([meta-models/muse-code-sdk/issues](https://github.com/meta-models/muse-code-sdk/issues))
      is the designated public surface — its tracker already carries
      host-runtime reports, and its README "Support" section welcomes SDK,
      protocol and documentation bugs plus usage questions. **All three drafts
      are filed there**: File 3 →
      [#55](https://github.com/meta-models/muse-code-sdk/issues/55) (fork),
      File 1 →
      [#56](https://github.com/meta-models/muse-code-sdk/issues/56) (approval
      ceiling), File 2 →
      [#57](https://github.com/meta-models/muse-code-sdk/issues/57) (powershell
      under the sandbox).
- [x] ~~Paste each file as one issue; keep the repro tables.~~ (done 26/09)
- [ ] Link the fix observations once available so the desktop client can re-run
      the blocked qualification variants: the M0-05 stale race and M0-06
      refused decision (#56), a **sandboxed-posture** re-proof of M0-04's
      stop-during-tool and the M1-06 "Run in Muse" flows (#57), and
      **M1-09's fork creation** (#55 — re-run
      `scripts/cdp-m1-files-fork.mjs` and the direct `fork_session` probe).
