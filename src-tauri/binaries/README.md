# Dev engine: `muse`

No build bundles the Muse engine (no `externalBin`). The app uses the Muse
Code the user installed with Meta's official installer, and this folder only
holds a **dev** engine (fixtures, local engine builds), gitignored, named
with the target triple:

- `binaries/muse-x86_64-pc-windows-msvc.exe` (Windows x64)
- `binaries/muse-aarch64-apple-darwin` (macOS, stage it with
  `sh scripts/build-macos.sh --dev-sidecar PATH`)

Linux is an explicit V1 non-goal.

The Rust supervisor (`src/main.rs`, `resolve_sidecar`) hands the plugin an
absolute path, with `cwd` locked to the user-selected workspace root. When
nothing is found, the error starts with `sidecar binary not found` and the UI
shows the first-run setup screen.

## Windows

Install: `irm https://dev.meta.ai/install.ps1 | iex` in PowerShell, then
`muse login`. The installer puts a self-updating launcher (`muse.cmd`) in
`%LOCALAPPDATA%\Programs\muse`; the launcher downloads the engine beside it
as `muse-bin-<version>.exe` and records the version in `.muse-version`.

Resolution order: `muse-bin-<.muse-version>.exe` there, else the newest
`muse-bin-*.exe` there, then `binaries/muse-<triple>.exe` here. The app runs
the engine directly, never the launcher, with `MUSE_NO_AUTO_UPDATE=1`: it
never installs or updates Muse. The Store build is an MSIX package, whose
AppData writes are redirected into its private store. When Muse is missing,
the setup screen shows the install command and `muse login`; running `muse`
in a terminal updates the engine.

## macOS

The app uses the user's Muse CLI, installed by Meta's official installer
(`curl -fsSL https://dev.meta.ai/install.sh | bash` → `~/.local/bin/muse`,
self-updating). On first launch the app offers to run that installer itself.
Resolution order: `~/.local/bin/muse`, `muse` on PATH, then
`binaries/muse-<triple>` here.
