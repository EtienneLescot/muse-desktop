# Muse host 1.3.0 — upstream blocker drafts and the M0 decision memo

Drafted **26 September 2026**. Two behaviours of the Muse Code 1.3.0 host block M0
exit criteria on the desktop side and cannot be worked around in the client: they
must be fixed or confirmed upstream. Both reports below are ready to file — every
measurement is already recorded in this repository's evidence tree.

Status of the desktop side first: **every M0 criterion reachable from a Windows
machine is proved**, including in the packaged NSIS webview (see
[`docs/evidence/2026-09-25-m0-completion/`](../evidence/2026-09-25-m0-completion/README.md)).
The only open Windows lines are exactly the two host behaviours below, plus
resources this machine cannot provide (a macOS/Linux host, a clean machine for
M0-10, a real screen reader for M0-12, older engine builds for M0-08).

---

## Draft 1 — approval requests are never surfaced in `ask` posture (`onRequest` ceiling)

**Title:** Desktop client cannot implement approval UX: no approval request is raised
in `ask` mode, and `promptUnmatched` is the effective ceiling.

**Observed (Windows 11, host 1.3.0, two independent campaigns):**

- 20/09/2026: with the client posture mapped to `onRequest`, **no approval request
  could be provoked**, even for a turn that runs a shell tool. The client's
  `approval/listPending` (called with a `sessionId`) answers an empty set.
- 25/09/2026 (see
  [`m0-05-approval-attempt.json`](../evidence/2026-09-25-m0-completion/m0-05-approval-attempt.json)):
  a live turn was instructed to run `echo m05-approval-stamp` with its own shell
  tool while the app was in persisted `ask` posture. The tool lane rendered
  (`powershell · Print approval stamp token`) and **no approval card or event was
  ever emitted** over 90 s; `turn/interrupt` cancelled it cleanly in ~1 s.
- `session/setApprovalMode` accepts all three modes and the host reports
  `approval_mode_ceiling`; `promptUnmatched` is accepted as a posture but behaves
  as "run everything unmatched" rather than "ask".

**Expected:** in `onRequest`/ask posture, a tool call should produce a pending
approval (visible through `approval/listPending` or an event) *before* the tool
runs, so a client can render approve/deny.

**Impact on the desktop:** the approval card flow and the approval stale-race
recovery (M0-05) cannot be qualified against a real host; the ask posture
silently auto-runs tools, which is a safety-relevant gap for the product.
**Strengthened on 26/09:** with the sandbox defect worked around (`elevated`
posture, tools executing), the host **still raises no approval prompt** — the
ceiling is independent of the sandbox. (The M0-04 stop-during-tool variant was
closed in the meantime via that workaround: see
[`m0-04-strict-tool-stop.json`](../evidence/2026-09-25-m0-completion/m0-04-strict-tool-stop.json).)

## Draft 2 — the model's `powershell` tool never returns under the Windows sandbox

**Title:** `powershell` tool hangs indefinitely under `windows_elevated`; the turn
only completes with `--disable-sandbox`.

**Observed (Windows 11 26200, host 1.3.0; full matrix in
[`outil-shell-bloque-sandbox.md`](../evidence/2026-09-21-ux/outil-shell-bloque-sandbox.md)):**

| Host | Sandbox | Result |
|---|---|---|
| started by the app | `--sandbox-network restricted` | `toolCall` `inProgress` for 10 min, then `tool timed out` |
| external probe | `--sandbox-network restricted` | no terminal in 90 s |
| external probe | `--sandbox-network enabled` | no terminal in 90 s |
| external probe | `--disable-sandbox` | **completed in 1 s**, output correct |

No `powershell` process is ever created under the host: the tool blocks before
launching the shell. The client's own `session/userShell` runs fine under the same
sandbox, so the defect is specific to the model's shell tool path. Additionally,
on a fresh machine every `userShell` fails with `sandbox_users_missing` until an
elevated `muse sandbox windows setup` has been run — first-launch guidance must
surface that prerequisite (recorded in
[`m1-06-run-in-muse-sandbox.md`](../evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)).

**Impact on the desktop:** with a sandboxed host, model shell work is impossible
(M0-04's stop-during-tool variant, M0-05 approval flows, M1-06 "Run in Muse"
host-side execution). Today's client-side workaround is to document
`--disable-sandbox` postures, which weakens the safety story.

## Draft 3 — `session/fork` fails on every session that carries sub-agent lanes

**Title:** `session/fork` answers `forkBoundaryInvalid WriteFailed` on sessions
with sub-agent ("child session") lanes, including fresh ones.

**Environment:** Windows 11 (26200), host 1.3.0
(`muse-bin-1.3.0-R3401.1.exe`), measured 26/09/2026 both through a desktop
client and via a direct `session/fork` request.

**Steps to reproduce:**
1. Run any turn that spawned a `Reminder child session` lane (most turns now do).
2. Call `session/fork` on the session — with a `cutPoint.lastTurnId` anchor or
   without one.

**Actual:** the host answers `MSP error -32023: invalid fork boundary …
WriteFailed [forkBoundaryInvalid] [retryable=false]` for **every** anchor —
including the latest completed turn and anchorless requests. A fresh two-turn
session with a reminder lane refuses exactly the same way; a fresh one-turn
session **without** a lane forked fine on 20/09. The client's per-anchor and
anchorless requests are well-formed (the same shapes forked on 20/09).

**Expected:** `session/fork` should either branch at the requested boundary
ignoring lane items (they are excluded via `excludeItems: true`), or return an
explicit, typed "anchor includes lane material" error — not a write failure.

**Impact on the desktop:** the conversation-branch feature cannot create
branches on current sessions; the client shows the recovery copy and stays
alive, but the MSP capability is unusable (M1-09's creation piece).

---

## Decision memo — what each remaining blocker needs

| Blocker | Tickets held | What unblocks it | Cost |
|---|---|---|---|
| No macOS / Linux machine | macOS/Linux columns of every M0 ticket (mostly ☐/◐) | A Mac for one qualification session per campaign (WKWebView + Keychain + launchd); a Linux box for the same | Hardware + a session each |
| Clean machine | M0-10 (first launch), part of M4-09 | A Windows VM or fresh user profile with no Muse/WSL history, plus a real sign-in path | A VM + credentials |
| Screen reader | M0-12 (the decisive half) | One NVDA (Windows) session driven through the a11y scenarios; contrast/forced-colors are already proved | A session + NVDA (free) |
| Host 1.3.0 behaviours | M0-05 (stale race), M0-06 (refused decision), M1-09 (fork creation) | Filing Drafts 1, 2 and 3 upstream; until fixed, those criteria stay host-blocked and statuses stay ◐. M0-04 is **no longer held**: its strict stop-during-tool variant was proved on 26/09 under the elevated (`--disable-sandbox`) posture ([m0-04-strict-tool-stop.json](../evidence/2026-09-25-m0-completion/m0-04-strict-tool-stop.json), Windows ☑) — but the Draft-2 sandbox defect itself stands: under a sandboxed posture model shell work still hangs, so a sandboxed-posture re-proof of M0-04 and the M0-05 flows wait on the upstream fix | Filing + waiting for a host release |
| Older engine builds | M0-08 (version matrix) | Access to previous Muse CLI builds (1.2.x, …) | Archive access |

Everything else in M0 is proved on Windows, dev and packaged
([campaign report](../evidence/2026-09-25-m0-completion/README.md)).
