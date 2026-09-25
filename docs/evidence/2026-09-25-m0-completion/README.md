# M0 completion campaign — native Windows replay (25–26 September 2026)

**Platform:** Windows 11 (build 26200) · native Tauri app (`http://tauri.localhost/`, WebView2,
CDP 9222) · frontend embedded in `src-tauri	arget\debug\muse-desktop.exe` (`npm run build` +
`cargo build` at commit `97f9eb1` + the M0-08 fix below) · real Muse sidecar 1.3.0
(`muse-x86_64-pc-windows-msvc.exe`, 415 MB) · live model turns on every scenario that needed one.

**Objective:** drive every remaining M0 criterion that is reachable on this machine. The
macOS/Linux columns stay structurally out of reach (no native machine for the webview, no
screen reader, no clean machine) — nothing was raised on those columns.

## Result table (all CDP-driven, in the real webview)

| Ticket | Scenario | Result |
|---|---|---|
| **M0-02** | draft typed without sending → `taskkill /F /PID` → relaunch → reopen conversation | **PASS** — `muse-desktop.draft.<id>` survived in **localStorage** (the sessionStorage key died with the webview); the composer restored the exact draft `M0-02-DRAFT-DOIT-SURVIVRE-AU-KILL-25SEP`. The last open Windows piece of M0-02 is closed. |
| **M0-04** | live turn → Stop → follow-up turn (`cdp-stop-terminal-run1.json`) | **PASS** — `turnId` observed on the wire, `cancel_session` carried it (2/2 calls), `Stopping…` resolved in **1 023 ms**, immediate follow-up accepted. Stop-button title now reads "Stop the current turn" (label defect closed; harness keeps the old title as fallback). |
| **M0-01 / M0-14** | two **fresh** sessions, two workspaces, concurrent live turns (`m0-01-ab-fresh-sessions.json`) | **PASS** — A (project `muse-desktop`, `C:\…\muse-desktop`) completed "ISOLATED" at 23:54:54 while B (`G:
epos\openscreen`) was still running; B completed "BETA"; transcripts intact, no stale, no cross-talk. The interface-side remaining criterion is met; the **packaged** webview repetition is still open. |
| **M0-06** | posture YOLO → Ask → on-my-behalf via the picker; fetch-hook wire trace; `taskkill /F` + relaunch (`m0-06-posture.json`) | **PASS** (both first criteria natively) — `set_approval_mode:ask` propagated to **all 10 connected sessions without restart**; posture persisted across the kill (`ask` + "Ask for approval"). The refused/stale decision replay stays open (host ceiling `promptUnmatched`, see M0-05). |
| **M0-07** | `/definitelynotaskill …` sent to a live host (`cdp-unknown-skill-reject-run1.json`) | **PASS** — structured, actionable engine error in the transcript ("unknown skill /definitelynotaskill … install or enable it first"), composer text preserved, no crash, no raw wire dump. |
| **M0-09** | corruption sweep over **9 persistence keys** (`m0-09-corruption-sweep.json`) | **PASS with one documented limit** — app never crashed; `projects.v1` corrupted value **never overwritten** (fix holds); `sessions.v1` rebuilt from the host's durable history; `schedule-runs.v1` rebuilt from the native ledger; Settings rendered "Local data needs attention / Corrupted data (…)" natively. Limit: localStorage-only join tables (`thread-projects.v1`, `connectors.v1`, `memory.v1`) reset to `[]` on the first post-boot mutation — the one real (small) loss, now documented. |
| **M0-11** | `cdp-language-audit.mjs` on the live app (`cdp-language-audit-run1.json`) | done — UI chrome English; French hits are user-typed conversation titles (content, not labels). |
| **M0-13** | Settings capability surfaces (`m0-13-capability-badges.json`) | done — "Granted … only through the granted tools", "Observe only … 19 tools", "Local" rendered natively. |
| **M0-05** | ask posture + live turn demanding a self-run shell command (`m0-05-approval-attempt.json`) | **host-blocked** — the tool lane rendered ("powershell · Print approval stamp token") but **no approval card is provokable** on host 1.3.0 (ceiling `promptUnmatched`, shell tool sandboxed) — matches 20/09; status not raised. Stop resolved the stuck turn cleanly. |
| **M0-08** | incompatible engines swapped in (`m0-08-incompatible-engine.json`) | **measured + fixed** — see below. |
| **M0-10** | clean machine | **not reachable here** (the machine has Muse, WSL and 34+ conversations; no second clean box) — stays open. |
| **M0-12** | real screen reader | **not reachable here** (no assistive technology in this session) — stays open. |

## M0-08 — a real gap found and fixed in this campaign

