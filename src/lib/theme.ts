/**
 * Persistent light/dark theme for the desktop app.
 *
 * The design system (design/system/tokens.css) switches palettes through a
 * `body.dark` class; the choice persists in localStorage so it survives
 * restarts. Only the pure helpers live here so they stay unit-testable
 * without a DOM; App wires them to document.body + localStorage.
 */

export type Theme = "light" | "dark";

export const THEME_KEY = "muse-desktop.theme.v1";

/** Accept only the two known stored values; anything else means "unset". */
export function parseTheme(raw: string | null | undefined): Theme | null {
  if (raw === "light" || raw === "dark") return raw;
  return null;
}

/**
 * Resolve the effective theme: an explicit stored choice wins, otherwise
 * fall back to the OS preference.
 */
export function resolveTheme(
  stored: string | null | undefined,
  prefersDark: boolean,
): Theme {
  return parseTheme(stored) ?? (prefersDark ? "dark" : "light");
}

/** Flip the theme for the toggle button. */
export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
