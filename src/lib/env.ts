/** True when running inside the Tauri webview (IPC + dialogs available). */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

/** Frontend build marker: bump on every shipped frontend fix so stale webviews are identifiable. */
export const BUILD_ID = "2026-09-08-poll-transport";