With an engine that does not speak MSP (`cmd.exe`: never answers; `hostname.exe`: exits at
once), the app never crashed, detection was bounded ("Connecting" → "Disconnected" ≤ ~90 s)
and a **Reconnect** action was offered — but the actionable supervisor error
(`"MSP handshake failed (sidecar dropped the response)"`) reached only the console on the
silent boot resume, or a banner after an explicit click. **Fix (this session):**
`connectionNoticeBySession` — the silent catch now records a bounded (220 chars) reason per
conversation and the connection pill carries it as its tooltip; a successful connection
clears it; no banner is added to the silent path. Validated natively with both fake engines
(pill title = `"MSP handshake failed (sidecar dropped the response). Host stderr: "`) and
restoration (real 1.3.0 → "Connected", notice cleared).

Method note: `cargo build` re-copies `src-tauri/binaries/muse-*` over `target/debug/muse.exe`
— an incompatible-engine test must place the fake **after** the last build. The first swap
of `src-tauri/binaries/` had no effect on the running debug app (it launches the `target/debug`
copy) and one restore mishap deleted the 415 MB real binary from `binaries/` — restored
byte-identical from `target/debug/muse.exe` (same sha256 `e0a7cfef…`) before anything else ran.

## Packaged (NSIS) webview — the last Windows-reachable criterion (26/09/2026)

`npm run build:windows` produced `Muse-Desktop_0.1.0_x64-setup.exe`
(sha256 `cf047c05…`, release manifest generated **and verified**). Silent install
(`/S`) into `C:\Users\etien\AppData\Local\Muse-Desktop\`, then the three proven
scenarios were re-driven through CDP in the **installed** app:

| Scenario | Result |
|---|---|
| **M0-04 stop** (`cdp-stop-terminal-packaged-run5.json`) | PASS — single `cancel_session` carrying the correct `turnId`, `Stopping…` resolved in **1 009 ms**, immediate follow-up accepted, Stop title "Stop the current turn". |
| **M0-01 / M0-14 A/B** (`cdp-ab-projects-packaged-run3.json`) | PASS — turn A started in project `muse-desktop` (second host), turn B concurrently in openscreen; A completed "ISOLATED" while B ran; B completed "BETA"; isolation intact. |
| **M0-11 labels** (`cdp-language-audit-packaged-run2.json`) | PASS — chrome English on 7 surfaces; French hits are user content / heuristic false positives ("plus" in English copy). |

Two methodological traps recorded so they are not repeated:

1. **The first silent install got stuck** and the tests then ran against the
   **old 0.0.9 install** (exe mtime 20/09). Detected because the packaged Stop
   run still showed the old "Stop the running sidecar" title — a stale-build
   smell in a *packaged* artifact. Discard and re-install before measuring;
   verify the installed exe's size/mtime against `target/release`.
2. **The IPC trace hook accumulates** across harness runs on a living page:
   a fresh `location.reload()` before a measured run keeps `cancelCalls`
   pointing at *this* run's clicks only.

Also fixed here: the A/B harness now handles both picker implementations
(start-in `<select>` when a project exists; `details.project-picker-control`
otherwise) and clicks Start via the aria-label fallback; the stop harness
settles 1.5 s after observing the turn so the click cannot outrun the
renderer's turnId storage (a +2.09 s click measurably sent `cancel_session`
without a turnId; at +3.6 s it carries — the no-turnId path still resolved
honestly in ~1 s, the designed bounded fallback).

**With this pass, the packaged-webview criterion of M0-01, M0-11 and M0-14 is
closed on Windows. M0-01's and M0-11's Windows columns are raised to ☑ in the
roadmap.**

## What still blocks full M0 closure (honest list)

1. **macOS / Linux native proofs for every M0 ticket** — no machine here runs WKWebView/WebKitGTK; those columns cannot move from this repository alone.
2. **M0-01**: the packaged (release/NSIS) webview repetition of the A/B scenario — dev build only today.
3. **M0-04**: the strict "stop during a parent-turn tool" variant — unreachable on host 1.3.0 (tool work offloaded to sub-agents; shell tool sandbox-blocked), unchanged from 27/09.
4. **M0-05**: the approval stale-race — host-blocked (no approval card provokable), unchanged.
5. **M0-06**: the refused/stale posture decision — same host ceiling.
6. **M0-08**: the engine-version matrix (older hosts) — only 1.3.0 exists here.
7. **M0-10**: a genuinely clean machine and a real first-launch authentication path.
8. **M0-12**: a real screen reader (NVDA/JAWS), plus macOS/Linux contrast and keyboard passes.

## Reproducibility

```
npm run build && cargo build --manifest-path src-tauri/Cargo.toml
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222   ./src-tauri/target/debug/muse-desktop.exe
node scripts/cdp-stop-terminal.mjs --observe-ms 60000
node scripts/cdp-ab-projects.mjs --live --declare     # harness needs the picker fix below
node scripts/cdp-unknown-skill-reject.mjs
node scripts/cdp-language-audit.mjs
```

Harness repairs shipped with this campaign: `cdp-stop-terminal.mjs` start-button selector
(welcome screen button is `button.welcome-send` with aria-label "Start conversation"; the
Stop title fallback now accepts both old and new titles). The A/B harness still expects the
pre-rework "start-in" `<select>` — the second project was driven through the reworked
project picker by hand during the measured run (declared: `muse-desktop`).
