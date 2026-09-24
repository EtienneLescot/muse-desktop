# M0-04 — Stop → terminal, with a trace of the `turnId` transmitted (27 September 2026)

**Workstream 5 of the [20 September client plan](../../plans/2026-09-20-travail-client-restant.md) is settled.** The
question was: "reproduce the stop from the interface and check the `turnId` actually
transmitted". The answer, measured on the real IPC wire: **the `turnId` is transmitted, non-empty, and the
Stop state resolves in ~1 s.** The frozen `Stopping…` of the 20/09 campaign **does not reproduce** at
HEAD (`362c8bb`).

## The measurement

```powershell
node scripts/cdp-stop-terminal.mjs
```

A complete scenario from the webview: new conversation → long turn admitted → **the interface's Stop
button** → observing the resolution → **relaunch** ("resume").

| Fact | Measurement |
|---|---|
| `turnId` observed on the wire | **yes** (`send_input` → the turn's `turnId`) |
| Stop button clicked | **yes** (the "Stop" button on the composer row in the working state) |
| `cancel_session` calls | **2/2 with a non-empty `turnId`** |
| Resolution of the Stop state | **1,006 ms** after the click |
| Relaunch after stopping | **yes** — the next turn starts (`stream-health-working`, "work item started") |

The IPC trace that settles it (the running session's identifiers):

```json
{ "cmd": "cancel_session",
  "payload": { "sessionId": "01a0c947-b83b-7032-9298-fe305b3eab42",
               "turnId": "01a0c947-ba9b-7349-8cc5-98420f17f846" },
  "result": "null" }
```

`turnId` = the turn identifier announced by `send_input` — **the renderer transmits the right
identifier, non-empty**. The `null` acknowledgement is the admission ("admission only"), then the server
terminal `turn/completed` — established by [`msp-interrupt-notifications.mjs`](session-log-expique-tout.md)
at **+36 ms** — takes the interface out of the Stop state.

## The client plan's three possibilities, settled

| Hypothesis (workstream 5) | Verdict |
|---|---|
| 1. the renderer does not call `interrupt_session` with a non-empty `turnId` | **disproved** — `turnId` present and correct on every call |
| 2. the terminal arrives but is not associated with the right turn on the client side | **disproved** — UI resolution in ~1 s |
| 3. the interface observation dated from a different state | **the most likely** — see below |

**On point 3:** the original observation clicked a **disabled** button whose `title` contained
"stop it first" (a sub-agent lane control), and another attempt rejected the real button **because
of its title** — the turn's Stop button carries the misleading title
**`"Stop the running sidecar"`**. That title is a remaining label defect (the button stops the
**turn**, not the sidecar), to fix on the interface side.

## Two method defects that nearly produced a false finding

Recorded so as not to repeat them:

1. **`__TAURI_INTERNALS__.invoke` cannot be patched** (a Proxy that returns the old `invoke`) and
   **`chrome.webview.postMessage` is not the transport path** (0 frames). This build's real IPC
   transport is **`window.fetch`** — each invoke is a fetch whose URL carries the
   command (`http://ipc.localhost/{cmd}`) and whose body carries the arguments. Measured: 153 calls in 65 s
   of ordinary traffic, including the `poll_events` polls (`{"since":N}`).
2. The turn's Stop button **only appears in the working state**, 1 to 3 s after
   `send_input`'s acknowledgement; a click at +2.4 s finds nothing. The button has to be **awaited**.

## Liveness behaviour observed (honest, worth knowing)

While the model is thinking (before the first text delta), the banner switches to
`stream-health-stalled`: **"No recent host update — No host event for 47s. Muse may still be
working. Last event: work item started."**, then returns to "response update" at the first
delta. That is **not** a stream bug: the model was silent for 47 s. The label stays
calm and honest ("Muse may still be working").

## Terminal states when the process death is known

See [`m0-02-reprise-apres-mort-host.md`](m0-02-reprise-apres-mort-host.md): the status
"Muse stopped because the host process ended. Reconnect to continue." is honest and actionable.

## Complement: the "request accepted" / "terminal confirmed" distinction captured live

The "tool" run (`cdp-stop-terminal-outil-run1.json`, `MUSE_STOP_AFTER_MS=20000`) — the exact UI state
at the moment of the Stop click:

```json
{ "stopping": true, "stoppingBanner": true,
  "healthClass": "stream-health stream-health-stopping",
  "healthText": "Stopping Muse The stop request was accepted; waiting for the desktop host to confirm it." }
```

→ then resolution in **1,018 ms**, `cancel_session` with the right `turnId` (the 3rd consecutive
conforming call). The "`Stopping Muse` stays an accepted request until the terminal is
confirmed" criterion is therefore **proved with its exact label**.

**Environment finding (M1-05/M0-10):** the model's *user* shell (an internal tool) is
refused in this configuration: the output stream reports "enforcement unavailable:
windows_elevated setup_required: sandbox users are not ready". The "stop during a tool" phase
could therefore not be played with a long model tool; it remains to be replayed with **Run in Muse**
(`session/userShell`, which does work — see M1-06) as the long tool.

## Special phases played on 27/09/2026 (continued) — three out of four closed

All through `scripts/cdp-stop-terminal.mjs` (`MUSE_STOP_AFTER_MS` to target the phase,
`--followup` to prove the relaunch); raw reports `cdp-stop-avant-token-run1.json`,
`cdp-stop-reponse-tardive-run1.json` and `cdp-stop-reponse-tardive-run2.json`.

### Before the first token — proved (`MUSE_STOP_AFTER_MS=1500`)

A long-planning prompt ("plan a 2500-word essay … then reply PLANNED"); stop at +1.5 s,
**before any output** (`uiBeforeStop.healthText: null` — the stream row has no
state yet; the next turn's `reasoning update` state is visible in `uiAfterFollowup`).

```
verdict: {"turnIdObservedOnWire":true,"stopClicked":true,
          "cancelCarriedTurnId":[true,true,true,true],
          "stoppingResolved":true,"resolvedAtMs":1018}
```

- `cancel_session` carries the turn's **`turnId`** from the pre-token phase onwards.
- The **accepted** banner captured live (`uiObservations[0]`, +2 ms after the click):
  "Stopping Muse — The stop request was accepted; waiting for the desktop host to confirm it."
- **Terminal resolution in 1.0 s** then an **immediate, working relaunch** (`uiAfterFollowup`:
  `Muse is working … · reasoning update.`).

### Late answer — proved (`MUSE_STOP_AFTER_MS=45000`)

A very long prompt ("3000-word technical analysis …"); at **+45 s** the turn is **still alive**
(Stop button present, clicked):

```
verdict: {"turnIdObservedOnWire":true,"stopClicked":true,
          "cancelCarriedTurnId":[true,true,true,true,true,true],
          "stoppingResolved":true,"resolvedAtMs":1016}
```

Acceptance with the same label (captured live), `turnId` transmitted, **resolution in 1.0 s**, relaunch
OK. The liveness behaviour ("No recent host update… Muse may still be working") stays the
honest marker of that window.

### After the answer ends — proved (`MUSE_STOP_AFTER_MS=60000`, answer already finished)

`cdp-stop-reponse-tardive-run1.json`: at +60 s the answer had long finished —
**no Stop button exists any more** (`stopClicked: false`), the UI is at rest
(`uiBeforeStop.healthText: null`), and the next turn (`--followup`) starts immediately.
The UI does not offer to stop what has already finished and nothing breaks.

### During a tool — variant measured: stopping during a running sub-agent lane

On this model (muse-spark), tool work (searches) is **offloaded to sub-agents**: there is
no tool row on the parent turn. On the evening of 27/09, a Stop was triggered at the moment a
`msg subagent subagent-running` lane was **"thinking… Running"** (tool work in flight in
the child session): `cancel_session` carrying the `turnId` ×2, the parent turn resolved (no more Stop
button), lanes closed at `subagent-completed`. That is the "work in progress interrupted" phase, proved.

**The strict variant is not reachable as things stand:** a tool call executed by the parent turn itself
— searches systematically go to sub-agents ("Do NOT use subagents" is not followed),
and the shell tool is blocked by the environment defect (M1-06). The parent tool row remains to
be stopped in an environment where the model's tools run directly.

**Bonus note:** during these attempts, a `msg subagent subagent-complete` sub-agent lane with
a `childSessionId` and states `subagent-running` → `subagent-completed` was observed live
(consolidating M2-07).

## Reproducibility

- Commit: `362c8bb` (main), `target\debug\muse-desktop.exe` through `npm run tauri -- dev`.
- Platform: Windows 11 (10.0.26200), WebView2, sidecar `muse-bin-1.3.0-R3401.1`.
- Script: `scripts/cdp-stop-terminal.mjs` (screenshots in `shots/m0-04-*.png`).
- Raw output: `cdp-stop-terminal-run6.json` (the verdict above), `cdp-stop-terminal-run4.json`
  (a trace of the call shapes).

**M0-04 Windows verdict:** "Stop resolved by a server terminal" is **proved mid-answer**
with the `turnId` transmitted and the resume proved. **Phases closed on 27/09: before the first
token, late answer, after the end** (above). The **during a tool** phase remains, blocked
by the environment defect documented in [`m1-06-run-in-muse-sandbox.md`](m1-06-run-in-muse-sandbox.md).
