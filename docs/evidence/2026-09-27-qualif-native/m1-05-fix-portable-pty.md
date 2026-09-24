# Round 7 — an M1-05 fix attempt + a data-loss finding on kill (27 September 2026)

## M1-05 fix: downgrading `portable-pty` 0.9.0 → 0.8.1 — build OK, UI replay outstanding

- `src-tauri/Cargo.toml`: `portable-pty = "0.8"`; `cargo update -p portable-pty` → **0.9.0 → 0.8.1**
  (nix 0.28→0.25 downgraded as a consequence).
- `cargo build`: **OK in 1 min 13 s** (3 pre-existing warnings, unrelated).
- `npm test`: **exit 0**; `npx tsc --noEmit`: **exit 0** (unchanged, the fix is Rust).
- App relaunched with the fixed binary (CDP 9222 operational).
- **Replay of the terminal scenario (`ux-terminal-state.mjs --type "echo muse-pty-fix-2026"`) not yet
  done**: blocked by a UI state after the data loss below (the "Start
  conversation" button inactive despite real typing — `scripts/cdp-type.mjs` newly added, CDP
  `Input.dispatchKeyEvent` keystrokes character by character, the reliable typing path). To pick up in round 8:
  either diagnose the button's lock, or re-create a project through the native UI.

## Finding: `taskkill /F` → projects and threads LOST (the other keys survive)

After `taskkill /F /PID 44844` then a relaunch: `muse-desktop.projects.v1` = `"[]"` and
`muse-desktop.sessions.v1` = `"[]"` — **every conversation and project wiped** — while
`schedules.v1`, `schedule-runs.v1`, `notifications.v1`, `queued-turns.v1` and so on are intact (23 keys
present). In contrast with round 6's kill (same procedure), which had **preserved** projects,
threads and the queue.

- **Cautious interpretation:** the loss is real and reproducible, not to be underestimated (a brutal
  kill can lose the `projects`/`sessions` stores); its exact cause is not established (a write
  in flight at the moment of the kill? a migration reset at startup? the WebView2 profile?). Round 6
  otherwise proves the queue survives and resumes.
- **Qualification impact:** M0-02 ("saved work survives") would deserve reopening at
  ◐ on this point: resume was proved on the queue and the runs, **not** on projects/threads in
  every kill configuration.

## Replay — PTY OUTPUT RESTORED (run2, same day)

`node scripts/ux-terminal-state.mjs --port 9222 --type "echo muse-pty-fix-2026"` then sending from
the Terminal panel, on the app relaunched with the `portable-pty 0.8.1` binary. The terminal's screen
(`.terminal-panel`, captured in `m1-05-fix-portable-pty-run2.json`):

```
Microsoft Windows [version 10.0.26200.9457] (c) Microsoft Corporation. All rights reserved.
C:\Windows>echo muse-pty-fix-2026
muse-pty-fix-2026
C:\Windows>
```

- **cmd.exe banner rendered**, command typed on a real keyboard (`scripts/cdp-type.mjs`), **output
  `muse-pty-fix-2026` displayed**, prompt returned — the PTY's complete loop works.
