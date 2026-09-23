# Sidecar placeholder: `muse`

The V1 backend is the `muse` CLI packaged as a Tauri sidecar (one binary
per target triple). Tauri resolves `externalBin: ["binaries/muse"]` from
`tauri.conf.json` by appending the target triple at bundle time, so drop
the real binaries here as:

- `binaries/muse-x86_64-pc-windows-msvc.exe` (Windows x64)
- `binaries/muse-aarch64-pc-windows-msvc.exe` (Windows ARM64, optional V1)

Linux is an explicit V1 non-goal: no `*-unknown-linux-gnu` binary is bundled.

The Rust supervisor (`src/main.rs`, `resolve_sidecar`) invokes the sidecar
without any PATH dependency, with `cwd` locked to the user-selected
workspace root. Resolution order: `<app-exe-dir>/binaries/muse-<triple>`
(bundled layout), then `<src-tauri>/binaries/muse-<triple>` (dev source
tree). For local dev, drop the binary matching your host triple here (e.g.
copy the installed backend); these files are gitignored. Until a binary
lands, `spawn` fails and the UI surfaces the "sidecar missing" error path
(step 6 of the plan).

## macOS

macOS bundles **no** sidecar (`tauri.macos.conf.json` sets `externalBin: []`).
The app uses the user's Muse CLI, installed by Meta's official installer
(`curl -fsSL https://dev.meta.ai/install.sh | bash` → `~/.local/bin/muse`,
self-updating). On first launch the app offers to run that installer itself.
Resolution order: `~/.local/bin/muse`, `muse` on PATH, then
`binaries/muse-<triple>` here (dev only — stage a fixture with
`sh scripts/build-macos.sh --dev-sidecar PATH`).
