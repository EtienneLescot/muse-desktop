/** True when running inside the Tauri webview (IPC + dialogs available). */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}
