# Update from an earlier version — M4-09 (20 September 2026)

Completes `M4-09-cycle-installation.md`: the "update from a previous version" criterion had **no proof**, for want of an earlier version to install. A `0.0.9` version was therefore built to exercise it.

A test **destructive on the user's machine**, with their explicit authorization. Final state restored and verified.

## A prerequisite verified

The NSIS installer **accepts installing over an existing installation**: two successive runs of the same `.exe` exit with code **0** and leave the application in place. Without that, an upward-version test would have been impossible without a manual uninstall — which would no longer have been an update.

## Building the earlier version

`0.0.9` was produced by lowering `version` in `package.json` **and** `src-tauri/tauri.conf.json`, then `npm run tauri -- build --bundles nsis`.

**A trap met, and an error of mine:** `Set-Content -Encoding UTF8` in **Windows PowerShell 5.1 writes a BOM**. The `package.json` rewritten that way made the build fail with

```
[vite:css] Failed to load PostCSS config: [SyntaxError] Unexpected token '', " { "nam"... is not valid JSON
```

The BOM was removed through Node (which does not add one), and the JSON validated with `JSON.parse` before relaunching. It is the **same trap as the one met with shebangs** while writing the campaign scripts: PowerShell 5.1 and UTF-8 encoding do not get along.

| Artefact produced | Size |
|---|---|
| `Muse-Desktop_0.0.9_x64-setup.exe` | 75.70 MB |
| `Muse-Desktop_0.1.0_x64-setup.exe` | 75.62 MB |

## Protocol and results

Starting point: no installation present (uninstalled beforehand).

### 1. Installing the earlier version

| Measurement | Result |
|---|---|
| Exit code | **0** |
| `FileVersion` / `ProductVersion` | **0.0.9** / 0.0.9 |
| `DisplayVersion` in the registry | **0.0.9** |
| The application starts | **yes** — alive, `Responding: True` |

### 2. Updating to 0.1.0 over 0.0.9

| Measurement | Before | After |
|---|---|---|
| Exit code | — | **0** |
| `FileVersion` / `ProductVersion` | 0.0.9 | **0.1.0** / 0.1.0 |
| `DisplayVersion` in the registry | 0.0.9 | **0.1.0** |
| The application starts | yes | **yes** — alive, `Responding: True` |

### 3. Do the projects survive the update? — yes, identically

| Measurement | Baseline | After 0.0.9 → 0.1.0 |
|---|---|---|
| Conversations | 64 | **64** |
| Projects | `openscreen`, `muse-desktop` | **`openscreen`, `muse-desktop`** |
| Logs | 13 | **13** |
| Total keys | 61 | **61** |

**Established:** an upward-version update installs, updates the binary **and** the registry entry, leaves the application working, and **does not touch user data**. That is the M4-09 criterion that was missing.

## Final restoration

| Element | State |
|---|---|
| Installed application | **uninstalled** — directory gone, **0** registry entries |
| Application data | **intact** — 64 conversations, 2 projects |
| `package.json` / `tauri.conf.json` | **back to `0.1.0`** (git restore, `git status` clean) |
| The `0.0.9` installer | kept in `src-tauri/target/release/bundle/nsis/` — an **unversioned artefact**, covered by `src-tauri/target/` in `.gitignore` |

## What stays open for M4-09

- **Clean machine**: the machine already has WSL, Muse and a profile with 64 conversations. It is not a first launch on a blank machine.
- **Signing**: both installers are `NotSigned`, so a SmartScreen warning is expected on a third-party machine. The manifest's optional Ed25519 signature was not exercised here either.
- **MSI**: only the NSIS package was installed, updated and uninstalled.
- **Channel switch** (`release:orchestrate sync`): tested locally at round 13, never exercised against real hosting — which does not exist yet.
- **Rollback**: `release:update rollback` was not exercised on a real installation.
- **macOS / Linux**: no bundle built for those targets.

**M4-09 is not closed** on the clean machine and signing, but its two functional criteria — install/uninstall with no loss, and an upward-version update with no loss — are now **executed and measured**.
