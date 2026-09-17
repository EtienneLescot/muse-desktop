# M4-01 — Native browser surface

## Decision

Muse keeps the existing in-app iframe as a bounded web preview and adds an
explicit **Open native** action for desktop builds. The action opens one
dedicated Tauri webview window (`muse-browser`) and reuses that window for
subsequent navigations. The preview remains available in web mode and when a
native window cannot be created.

## Boundary and safety

- Only `http` and `https` URLs are accepted by the native command.
- Bare hosts receive `https://`, matching the renderer URL normalizer.
- URLs with embedded usernames or passwords are rejected.
- Input is limited to 4,096 Unicode characters.
- The native window has no Muse IPC surface and does not receive workspace or
  conversation data.
- Cookies, downloads, browser automation and visual capture remain outside
  this increment and stay visible as M4 follow-up work.

## Verification

The Rust unit tests cover web schemes, bare hosts, localhost, credentials,
missing hosts and the URL bound. The browser panel keeps a status message for
web preview and native desktop outcomes. A real-site WebView2 run is still a
native qualification step and must record the OS, app build and URL without
claiming cross-platform support.
