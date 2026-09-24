# M1-05 — Interactive PTY: the output never comes back (27 September 2026)

**Finding: the terminal's interactive cycle does not work on real Windows.** Writing is
accepted, the child shell runs, but **not a single output byte ever comes back** — not even
`cmd.exe`'s startup banner. A reproducible defect, measured down to the IPC wire.

## Measurement (packaged webview in dev, CDP 9222 — Terminal panel)

Prerequisites met (`scripts/ux-terminal-state.mjs --port 9222 --type "echo MUSE_PTY_MARK_27"`):

```
session    : …
command    : "echo MUSE_PTY_MARK_27"
Run in Muse: disabled=false
reason     : Run this command through the Muse host (userShell)
props      : {"canRunThroughMuse":true,"sessionId":"01a0c95f-…"}
```

Then, on the IPC wire (`window.fetch` trace):

| Fact | Measurement |
|---|---|
| `terminal_open` | ✓ PTY opened (`term-5d56db6c-…`), meta "`C:\WINDOWS\system32\cmd.exe · \\?\G:\repos\openscreen`", size 100×28 |
| Child shell | ✓ **PID 47560 `cmd.exe`, a direct child of muse-desktop.exe** (created 15:50:35) |
| ConPTY pump | ✓ **`conhost.exe` PID 31468**, child of muse-desktop.exe (same moment) |
| `terminal_write` | ✓ accepted ×2 — `{"input":"echo MUSE_PTY_MARK_27\\r"}`, `{"input":"echo MUSE_PTY_MARK_28\\r"}` (`write_all` + `flush` in `terminal.rs`) |
| `terminal_read` | ✗ **~700 consecutive reads: `{"output":"","done":false}` every time** |
| `cmd.exe` startup banner | ✗ **never received** (independent of any write) |
| Resize (ConPTY poke) | ✗ `terminal_resize` 100→110 columns: output still empty |
| UI side | ✗ `.terminal-output` stays on "Connected. Type a command below." |

A constant `done: false` = the reader thread (`muse-terminal-reader`) is alive and **blocked in
`reader.read()`**; the ConPTY output pipe delivers nothing.

## What is ruled out (differential diagnosis)

- **Application wiring: correct.** `src-tauri/src/terminal.rs` follows the canonical pattern
  `openpty → spawn_command → drop(slave) → try_clone_reader → take_writer → reader thread`;
  `write()` does `write_all + flush`; `OutputBuffer::append/drain` is covered by green Rust
  tests (`cargo test`: bounding and drain).
- **Silent spawn failure: ruled out** — `cmd.exe` **and** `conhost.exe` are alive.
- **Input problem: ruled out** — the startup banner alone should appear with no input.
- **The ConPTY "flush after resize" quirk: ruled out** — a real resize changes nothing.

## Root-cause lead (external, corroborating)

The `Cargo.lock` pins **`portable-pty 0.9.0`** — the exact version a turborepo fix describes as
introducing a **Windows TUI hang from ConPTY changes**:
[vercel/turborepo#11816 — "Resolve Windows TUI hang caused by portable-pty 0.9.0 ConPTY changes"](https://github.com/vercel/turborepo/pull/11816).
See also [wezterm/wezterm#1396](https://github.com/wezterm/wezterm/issues/1396) and
[wezterm/wezterm#7025](https://github.com/wezterm/wezterm/issues/7025) for `portable-pty`'s
behaviour on Windows.

**Proposed remediation:** try `portable-pty 0.8.x` (or the fixed version turborepo uses) then
replay exactly this scenario; the benchmark entry point is pinned here.

## M1-05 Windows verdict

**Not closed — and the ticket has a real defect, not merely missing proof.** What works:
opening the PTY, a real shell bound to the cwd, lossless writing, resize, controlled close, states and
reasons displayed ("Run this command through the Muse host (userShell)"). What does not work:
**all of the output**, so interactivity, ANSI rendering and shortcuts cannot be
qualified as things stand.

## Reproducibility

- Commit `2c11ee3`; Windows 11 26200, WebView2; sidecar `muse-bin-1.3.0-R3401.1`.
- Sequence: `node scripts/ux-terminal-state.mjs --port 9222 --type "echo …"` → submit through
  `.terminal-input button[type=submit]` → read `terminal_read` (`window.fetch` trace).
- Env: Windows 11 build 26200; crate pinned at `portable-pty 0.9.0`.
