# Native Windows evidence — group 1 (20 September 2026)

A native validation campaign driven by CUA on the real desktop application, with a native Windows Muse sidecar.

## Environment

| Element | Value |
|---|---|
| Commit | `064e210` (main) |
| Platform | Windows 10.0.26200 (x86_64), 1920×1080 @1x display |
| Application | `target\debug\muse-desktop.exe` launched by `npm run tauri -- dev` (Tauri runtime 2.11.5, WebView2) |
| Sidecar | **native Windows binary** `muse-bin-1.3.0-R3401.1.exe` copied to `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` |
| Engine version | Muse Code 1.3.0 (1.3.0-R3401.1) |
| Authentication | `%USERPROFILE%\.config\muse\auth.json` (provider `meta`) |
| Driving | cua-driver 0.28.2 (UIAutomation + Windows Graphics Capture) |
| Test workspace | `G:\repos\openscreen` (conversations) and `C:\Users\etien\Documents\repos\muse-desktop` (Automations) |

**What is new compared with all earlier evidence:** the previous validations used the WSL bridge (`muse-wsl-bridge.exe`). This campaign exercises the **native Windows Muse binary** as the sidecar, from the packaged Tauri interface in dev mode.

### Driving method (to reuse)

The WebView2 content **is not exposed** in the UI Automation tree: `get_window_state` returns only 5 elements (the window title and the system buttons). Driving is therefore done by **screenshot + coordinates**, respecting two conversions:

- `window = preview × 1.193` (the 884×1030 screenshot is reduced to a 741×863 preview);
- `screen = window + (1035, 0)` (the window sits at x=1035).

**Clicks** work with `background` delivery, but **keyboard input and shortcuts only reach the renderer in `foreground`** (SendInput). `PostMessage` is silently ignored by WebView2: the tool says so itself ("not verified — could not read the focused field back").

## What was proved

### 1. The native Windows binary is a viable sidecar (`07`, `08`)

A conversation created from the welcome screen. The application shows:

- header: `G:\repos\openscreen` · `pr620` · **`Connected`** (green pill);
- conversation header: **`Ready`**;
- a card **`Agent 740b927b-452b-49cb-afb7-731b6a33cf3f thinking…`** in **`Running`**;
- the liveness line **`Muse is working — Last update 4s ago · work item started`**;
- the sidebar goes to **`CONVERSATIONS (55, 1 WORKING)`**.

Then **a complete live model turn succeeded**: the question "Enumerate the three Musketeers by name." receives the answer **"Athos, Porthos, and Aramis."**, the sub-agents move to **`Completed`**, the pill returns to **`Ready`** and the sidebar to **`CONVERSATIONS (55)`**.

**Verdict:** the chain Tauri application → native Windows sidecar → engine → streaming → transcript works end to end. That is the prerequisite every group 1 "packaged webview" proof was missing.

### 2. Host 1.3.0 emits no terminal notification (`08`)

Immediately after the answer, the application shows **`No recent host update — No host event for 57s. Muse may still be working. Last event: work item started.`** with the actions **Sync now** / **Reconnect** / **Stop**.

The smoke harness confirms the cause on this same binary:

```json
"controls":[{"host":"A","turnId":"…","status":"interrupted","terminalNotification":"unsupported"}]
```

**Verdict:** the missing terminal is a host limit, not an application defect — and the application surfaces it honestly instead of ending the turn artificially.

### 3. Detecting a host failure (`10`, `14`)

Two hosts coexisted (`PID 47096` and `29580`, both `muse.exe serve --sandbox-network restricted`). After `Stop-Process` on `29580`:

- the application stays alive and `Responding: True`;
- **no visible change** (screenshot identical bit for bit, same SHA-256);
- no respawn.

After `Stop-Process` on the **last** host (`47096`): **0 hosts**, the application still alive and responding. Going back into a conversation, the application shows:

- a **`Disconnected`** pill (grey) instead of `Connected`;
- a **`Reconnect`** button in the header;
- the composer replaced by **"Open the desktop app to continue."** with the send button **disabled**;
- the local transcript **entirely preserved** (messages at `08:44`, Tool cards `search` and `Read text file README.md` still displayed).

