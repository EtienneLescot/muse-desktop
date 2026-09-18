import type { BrowserAppPermission } from "./browserAnnotate";

export const DESKTOP_PERMISSION_APP = "desktop";

export interface DesktopControlStatus {
  supported: boolean;
  platform: string;
  reason: string;
}

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindow {
  id: string;
  title: string;
  bounds: DesktopBounds;
}

export const DESKTOP_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

export type DesktopKey = (typeof DESKTOP_KEYS)[number];

export function isDesktopControlAllowed(
  permissions: readonly BrowserAppPermission[],
): boolean {
  return permissions.some(
    (permission) =>
      permission.app === DESKTOP_PERMISSION_APP && permission.allowed === true,
  );
}

export function desktopWindowLabel(window: DesktopWindow): string {
  const { width, height } = window.bounds;
  return `${window.title} · ${width}×${height}`;
}

export function isDesktopPointInBounds(
  window: DesktopWindow | null,
  x: number,
  y: number,
): boolean {
  if (window === null || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  return x >= 0 && y >= 0 && x < window.bounds.width && y < window.bounds.height;
}

