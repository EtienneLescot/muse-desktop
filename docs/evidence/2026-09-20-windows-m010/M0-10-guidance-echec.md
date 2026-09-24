# First launch: failure guidance exercised — M0-10 (20 September 2026)

A deliberately destructive test on the startup prerequisites, with **verified restoration**. Explicit user authorization.

## How to break startup for real — two discoveries

Both were necessary, and the first invalidated a first attempt:

1. **Tauri copies the sidecar at build time.** The binary `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` is copied to **`src-tauri/target/debug/muse.exe`**, and it is **that copy** the supervisor launches. Renaming the file in `binaries/` breaks **nothing** at runtime: a host starts normally. **Both** have to be neutralised.
2. **The development executable renders nothing without Vite.** Launched alone, it loads the frontend from `localhost:1420` and the window shows `ERR_CONNECTION_REFUSED` — a browser error, not the application's guidance. The Vite server has to be running for the test to be about the app.

## Broken state obtained

| Prerequisite | State |
|---|---|
| `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` | renamed to `.disabled` |
| `src-tauri/target/debug/muse.exe` | renamed to `.disabled` |
| `%USERPROFILE%\.config\muse\auth.json` | moved out of the profile |
| `muse.exe` processes | **0** — no host could start |

## Result

**The application starts and stays stable** with the sidecar absent: no crash, the conversation list displays normally, **no recovery panel on the welcome screen** — consistent with the documentation ("the probe does not appear on the welcome screen").

The guidance appears **at the moment a host has to start**, that is, after creating a conversation and sending. The recovery panel then exposes:

| Element observed | Value |
|---|---|
| Diagnostic vocabulary | **`sidecar`**, **`binary`**, **`triple`**, **`folder`** |
| Actions offered | **"Try again"**, **"Choose workspace folder"** |

That is exactly what M0-10 describes: a binary matching the *target triple*, the dependency's availability, the folder's accessibility, and an explicit relaunch — **never** an implicit install.

## Restoration

Everything was put back and **verified**:

| Element | State after restoration |
|---|---|
| `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` | present, 396.1 MB |
| `src-tauri/target/debug/muse.exe` | present |
| `%USERPROFILE%\.config\muse\auth.json` | present, 135 bytes |
| Leftover `.disabled` files | **none** |
| Application relaunched | **1 host started**, 63 conversations, no error panel |

Paths are given **relative to the repository root**, as in the broken-state table above: this document lives under `docs/evidence/`, so an unprefixed path would be ambiguous.

## What stays uncovered for M0-10

- **Detection on a clean machine**: neutralising the sidecar simulates the binary's absence, **not** a first launch on a machine where nothing has ever been installed. Registry, unconfigured WSL, blank profile: not exercised.
- **Non-default WSL distributions**: not exercised. WSL was not uninstalled — that would destroy the user's distributions.
- **A real authentication path**: `auth.json` was removed, but I did **not** verify that the panel distinguishes that case from a missing binary. The word `authentication` does not appear in the matches recorded, which may mean the missing binary masks the other causes.
- **Multi-OS matrix**: out of scope.

**M0-10 is therefore not closed**, but its failure guidance is now **exercised on a real case**, which had never been done.
