/** Native mirror for the in-app notification inbox (M3-09). */
import { isTauriRuntime } from "./env";
import { normalizeNotifications, type MuseNotification } from "./notifications";

export const NATIVE_NOTIFICATIONS_SCHEMA = "muse-desktop.native-notifications.v1";

export async function loadNativeNotifications(): Promise<MuseNotification[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<unknown>("notifications_read");
    if (typeof payload !== "object" || payload === null) return null;
    const value = payload as Record<string, unknown>;
    if (value.schema !== NATIVE_NOTIFICATIONS_SCHEMA || !Array.isArray(value.notifications)) return null;
    return normalizeNotifications(value.notifications);
  } catch {
    return null;
  }
}

export async function saveNativeNotifications(notifications: MuseNotification[]): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notifications_write", {
      payload: JSON.stringify({
        schema: NATIVE_NOTIFICATIONS_SCHEMA,
        notifications: normalizeNotifications(notifications),
      }),
    });
    return true;
  } catch {
    return false;
  }
}
