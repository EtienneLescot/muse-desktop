# Sidecar placeholder: `muse`

The V1 backend is the `muse` CLI packaged as a Tauri sidecar (one binary
per target triple). Tauri resolves `externalBin: ["binaries/muse"]` from
`tauri.conf.json` by appending the target triple at bundle time, so drop
the real binaries here as:

- `binaries/muse-x86_64-pc-windows-msvc.exe` (Windows x64)
- `binaries/muse-aarch64-pc-windows-msvc.exe` (Windows ARM64, optional V1)
- `binaries/muse-x86_64-apple-darwin` (macOS Intel)
- `binaries/muse-aarch64-apple-darwin` (macOS Apple Silicon)

Linux is an explicit V1 non-goal: no `*-unknown-linux-gnu` binary is bundled.

The Rust supervisor (`src/main.rs`) invokes the sidecar without any PATH
dependency via `app.shell().sidecar("binaries/muse")` with `cwd` locked to
the user-selected workspace root. Until the real binaries land, `spawn`
fails and the UI surfaces the "sidecar missing/incompatible" error path
(step 6 of the plan).
