# Upstream issue drafts — Muse Code host 1.3.0

Two self-contained reports, ready to paste into the Muse tracker. Both are
measurement-backed from this repository's qualification campaigns (20–27/09 and
25–26/09/2026, Windows 11 build 26200, host `muse-bin-1.3.0-R3401.1.exe`).
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

## Filing checklist (Étienne)

- [ ] **Designate the channel.** Verified 26/09/2026: there is **no public
      official Muse Code / muse-spark issue tracker** — Meta's developer
      surface is [dev.meta.ai](https://dev.meta.ai/resources/blog/build-with-muse-code)
      (blog + resources), so filing goes through the internal/support channel
      you use with the Muse team. The drafts assume GitHub-flavoured Markdown.
- [ ] Paste each file as one issue; keep the repro tables.
- [ ] Link the fix observation once available so the desktop client can re-run
      the two blocked qualification variants (M0-04 strict, M0-05 stale race).
