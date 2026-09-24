# Complete Windows distribution cycle — M4-09 (20 September 2026)

Install, verify, uninstall, and prove the projects survive. That is M4-09's exit criterion, which had never been run.
A test **deliberately destructive on the user's machine**, with their explicit authorization; final state verified and restored.

## Artefact used

`src-tauri/target/release/bundle/nsis/Muse-Desktop_0.1.0_x64-setup.exe` — **75,617,763 bytes** (72.11 MiB), SHA-256 `c8fcb5da1c2f49c3527e83e9f4791c068811a2fc8e45d67c439294221a6c30bd`, built at round 13 (`docs/evidence/2026-09-20-windows-release/M4-09.md`).

## Baseline to preserve

Recorded over CDP on the real profile: **64 conversations**, **2 projects** (`openscreen`, `muse-desktop`), **13 logs**, **61** `localStorage` keys.

## 1. Installation

```powershell
Start-Process -FilePath "…\Muse-Desktop_0.1.0_x64-setup.exe" -ArgumentList "/S" -Wait
```

| Measurement | Result |
|---|---|
| Exit code | **0** |
| Install directory | **`%LOCALAPPDATA%\Muse-Desktop`** — *not* `Programs\`, contrary to what I expected |
| Contents | `muse-desktop.exe` (20.05 MB), **`muse.exe` (396.14 MB)** — the sidecar is indeed bundled —, `uninstall.exe` (0.08 MB) |
| Uninstall entry | `HKCU\…\Uninstall` → `DisplayName: Muse-Desktop`, `DisplayVersion: 0.1.0`, `UninstallString: …\uninstall.exe` |
| Privileges | none — `currentUser` install, consistent with `installMode: currentUser` in `tauri.conf.json` |

**The installed application starts**: `Muse-Desktop.exe` alive, "Muse-Desktop" window, `Responding: True`. No sidecar is launched **at startup** — consistent with the documented behaviour (one host per workspace, created on demand).

## 2. Uninstallation

```powershell
Start-Process -FilePath "…\Muse-Desktop\uninstall.exe" -ArgumentList "/S" -Wait
```

| Measurement | Result |
|---|---|
| Exit code | **0** |
| Install directory | **removed** |
| Uninstall entry | **withdrawn** (0 `*Muse*` entries left) |

## 3. Do the projects survive? — yes, identically

Reading `localStorage` back after uninstalling, through the same read path as before:

| Measurement | Baseline | After uninstalling |
|---|---|---|
| Conversations | 64 | **64** |
| Projects | `openscreen`, `muse-desktop` | **`openscreen`, `muse-desktop`** |
| Logs | 13 | **13** |
| Total keys | 61 | **61** |

**Established:** uninstalling removes the program and its registry entry **without touching user data**. The "uninstall without wiping the projects" criterion is met, measured on a real profile with 64 conversations.

### A method detail

A first SHA-256 fingerprint of the `leveldb` folder (name + size + timestamp of each file) **differed** before and after: `F9C7813A…` → `8FECBA47…`. That was **not** data loss: the installed application had run for a dozen seconds and written into that storage, which changes timestamps and size (388.9 → 391.6 KB, **9 files in both cases**). The fingerprint was therefore not a good indicator here; **reading the content back** is, and it is identical. I record it because the conclusion "data modified" would have been wrong.

### Where the data lives

`%LOCALAPPDATA%\com.muse.desktop\EBWebView\` — the product identifier (`com.muse.desktop`). **The installed application and the development build share that folder**, which is precisely what made it possible to compare before and after through the same read path.

## What stays open for M4-09

- **Update from a previous version**: the criterion includes "update from a previous version". I did not build an earlier version, so **the update chain was not exercised on a real installation** — only tested locally through `release:update` (round 13) and the delta chain.
- **Clean machine**: the machine already had WSL, Muse and a profile with 64 conversations. It is **not** a first launch on a blank machine.
- **MSI**: only the NSIS package was installed and uninstalled.
- **Signing**: the installer is still `NotSigned` (recorded at round 13), so a SmartScreen warning is expected on a third-party machine.
- **macOS / Linux**: no bundle built for those targets.
- **Uninstalling and data from other profiles**: not verified.

**M4-09 is not closed** on the real update and the clean machine, but its main criterion — install, run, uninstall **without losing the projects** — is now **executed and measured**, which had never been done.

## Final state of the machine

| Element | State |
|---|---|
| Installed program | **uninstalled** (directory and registry) |
| Application data | **intact** — 64 conversations, 2 projects |
| `%USERPROFILE%\.config\muse\auth.json` | present |
| WSL | distributions intact |
| Application | relaunched as the development build, working |
