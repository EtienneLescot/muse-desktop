import { confirm } from "@tauri-apps/plugin-dialog";

/** True when running inside the Tauri webview (IPC + dialogs available). */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

/**
 * Ask before acting; resolves with the answer. In the app: the dialog
 * plugin's OK/Cancel box. Its own `window.confirm` replacement calls a
 * `confirm` command plugin 2.7 no longer has, so it always failed, and read
 * without `await` its Promise counted as a yes (M2-05, 06/10/2026).
 */
export async function confirmAction(message: string): Promise<boolean> {
  return isTauriRuntime()
    ? confirm(message, { title: "Muse-Desktop", kind: "warning" })
    : window.confirm(message);
}

/** Frontend build marker: bump on every shipped frontend fix so stale webviews are identifiable. */
export const BUILD_ID = "2026-09-18-retry-progress";
