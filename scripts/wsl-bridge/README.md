# Windows build with a WSL engine

This variant produces a native Windows x64 Tauri interface. The engine stays
Muse Code inside the default WSL distribution, installed and authenticated
through `~/.local/bin/muse`. No authentication material is bundled.

From the repository root, under PowerShell:

```powershell
cargo build --manifest-path scripts/wsl-bridge/Cargo.toml --release
Copy-Item scripts/wsl-bridge/target/release/muse-wsl-bridge.exe src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe -Force
npm run tauri -- build --bundles nsis
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.
It installs neither WSL nor Muse. This variant targets a machine that is
already configured; it is not a self-contained distribution of the Windows
engine.

The bridge preserves the JSON-RPC stream, translates the `session/start`
folder into its WSL path, and closes the engine's input when the supervisor
disconnects. Tool output paths stay Linux paths. Windows projects must be
reachable from the WSL distribution.

Local validation: `initialize`, `initialized`, `session/start` with a Windows
folder; clean shutdown on EOF. No billed model turn is needed for that
connection test. Advanced integrations between Windows and Linux paths remain
to be tested separately.