- **Root cause confirmed: `portable-pty 0.9.0`** (a downstream regression, see
  [turborepo#11816](https://github.com/vercel/turborepo/pull/11816)); `0.8.1` restores output
  reading without any change in `terminal.rs`.
- **Remaining for M1-05:** replay a **long interactive** command (for example `powershell` waiting
  for input) and check `Resize` visually; the core "cmd.exe opens and the text displays"
  is proved.

## Interactive round trip — proved (run3, same day)

```
C:\Windows>set /p ANS=Name?
Name? interactive-ok            ← the process was waiting; the input is delivered to it
C:\Windows>echo %ANS%
interactive-ok                  ← variable populated: the process CAPTURED the input
C:\Windows>
```

Waiting → input → captured by the process → echo: M1-05's **"working interactive input"**
acceptance is proved. Remaining: a long editor/REPL-type interactive command, visual `Resize`,
ANSI/shortcuts.

## Resize — DEFECT CONFIRMED (run4): the pane follows, the PTY ignores it

Chain tested: native window resize (`set_window_frame` 1600×1000 then 900×700) →
terminal pane → `terminal_resize` → ConPTY, measured by `mode con` at each step:

| Window | `.terminal-panel` pane | `mode con` |
|---|---|---|
| 1600×1000 | 506 × 820 | **Lines 28 · Columns 100** |
| 900×700 | **332 × 520** (follows the window) | **Lines 28 · Columns 100** (unchanged) |

The layout is responsive but **the PTY's geometry never moves**: `terminal_resize` is not
called (or ConPTY ignores it) — the historical "resize with no effect" defect is therefore **reproduced and
located**: on the app's resize call side, not on portable-pty's (output, for its part, has worked
since 0.8.1).

## ANSI SGR + Ctrl+C — proved (run5)

- **ANSI SGR:** `prompt $e[31mRED$e[32mGREEN$e[0m` (cmd, real ESC characters) → rendered **in distinct
  colours**: the `RED` span → `rgb(239,68,68)` (31m), the `GREEN` span → `rgb(34,197,94)` (32m).
  The 16-colour palette works.
- **Ctrl+C:** `ping -n 20 127.0.0.1` interrupted after ~6 replies (**no final summary of 20
  packets**), the **`^C`** mark displayed, back to the prompt. (A measurement caveat: the window must have
  focus on the terminal's input — a first attempt without focus had let the ping run to its
  end, in the interest of methodological honesty.)

## M0-02 cause found in the code: the write-through at mount persists the empty fallback

`src/hooks/useMuseSessions.ts`:

```ts
const [projects, setProjects] = useState<Project[]>(() => loadProjects());   // L1875
useEffect(() => { saveProjects(projects); }, [projects]);                    // L2381-2383
useEffect(() => { saveSessions(sessions.map(({ running: _r, ...rest }) => rest)); }, [sessions]); // L2361-2363
```

- `loadProjects()` = `read(PROJECTS_KEY, [])`: any corrupted or missing value (a kill during a
  WebView2 LevelDB write) gives **`[]` back in memory**.
- The write-through `useEffect`s run **at mount**, making no distinction between "user
  mutation" and "initial state": they **immediately persist `[]`** into `projects.v1` and
  `sessions.v1` — a transient corruption becomes a **permanent erasure**.
- That fits the observation exactly: the two keys with frequent write-through are wiped **in a
  persisted way** (present at `"[]"`), the rarely written keys (schedules, runs…) survive.

**Suggested fix:** do not write at mount (a first-mutation counter, or a double `.bak`
backup key with a generation), and never persist a fallback coming from an invalid read.

## Remaining shortcuts — SESSION BLOCKED by "Terminal unavailable" (run6)

After the kills/relaunches and rebuilding the binary, the terminal panel shows
**"Terminal unavailable — Try opening the panel again."**: neither the input nor a PTY appears,
and reopening through `scripts/ux-terminal-state.mjs` changes nothing (preconditions "conversation
displayed / panel unfolded / Terminal tab rendered" OK, then the error state). The
Ctrl+L/Tab/Escape/Ctrl+D tests are therefore **postponed**. The run1-5 evidence (output, interactive, ANSI,
Ctrl+C) comes from instances where the PTY opened and stays valid.

**Lead:** the same "the app cannot bring its shell to life" symptom as the neighbouring
M1-06 defect (`managed shell sandbox is unavailable`: a shell spawned by the app ≠ a shell spawned
from outside). `terminal_open` (Rust, `portable-pty 0.8.1`) unchanged since the successful runs — to
requalify after investigating the spawn path.

## ROOT CAUSE of the wandering cwd (run6 bis): the `\\?\` prefix passed as-is to cmd.exe

Intercepting the `terminal_*` traffic (a `window.fetch` hook, raw response) during the opening:

- `terminal_open` **succeeds** (200): `{"shell":"C:\\WINDOWS\\system32\\cmd.exe","cwd":"\\\\?\\G:\\repos\\openscreen","cols":100,"rows":28}`;
- the **first `terminal_read`** carries `cmd.exe`'s reply:

> `CMD.EXE was started with the above path as the current directory. UNC paths are not
> supported. Defaulting to Windows directory.` then the banner + prompt **`C:\Windows>`**.

**Defect:** the workspace is passed to the PTY in its `\\?\G:\…` form (the NT-DOS prefix, UNC syntax
for `cmd.exe`), which refuses it and **falls back to `C:\Windows`**. Consequences:

1. the shell is **never bound to the conversation's cwd** — an unmet M1-05 acceptance piece
   (the `C:\Windows>` prompt of every run is the visible trace of it);
2. **the same root cause** as the automations defect (`G:\…` vs `\\?\G:\…`, "recorded workspace no
   longer matches"): the `\\?\` prefix is kept where the comparison or the spawn needs the
   simple form;
3. run6's "Terminal unavailable" is a variant of that chain (a degraded initial opening).

**Expected fix:** normalise the cwd before spawning (strip the `\\?\` prefix, for example
`\\?\G:\repos\openscreen` → `G:\repos\openscreen`) in `terminal_open` — and the same normalisation
in the automations' workspace comparison.

**Fix applied (22/09/2026).** Only the PTY was affected. `std::process::Command` already strips
the prefix: a setup runner launched on a canonical path does show the worktree, not
`C:\Windows`. So `setup.rs` and `mcp.rs` are sound, and `portable-pty` passes the raw path through.

- `terminal.rs`: the shell's cwd goes through `rules::display_path` before the spawn.
  `TerminalInfo.cwd` reports the same simple form.
- Windows regression test `terminal::tests::shell_starts_in_a_canonical_workspace`: a real PTY
  on a canonical `\\?\…` folder, expecting the `<folder>>` prompt. It failed before the
  fix (`C:\Windows>` and a UNC warning), it passes after. `cargo test`: 233/233.
- **Remaining:** replay in the app. The terminal's prompt must show the conversation's workspace.

## Reproducibility

- Commit: this note + `src-tauri/Cargo.toml`/`Cargo.lock` (downgrade) + `scripts/cdp-type.mjs`.
- Commands: `cargo update -p portable-pty` + `cargo build` (`src-tauri/`), `npm test`,
  `npx tsc --noEmit`, `taskkill /F /PID 44844`, relaunch `src-tauri\target\debug\muse-desktop.exe`
  with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
- Platform: Windows 11 26200, WebView2 Edg/153, dev build.