**Verdict:** detection, reporting and blocking of sends are correct. A host's death causes neither a crash nor transcript loss, and no silent respawn happens.

### 4. Explicit recovery, and its honest failure (`15`)

Clicking **Reconnect** → a new host is launched (`PID 43432`, `muse.exe serve --sandbox-network restricted`). The session resume fails and the application shows an error banner built like this:

> **This conversation could not be <illegible word>. — MSP error -32020: session 01a0bd8e-… was not found [sessionNotFound] [retryable=false]. Your saved messages are still available.**

The exact word after `be` **could not be transcribed reliably**: a first copy in French ("reconnecté") contradicted the English verdict below, and the session identifier had been copied with a last group of 11 characters instead of 12. The application having been restarted since, the verbatim string can no longer be reproduced. What **is** established is the message's structure, listed below, not its word-for-word text.

The pill switches to **`Connection error`** (orange), the transcript stays displayed, sending stays blocked, and **`Reconnect` stays on offer**.

**Verdict:** that is the expected behaviour for an `ephemeral` host — the session does not exist in a durable store, so resume is impossible. The application fabricates no false success. The error copy is **in English**, bounded, and carries the code (`-32020`), the session identifier, the category (`sessionNotFound`), the `retryable=false` state and a reassuring sentence about the preserved messages: that is the shape of `userFacingError` copy M0-11 expects.

### 5. Text preserved and no send without a host (`19`, `20`)

With **zero hosts available**, from the welcome screen:

- the text stays in the composer: **"Analyze the changes and provide a code review."**;
- the button stays **`Start conversation`** (no send triggered);
- the hint stays **"Your message is sent as soon as you start."**;
- **no host is launched** by the attempt (count checked: 0).

