# M0-01 / M0-14 — A keeps going while B is open, active and **cut** (27 September 2026)

**The criterion missing on 20 September is proved in a single run:** a turn in project A
completes **with no error** — 46 s after project B's host was killed mid-turn — while B
is open and active, and its host is killed along the way.

## Protocol executed (packaged webview in dev, CDP port 9222)

1. **Project B** (`C:\Users\etien\Documents\repos\muse-desktop`): a new conversation through the
   `<details class="project-picker">`, long turn "2500-word detective story" started.
   IPC trace: `start_session` with `workspacePath: "C:\\Users\\etien\\Documents\\repos\\muse-desktop"`.
2. **Project A** (`G:\repos\openscreen`): a new conversation **in parallel**, long turn
   "Count slowly from one to five hundred" started while B streams.
   Two distinct `muse.exe serve` hosts alive: PID 36740 (A, created 15:23:18) and
   PID 47776 (B, created 15:36:29).
3. **`taskkill /F /PID 47776`** — B's host — at **15:37:24**, both turns in progress.
4. Observation of both conversations.

## Results

| Fact | Measurement |
|---|---|
| B's terminal status when its host died | **"Muse stopped because the host process ended. Reconnect to continue."** (Information, 15:37:24, to the second of the `taskkill`) |
| Turn A during/after the cut | **finished at 15:38:10** — answer received, "Fork from here" actions and the final turn's `session/read` visible, **no error**, no frozen spinner |
| A's stream behaviour | uninterrupted (the only lull observed: 47 s of model thinking, honestly announced by the liveness banner "Muse may still be working") |
| Side effect on A | **none** — no stray respawn, no corrupted conversation |

Screenshots: [`shots/m0-01-a-termine.png`](shots/m0-01-a-termine.png) (A completed),
[`shots/m0-01-b-host-mort.png`](shots/m0-01-b-host-mort.png) (B's honest status).

Completes the 20/09 campaign (`evidence/2026-09-20-windows-sessions/`) which had already measured:
two simultaneous hosts, B's death with no effect on A or on the 58 sessions, then a new session and
a real turn on the surviving host. What was missing — **"a turn finished on A while
B is still alive then cut"** — is done.

## M0-14 (reproducible checks) — state

- Reproducible CDP scenarios: `scripts/cdp-concurrent-turns.mjs` (M0-01/M0-14,
  `--live` / `--wait-kill`), `scripts/cdp-ab-projects.mjs`, `scripts/cdp-stop-terminal.mjs`
  (M0-04), `scripts/cdp-queue-race.mjs` (M1-10), plus `scripts/cdp-shot.mjs` for screenshots.
- **Remaining:** running from Windows CI, screenshots and artefacts produced by CI, pinned test
  versions (`muse-bin-1.3.0-R3401.1`). Ticket not closed.

## Reproducibility

- Commit `89654a8` (scripts) on the app at `362c8bb`+; Windows 11 26200, WebView2.
- Exact sequence: select project B → long turn → select project A → long turn →
  `taskkill` the most recent host (by `CreationDate`) → read both conversations.
- Method notes: the project picker is `<details class="project-picker-control">` +
  `button.project-option` (the old "Start in" selector in `cdp-ab-projects.mjs` no longer
  exists — the script will need adapting); both hosts have an identical `CommandLine`, only the
  creation date tells them apart.
