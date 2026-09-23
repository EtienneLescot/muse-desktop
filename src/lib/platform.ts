/** Host operating system as seen by the renderer. */
export type HostPlatform = "macos" | "windows" | "linux" | "unknown";

/**
 * Detect the host OS from the webview. WKWebView reports `MacIntel` on both
 * Intel and Apple Silicon Macs; WebView2 reports `Win32`.
 */
export function hostPlatform(platform?: string): HostPlatform {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  if (/Mac|iPhone|iPad|iPod/i.test(value)) return "macos";
  if (/Win/i.test(value)) return "windows";
  if (/Linux|X11/i.test(value)) return "linux";
  return "unknown";
}

export function isMacPlatform(platform?: string): boolean {
  return hostPlatform(platform) === "macos";
}
