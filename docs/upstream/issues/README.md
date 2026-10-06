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

## Follow-up of 5 October 2026 (host 1.4.2-R4684.1)

The maintainer answered on 01–02/10 and asked for a 1.4.2 re-test of #56. The re-tests were posted
on 05/10, with Étienne's approval. The measurements are in
[`docs/evidence/2026-10-05-roadmap-closure/`](../../evidence/2026-10-05-roadmap-closure/).

- **#56, approvals: answered** ([comment](https://github.com/meta-models/muse-code-sdk/issues/56#issuecomment-5999607360)).
  - The host raises approvals for a dynamic-argv write command in both `onRequest` and
    `promptUnmatched`.
  - The two-stage decide works, and so do abort, stale (`-32053`) and already-resolved (`-32051`).
  - The 1.3.0 "ceiling" reading had two causes: the probes asked for `echo`, which `onRequest`
    runs without asking, and a live-delivery bug that the maintainer says was fixed in 1.4.0.
    File 1 above is superseded.
  - **Closed by the maintainer on 05/10** ([comment](https://github.com/meta-models/muse-code-sdk/issues/56#issuecomment-6003421351)):
    fixed in 1.4.0 and later, no SDK update needed. Reopen with the version and steps if it
    comes back on 1.4.2 or later.
- **#55, fork: commented** ([comment](https://github.com/meta-models/muse-code-sdk/issues/55#issuecomment-5999607722)).
  - The defect is still present on 1.4.2 native Windows with the echo provider: `InvalidCut` with
    a cut point, `WriteFailed` without.
  - It is the same defect as [#31](https://github.com/meta-models/muse-code-sdk/issues/31), which
    the maintainer confirmed on 01/10.
  - The sub-agent-lane correlation of File 3 does not hold.
- **#88, new issue: the sandboxed shell starts in a verbatim location** ([#88](https://github.com/meta-models/muse-code-sdk/issues/88)).
  - Under `--sandbox-network restricted` on 1.4.2, the model's PowerShell starts in
    `Microsoft.PowerShell.Core\FileSystem::\\?\G:\…`, so cmdlets with relative paths fail.
  - Absolute paths, `write_file` and `--disable-sandbox` work.
  - Related: #26, the shell starting in `System32` for workspaces under the profile.
- **#57, powershell hangs under the sandbox:** the 1.3.0 hang does not reproduce on 1.4.2. Every
  turn of the 05/10 matrix reached `turn/completed`. The issue can be updated or closed when
  convenient. This has not been posted yet.
- **Not posted yet:**
  - On native Windows 1.4.2, under `--sandbox-network enabled`, HTTPS fails in the sandboxed shell
    before any handshake: Schannel has no credentials for the sandbox account (`muse-sbx-u1`,
    `SEC_E_NO_CREDENTIALS 0x8009030E`), for `Invoke-WebRequest` and `curl.exe` alike. DNS, raw TCP
    and plain HTTP work. Measured stage by stage on 06/10
    ([m0-06-junction-network-1.4.2.json](../../evidence/2026-10-05-roadmap-closure/m0-06-junction-network-1.4.2.json));
    the 05/10 reading, "no network at all", is superseded.
  - French-locale PowerShell output is mis-decoded. This one is mentioned as a side note in #88.
