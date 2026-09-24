# The model's `powershell` tool never returns under the Windows sandbox

**Measured on 23/09/2026** on Windows 11, with the Muse 1.3 sidecar (`target/debug/muse.exe`).
`muse sandbox windows check` → `backend=windows_elevated status=ready`, users, capabilities and
WFP ready.

## Finding

A turn asking the model to run `Get-ChildItem -Name` with its `powershell` tool:

| Host | Posture | Result |
|---|---|---|
| started by the app, demo-calc project | `--sandbox-network restricted` | `toolCall` `inProgress` for 10 min then `tool timed out` |
| external (`probe-shell-turn.mjs`), demo-calc folder | `--sandbox-network restricted` | no terminal in 90 s |
| external, neutral temporary folder | `--sandbox-network restricted` | no terminal in 90 s |
| external, same folder | `--sandbox-network enabled` | no terminal in 90 s |
| external, same folder | `--disable-sandbox` | `completed` in **1 s**, output `a.txt`, turn finished |

No `powershell` process is created under the host: the tool blocks before launching the shell.
The composer's `session/userShell`, for its part, runs under the same sandbox (probe
`msp-user-shell-items.mjs`): only the model's `powershell` tool is affected.

**Consequence**: in the default posture, Muse can neither run a command nor execute tests
from the app. File tools (read, search, edit, write) work: on the same turn, after the timeout, the
model modified `math.js` and created `math.test.js`.

## On the app side (fixed on 23/09)

- **Invisible tool calls**: a `toolCall` item appeared as an empty assistant message
  ("thinking…" for the whole block). It becomes a tool row named by its summary
  (`powershell · List workspace file names`), marked "running…" while it runs, then
  foldable with its output (`visibleOutput`) at the end.
- **Stopping**: `turn/interrupt` cancels the stuck tool in 1 s and the host emits the
  `cancelled` terminal (probe `probe-interrupt.mjs`, and replayed in the app). The thread now shows
  "Stopped".
- **An unreproduced observation**: a Stop after 4 min of blocking put the app back to "Ready",
  but the host recorded no interrupt and the turn continued to the timeout, then edited the files.
  Two replays with a 20 s wait stopped cleanly.

## Remaining

- **Host bug** (`windows_elevated` sandbox + `powershell` tool) to report to Muse. Today's workaround:
  the `elevated` posture (global "elevated" and project `full`), which disables the sandbox.
- Replay a Stop after several minutes of blocking to settle the observation above.
