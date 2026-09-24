# M1-06 — Run in Muse: chain proved down to the wire, execution broken in the app context (27 September 2026)

**Three clear facts, measured today:**

1. **The `Run in Muse` chain works in the app**: the button is enabled as soon as a command is
   typed (exact reason: "Run this command through the Muse host (userShell)"), click →
   **`userShell` item published and shown in the thread within 1 s** (`Tool $ echo muse-m1-06-probe`),
   with its output in plain text. The item and its output really do reach the conversation.
2. **The host really runs commands** — but only as an external host: the
   [`msp-user-shell-items.mjs`](../../../scripts/msp-user-shell-items.mjs) probe (after `setup`) measures
   `item/started` → `item/completed` in **78 ms** with **`markerEchoed: true`** — the command
   ran.
3. **Inside the app, the same command fails**: `tool failed: environment failure: managed shell
   sandbox is unavailable`, on a **fresh** session as on a resumed one, before and after
   restarting the host.

## The root: the Windows sandbox was not installed (fixed), then a context defect

### Step 1 — missing setup (the cause of the initial failures)

```powershell
& src-tauri\target\debug\muse.exe sandbox windows check
# backend=windows_elevated status=setup_required
# diagnostic=sandbox_users_missing
# diagnostic=setup_credentials_unavailable … C:\ProgramData\muse: The specified file cannot be found

& src-tauri\target\debug\muse.exe sandbox windows setup
# backend=windows_elevated status=ready
# sandbox_users_ready=true capabilities_ready=true wfp_ready=true
```

**Lesson for M0-10:** the dogfood machine requires `muse sandbox windows setup` (elevated) before
any shell — model or user. To fold into the "first launch" path.

### Step 2 — discriminators ruled out (everything works outside the app)

The `msp-user-shell-items.mjs` probe replayed after setup, `markerEchoed: true` in **every**
configuration:

| Configuration | Result |
|---|---|
| workspace `C:\Users\etien\AppData\Local\Temp` | ✓ runs |
| workspace `G:\repos\openscreen` (the app's) | ✓ runs |
| `serve --sandbox-network restricted --trust-workspace` (the app's exact flags) | ✓ runs |
| binary `src-tauri\target\debug\muse.exe` (the app's) | ✓ runs |
| `workspaceRoot` **and** the host's cwd in `\\?\C:\…` form (the form the app sends), 22/09 | ✓ runs |

So **not** the workspace (drive `G:`), **not** `--trust-workspace`, **not** the binary. **Nor**
the `\\?\` prefix either: it diverted the app's terminal (M1-05), but the host accepts it.

### Step 3 — what remains: the spawn context from the application

- The app's host measured: PID 40172, **a child of muse-desktop.exe**, created at **15:59:46** — that is
  **after** the setup (15:57) — and the machine state stayed `status=ready` during the failures.
- The error **changed** after setup: `sandbox enforcement unavailable: windows_elevated
  setup_required` (before) → `managed shell sandbox is unavailable` (after). The host therefore sees the
  setup but its last step fails only in the app context.
- The app sets neither an environment nor `creation_flags` on the spawn (`main.rs`: no `.env(`,
  `.envs(`, `env_clear`, job object) — the host inherits the Tauri process's environment.

**Qualified finding:** a host launched **by** muse-desktop.exe cannot use the managed
sandbox; the same binary with the same flags launched from a shell works. The lead is the
spawn context (inheritance from the Tauri process / the npm→cmd chain / the token), to investigate
when fixing.

## What the error still deserves credit for

The failure is modelled and honest — the item shows:

> `tool failed: environment failure: managed shell sandbox is unavailable` —
> "The execution environment is broken: the command was never started and every later command
> will fail the same way. **Do not retry and do not fabricate command output**; report this
> environment failure."

The "environment error ≠ missing capability" contract holds right down to the message.

## M1-06 Windows verdict

- **Displaying the `userShell` item and its output in the thread: proved.**
- **"The command completes and its full output is readable": proved on an external host** (the
  post-setup probe), **blocked inside the app** by the context defect above.
- **Add output to prompt: not testable** while no command completes inside the app.
- Also remaining: live repopulation of `grantedCapabilitiesBySession` (begun: hydration on
  (re)connection proved on 27/09).

## Reproducibility

- Commit `2c11ee3`+; Windows 11 26200; `muse` sidecar/host 1.3.0 (`target\debug\muse.exe`).
- Sequence: `muse sandbox windows check|setup` → `node scripts/ux-run-in-muse.mjs --port 9222
  --click` (inside the app: fails) → `MUSE_WORKSPACE=… [MUSE_SERVE_ARGS=…] node
  scripts/msp-user-shell-items.mjs` (outside the app: succeeds, `markerEchoed: true`).
