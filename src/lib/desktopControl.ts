import type { BrowserAppPermission } from "./browserAnnotate";
import type { ComposerAttachment } from "./attachments";

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

export const MAX_DESKTOP_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface DesktopCapture {
  dataUrl: string;
  source: "desktop-screen";
  capturedAt: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

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

function imageDataUrlParts(dataUrl: string): { mediaType: string; base64Data: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match || match[2].length === 0) return null;
  const base64Data = match[2];
  const estimatedBytes = Math.floor((base64Data.length * 3) / 4) -
    (base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_DESKTOP_CAPTURE_BYTES) return null;
  return { mediaType: match[1].toLowerCase(), base64Data };
}

export function desktopCaptureAttachment(
  capture: DesktopCapture,
): ComposerAttachment | null {
  const parts = imageDataUrlParts(capture.dataUrl);
  if (parts === null || capture.source !== "desktop-screen") return null;
  if (!Number.isInteger(capture.width) || capture.width < 1 || capture.width > 8_000) return null;
  if (!Number.isInteger(capture.height) || capture.height < 1 || capture.height > 8_000) return null;
  if (!Number.isFinite(capture.capturedAt) || capture.capturedAt <= 0) return null;
  return {
    id: `desktop-capture:${capture.capturedAt}:${capture.width}x${capture.height}`,
    name: `muse-desktop-${new Date(capture.capturedAt).toISOString().replace(/[:.]/g, "-")}.jpg`,
    mediaType: parts.mediaType,
    size: Math.floor((parts.base64Data.length * 3) / 4),
    kind: "image",
    base64Data: parts.base64Data,
    width: capture.width,
    height: capture.height,
  };
}

export function formatDesktopCaptureContext(capture: DesktopCapture): string {
  const attachment = desktopCaptureAttachment(capture);
  if (attachment === null) return "";
  const dpr = Number.isFinite(capture.devicePixelRatio) && capture.devicePixelRatio > 0
    ? capture.devicePixelRatio
    : 1;
  return [
    "[Desktop capture]",
    `Source: ${capture.source}`,
    `Captured: ${new Date(capture.capturedAt).toISOString()}`,
    `Surface: ${capture.width}×${capture.height} · device pixel ratio ${dpr.toFixed(2)}`,
    "Image: attached below. Verify the selected application is still current before acting on it.",
  ].join("\n");
}
