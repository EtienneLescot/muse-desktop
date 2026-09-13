/**
 * US-19 browser + computer-use (scoped): pure logic, zero imports.
 *
 * Runnable under the built-in node:test runner (no React/Tauri/dep imports).
 *
 * - Anchored comments: a comment attaches to a URL + selection text pair and
 *   persists under a `muse-desktop.*` localStorage key.
 * - Computer-use: per-app permission toggles, default denied (no entry =
 *   denied). Background operation requires an explicit opt-in per app.
 * - Image generation is explicitly out of scope (honest message constant for
 *   the UI); no new backend transport is added.
 */

export interface BrowserAnnotation {
  id: string;
  /** Normalized URL the comment is anchored to. */
  url: string;
  /** Quoted selection text the comment refers to (may be empty). */
  selection: string;
  comment: string;
  createdAt: number;
}

export interface BrowserAppPermission {
  app: string;
  allowed: boolean;
  updatedAt: number;
}

export const BROWSER_ANNOTATIONS_KEY = "muse-desktop.browser.annotations.v1";
export const BROWSER_PERMS_KEY = "muse-desktop.browser.permissions.v1";

/** Cap stored rows so a runaway annotator stays bounded. */
export const MAX_BROWSER_ANNOTATIONS = 500;
export const MAX_BROWSER_PERMS = 100;

/**
 * Honest out-of-scope notice for image generation (rendered verbatim by the
 * panel): the in-app browser views pages and anchors comments only.
 */
export const IMAGE_GENERATION_NOTE =
  "Image generation is not available in the in-app browser — " +
  "it views pages and anchors comments only.";

function storage(): Storage | null {
  try {
    const ls = (globalThis as Record<string, unknown>).localStorage;
    if (
      typeof ls === "object" &&
      ls !== null &&
      typeof (ls as Storage).getItem === "function"
    ) {
      return ls as Storage;
    }
    return null;
  } catch {
    return null;
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const ls = storage();
    if (ls === null) return fallback;
    const raw = ls.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: persistence is best-effort.
  }
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Normalize a user-typed URL for iframe display + anchoring: trim, prepend
 * `https://` to a bare domain, and reject anything that is not an
 * http(s) URL. Returns null when the input cannot be shown safely.
 */
export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** True when the raw input can be rendered in the sandboxed iframe. */
export function isRenderableBrowserUrl(raw: string): boolean {
  return normalizeBrowserUrl(raw) !== null;
}

function isValidAnnotation(a: unknown): a is BrowserAnnotation {
  if (typeof a !== "object" || a === null) return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.url === "string" &&
    o.url.length > 0 &&
    typeof o.selection === "string" &&
    typeof o.comment === "string" &&
    o.comment.length > 0 &&
    typeof o.createdAt === "number"
  );
}

function isValidPerm(p: unknown): p is BrowserAppPermission {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.app === "string" &&
    o.app.length > 0 &&
    typeof o.allowed === "boolean" &&
    typeof o.updatedAt === "number"
  );
}

export function loadBrowserAnnotations(): BrowserAnnotation[] {
  const raw = read<unknown>(BROWSER_ANNOTATIONS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidAnnotation).slice(-MAX_BROWSER_ANNOTATIONS);
}

export function saveBrowserAnnotations(list: BrowserAnnotation[]): void {
  write(BROWSER_ANNOTATIONS_KEY, list.slice(-MAX_BROWSER_ANNOTATIONS));
}

export function loadBrowserPermissions(): BrowserAppPermission[] {
  const raw = read<unknown>(BROWSER_PERMS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidPerm).slice(-MAX_BROWSER_PERMS);
}

export function saveBrowserPermissions(perms: BrowserAppPermission[]): void {
  write(BROWSER_PERMS_KEY, perms.slice(-MAX_BROWSER_PERMS));
}

/**
 * Build an anchored comment (URL + selection + comment). Returns null when
 * the URL is not renderable or the comment is empty — the panel shows the
 * row as invalid instead of storing a dangling anchor.
 */
export function createBrowserAnnotation(
  url: string,
  selection: string,
  comment: string,
): BrowserAnnotation | null {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === null) return null;
  if (comment.trim().length === 0) return null;
  return {
    id: makeId(),
    url: normalized,
    selection: selection.trim(),
    comment: comment.trim(),
    createdAt: Date.now(),
  };
}

/** Append an annotation (no-op for null drafts, e.g. invalid URL). */
export function addBrowserAnnotation(
  list: BrowserAnnotation[],
  draft: BrowserAnnotation | null,
): BrowserAnnotation[] {
  if (draft === null) return list;
  return [...list, draft].slice(-MAX_BROWSER_ANNOTATIONS);
}

export function removeBrowserAnnotation(
  list: BrowserAnnotation[],
  id: string,
): BrowserAnnotation[] {
  return list.filter((a) => a.id !== id);
}

/** Annotations anchored to one page (URL compared after normalization). */
export function annotationsForUrl(
  list: BrowserAnnotation[],
  url: string,
): BrowserAnnotation[] {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === null) return [];
  return list.filter((a) => a.url === normalized);
}

/**
 * Computer-use gate: an app may act only with an explicit `allowed: true`
 * row. Unknown apps — and apps never toggled — are denied by default.
 */
export function isBrowserActionAllowed(
  perms: BrowserAppPermission[],
  app: string,
): boolean {
  const row = perms.find((p) => p.app === app);
  return row?.allowed === true;
}

/**
 * Upsert one app's permission (toggle on/off). Trims the app name; empty
 * names are ignored. Re-toggling updates the row instead of duplicating it.
 */
export function setBrowserAppPermission(
  perms: BrowserAppPermission[],
  app: string,
  allowed: boolean,
): BrowserAppPermission[] {
  const name = app.trim();
  if (name.length === 0) return perms;
  const i = perms.findIndex((p) => p.app === name);
  if (i >= 0) {
    if (perms[i].allowed === allowed) return perms;
    const next = [...perms];
    next[i] = { ...next[i], allowed, updatedAt: Date.now() };
    return next;
  }
  return [...perms, { app: name, allowed, updatedAt: Date.now() }].slice(
    -MAX_BROWSER_PERMS,
  );
}