The composer being filled by the **`Review code`** suggestion card was also observed (the click inserted the suggestion's label into the field).

**Verdict:** a non-destructive send failure and preserved text — M0-03's central property.

### 6. The native scheduler's lease is visible (`13`)

The **Automations** tab shows **`Native scheduler active — This desktop instance owns the native scheduler lease. Checked 13:47:00`** as well as `Native wake-up — Native wake-up cleared; no enabled automation is scheduled.` Navigating to that tab confirmed the application stays fully responsive after the hosts died.

## Host contract probe (`scripts/msp-probe.mjs`)

Driving the interface having proved impractical (see "Limits of the method"), a dedicated MSP probe was written to measure directly what the host does or does not expose. It speaks the protocol over stdio to a real `muse serve` and publishes only bounded facts.

```powershell
node scripts/msp-probe.mjs --surfaces --user-shell   # no model cost
node scripts/msp-probe.mjs --interrupt --live        # spends one model turn
```

**Read surfaces** (session created, no turn):

| Method | Result | Consequence |
|---|---|---|
| `session/list` | **available** | paginated restore possible |
| `approval/listPending` | **available** — shape `{approvals, userInputs}` | **corrects a roadmap claim** (see below) |
| `session/read` | unsupported | no history replay |
| `session/resume` | unsupported | durable resume impossible |
| `view/page` | unsupported | no cursor fallback |

**`session/userShell`**: `accepted` but **no `item/started`**, no `outputRef`, and the history cannot be read back. The smoke harness already waits for that notification (line 738 of `native-smoke.mjs`) and does not get it. **Returning a shell command's output to the engine is therefore not demonstrable on this host** — M1-06 stays blocked by the contract, not by the client.

**`initialize` contract**: fields returned `experimentalApi`, `grantedCapabilities`, `museHome`, `platformFamily`, `platformOs`, `schema`, `serverInfo`, `sessionDurability`, `userAgent`. `sessionDurability` is `ephemeral`. `userShell` is only granted if requested through `capabilities.requestedCapabilities`.

**Useful protocol details, absent from the repository's documentation:**

- `initialize` requires a `clientInfo.name` matching `^[a-z0-9_]+$`.
- `session/start` takes `workspaceRoot` (not `cwd`) and answers `result.session.sessionId`.
- `session/userShell` takes `commandText` (not `command`).
- `turn/interrupt` takes `commandId` **in addition to** `turnId`.
- A `turn/interrupt` on an admitted turn with no run returns `missing_run`.

**A limit the probe ran into:** a `turn/start` sent by a standalone MSP client is **accepted without any run materialising** (`turn/interrupt` answers `missing_run`, no notification beyond `session/started`). The application, for its part, gets real turns — it has the host's authentication context, which the probe does not. The "live turn" paths therefore stay out of reach of a bare MSP client.

### Correcting a roadmap claim

The roadmap stated that `session/read`, `view/page` **and** `approval/listPending` answered `methodNotFound`, based on the smoke. Direct measurement shows **`approval/listPending` is available** as soon as it is given a `sessionId`, and that it returns `{approvals, userInputs}` — it is a call **without** a `sessionId` that produces `methodNotFound`. That point deserves re-checking on the client side: the pending-request recovery card may be more capable than M0-05 assumes.

## Unblocking: driving the DOM over CDP (round 3)

The UI blocker described below was lifted by enabling WebView2's remote debugging when launching the development build:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri -- dev
```

WebView2 Runtime 153 then exposes a CDP endpoint (`Edg/153.0.4234.48`). Two tools were written:

- **`scripts/cdp-drive.mjs`** — `snapshot`, `eval`, `click`, `fill` on the real DOM. **Development instrumentation only**: it enables a WebView2 feature, it does not modify the application's code.
- **`scripts/cdp-scenario.mjs`** — a bounded acceptance scenario (`--live` to spend a model turn).

The first `snapshot` confirms `tauri: true`, access to the 40 `muse-desktop.*` keys in `localStorage`, and a `TEXTAREA` composer with its `disabled` state — that is, everything the UI Automation tree refused.

### Live scenario executed (M0-03, M0-04, M1-10, M1-13)

| Step | Observation |
|---|---|
| Filling the composer | `filled: true`, value set through the native setter + `input` |
| Submission | **`Start conversation`** button clicked (the welcome screen uses no `<form>`) |
| Turn started | `working: true`, body "Starting…", `Connected` |
| **2nd send during the turn** | queue persisted: `muse-desktop.queued-turns.v1` → `["01a0bead-d7da-7a52-910d-77f11763e84c"]` |
| **Queue UI** | the **"Queued messages — They will run in order — second turn: reply with just QUEUED-ACK — Remove from queue"** panel with the removal action visible |
| **Stop click** | **`Stopping…`** state then the **"…waiting for the desktop host to confirm it"** banner |
| After 20 s | `working: true`, **`stale: true`** — "No recent host update. Last event: work item started" |
| Queue after Stop | **emptied** (`queueKeys: []`): the host consumed the queued turn |
| Sessions | `55 → 57 → 58`, `connected: true` |

**Conclusion on M0-04:** the interrupt is requested and displayed (`Stopping…`), but **no terminal notification arrives** and the state falls back to stale. The "terminal confirmed" criterion stays blocked by the host, not the client — it is now measured, no longer inferred.

**Conclusion on M1-10:** queue admission, its persistence, its ordered display and the removal action are **all observed in the real DOM**. What stays uncovered is the proof that removing *before launch* really removes the turn on the host side.

**M1-13 measurement point confirmed:** the log does carry `data-entry-count`, `data-window-start` and `data-window-end` (here `12 / 0 / 12`). The native measurement at 2,000 entries needs a transcript of that size, which does not exist in this profile and cannot be fabricated without distorting the proof.

### A/B isolation measured within a single time window (M0-01, M0-14)

Unlike the first attempt — where a host's death observed through screenshots had produced **no** visible change, an inconclusive result — the DOM measurement within a single window gives a usable proof:

| Moment | `muse.exe` hosts | Application | DOM |
|---|---|---|---|
| Before | **2** — `46536` (13:58:33), `17820` (13:58:35) | alive | `connected: true`, 58 sessions |
| After `Stop-Process 17820` | **1** — `46536` | **alive**, `Responding: True`, same PID | `connected: true`, `disconnected: false`, **`composerDisabled: false`**, 58 sessions, queue intact |

**What that establishes:** the death of one of two simultaneous hosts does not kill the application, causes no respawn, breaks no conversation, empties neither the persisted sessions nor the queue, and leaves the composer usable.

**What it does not establish yet:** that a conversation served by the surviving host **finishes a real turn after** the other's death, with concurrent approvals. That is M0-01/M0-14's remaining exit criterion.

**A configuration limit:** the "two projects" scenario in M0-01's text is not directly reproducible in this profile — a single project (`openscreen`) is declared in `muse-desktop.projects.v1` while two workspaces coexist in the sessions (`muse-dogfood` ×54, `openscreen` ×4). The "Start in" picker therefore offers a single root. Making the second project appear would require writing into the application's state, which was ruled out so as not to distort the proof.

### A real turn starts and progresses on the surviving host (M0-01, M0-14)

The last step of the A/B scenario: after B's death, a new turn was started on the surviving host `46536` over CDP.

| Measurement | Value |
|---|---|
| Hosts before | 1 (`46536`) — B (`17820`) killed earlier |
| DOM state before sending | `connected: true`, `disconnected: false`, composer active |
| After sending + 15 s | `conn=True working=True completed=1 running=3 sessions=59` |
| After sending + 30 s | `conn=True working=True completed=3 running=1 sessions=59` |
| After sending + 90 s | `conn=True working=True completed=3 running=1 sessions=59` |
| Hosts after | 1 (`46536`) — unchanged |

**Established:** after the death of one of two hosts, the conversation served by the survivor **creates a new session (58 → 59)**, **admits a real turn**, **stays connected** and **makes its sub-agents progress** (`Completed` from 1 to 3). No respawn, no crash, no loss.

**An honest reservation:** this turn runs while only **one** host is left — so there is no longer a concurrent B to demonstrate the absence of cross-contamination *during* execution. M0-01's "concurrent approvals" criterion is not covered, and the wait for a terminal was bounded at 90 s without confirming the turn's end (the host emits no terminal notification, see above).

## M4-01/M4-02 attempt — round 6 (out of date)

This section describes an **intermediate** failure, kept for the record. It is **out of date**: both tickets were qualified in the following round, see [`docs/evidence/2026-09-20-windows-browser/M4-01-M4-02.md`](../2026-09-20-windows-browser/M4-01-M4-02.md).

What round 6 had observed, on a conversation **open but with the side panel folded**:

- the persistent state held `muse-desktop.browser.tabs.v1.session.84bb6c78`, reduced to an **empty** tab: `[{"id":"tab-f3c1a7aa…","url":"","history":[],"historyIndex":-1}]` — the panel had already been opened, but **had never navigated**;
- `muse-desktop.browser.permissions.v1` and `muse-desktop.browser.annotations.v1` were both `[]`;
- **no work bar label** was detected, and the targeted click failed (`clicked: false`); no `iframe`, no URL field.

**What explained the failure:** the work bar's tabs only exist in the DOM **once the side panel is unfolded**. The inspection was on a folded panel, hence the total absence of labels. The conclusion at the time — "interaction step not identified" — was therefore false, and the `cdp-workbar.mjs` script that followed from it was replaced by **`scripts/cdp-panel.mjs`**, which targets the control labelled **"Hide work panel"**.

## What stays open in group 1

No group 1 ticket meets **all** its exit criteria yet. The precise state:

| Ticket | Proved in this campaign | Still required |
|---|---|---|
| **M0-01** | Two simultaneous hosts; one host dying with no effect on the other or on the application | An A/B scenario **from the UI** with concurrent approvals and a turn that finishes on A after B's death |
| **M0-14** | Same as above; the complete native chain exercised | The same A/B scenario from the webview (the criterion that closes the parent) |
| **M4-01** | Native navigation (iframe mounted), per-tab persistence, isolation by `sessionId`, controls present — see the [dedicated document](../2026-09-20-windows-browser/M4-01-M4-02.md) | macOS/Linux qualification; downloads initiated by navigation |
| **M4-02** | Annotation surfaces **and** an annotation actually created (normalised URL anchor, quote, comment) | Context guard after navigation; region cropping; visual capture |
| **M0-03** | Text preserved and no send without a host; transcript preserved after a crash | Rejecting a send **with** a live host, double-click, IME, close/reload |
| **M0-04** | A stale `No recent host update` state with actions; a clean ending observed | Interrupt (`Stopping Muse`) and a confirmed terminal — **blocked by `turn/completed` missing from host 1.3.0** |
| **M0-10** | Application started and working; the recovery panel and Settings to exercise | Detection on a clean machine, WSL/auth matrices |
| **M0-11** | Title, pills, hints and **structured MSP error copy in English** in real conditions | The final checklist of secondary titles/errors |
| **M0-12** | Keyboard navigation and click confirmed; zoom already validated on 20/09 | A complete mouse-free path, a screen reader, contrast |
| **M1-10** | — | The UI queue/`unqueue` race with a live host |
| **M1-13** | — | The 2,000-entry measurement in the webview |
| **M4-01** | Native navigation (iframe mounted), per-tab persistence, isolation by `sessionId`, controls present | macOS/Linux qualification; downloads initiated by navigation |
| **M4-02** | Annotation surfaces **and** an annotation created (normalised URL anchor, quote, comment) | Context guard after navigation; region cropping; visual capture |
| **M4-09** | — | NSIS/MSI install, update, uninstall |

M4-01/M4-02 detail: [`2026-09-20-windows-browser/M4-01-M4-02.md`](../2026-09-20-windows-browser/M4-01-M4-02.md).

## Limits of the method

1. **No deterministic access to the state.** The WebView2 content not being in the UIA tree, every check goes through reading a screenshot. From this environment there is no way to read the log, the transcript or the queue in a structured way while the application runs (the profile is an `EBWebView` in dev mode).
2. **Keyboard input unreliable in an existing conversation.** Text was inserted successfully into the welcome screen's composer, but **not** into an open conversation's (placeholders unchanged, screenshots identical bit for bit). The cause is undetermined at this stage; a workaround through the clipboard and `Ctrl+V` is possible, inconclusive here because the composer of a conversation in a connection error is disabled by design.
3. **Not a clean machine.** The profile contained 54 pre-existing conversations. The "first launch" state could therefore not be tested on a blank profile.
4. **Provenance of the evidence.** The campaign was run on the historical commit `064e210`. The evidence is screenshots, and **no write to the code base** was made during the campaign. Commit `064e210` itself is an earlier merge commit that is not part of this work: it contains `docs/ROADMAP.md` in its by-axis version. The driving scripts and evidence documents added by this campaign (`scripts/cdp-*.mjs`, `scripts/msp-probe.mjs`, `docs/evidence/**`) are **not** included in `064e210` — they belong to the documentation and tooling commit that followed.

## Artefacts

The 20 screenshots referenced (`01` to `20`) are in this folder. The most significant:

- `07-conversation-ouverte.png` — session connected to the native sidecar, agent `Running`
- `08-reponse-recue.png` — live model turn finished + stale state
- `14-conversation-host-mort.png` — `Disconnected`, `Reconnect`, sending blocked, transcript preserved
- `15-apres-reconnect.png` — a structured and honest resume failure
- `20-envoi-host-mort.png` — text preserved, no send without a host

## Reproducibility

```powershell
# 1. Dependencies and the frontend artefact
npm ci
npm run build

# 2. Native sidecar (unversioned binary)
Copy-Item "$env:LOCALAPPDATA\Programs\muse\muse-bin-1.3.0-R3401.1.exe" `
          "src-tauri\binaries\muse-x86_64-pc-windows-msvc.exe" -Force

# 3. Application
npm run tauri -- dev

# 4. Transport checks (independent of the UI)
node scripts/native-smoke.mjs --exercise-control --exercise-errors --exercise-approval `
  --exercise-isolation --exercise-user-shell --exercise-reconnect --exercise-history `
  --exercise-reasoning --exercise-model --exercise-queue --exercise-compaction `
  --report smoke-win.json
```

The smoke's result on this binary: `distinctWorkspaces: true`, `sessionDurability: "ephemeral"`,
`sessionRead: "unsupported"`, `viewPage: "unsupported"`, `terminalNotification: "unsupported"`,
`userShell` accepted but `itemStarted: false` / `historyItem: false`,
`reasoningEffort` accepted but `projection: "not-reported"`,
`modelSelection` accepted but `active: false`, `compaction: "missing-run"`, queue and `turn/unqueue` accepted.
