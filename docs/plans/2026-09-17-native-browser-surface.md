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
- Explicit same-origin downloads are handled by a native, no-credentials
  request in desktop builds. Redirects are rejected, responses are capped at
  10 MiB, and the renderer only receives bounded base64 for the native save
  dialog. Page-triggered downloads, cookies and browser automation remain
  outside this increment.
- Visual capture is available only as an explicit `getDisplayMedia` gesture in
  the renderer: the user chooses the browser surface, Muse bounds the JPEG,
  shows a preview, allows a pointer-drawn crop and keeps URL/time/viewport/DPR
  crop coordinates and any same-origin DOM element anchor next to the image
  before it is inserted into the
  composer. The runtime cannot force the chooser to pick the Muse Browser
  window, so a capture is never treated as proof that the selected pixels came
  from the URL without that user check.

## Verification

The Rust unit tests cover web schemes, bare hosts, localhost, credentials,
missing hosts and the URL bound. Browser logic tests cover capture provenance,
element-anchor bounding, crop bounds, safe image payloads and the attachment size bound. The browser panel keeps a
status message for web preview, native desktop outcomes and capture consent.
A real-site WebView2 run is still a native qualification step and must record
the OS, app build, selected surface and URL without claiming cross-platform
support.
