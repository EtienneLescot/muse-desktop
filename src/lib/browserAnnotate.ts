/**
 * US-19 browser + computer-use (scoped): dependency-light pure logic.
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

import { readStorageJson, writeStorageJson } from "./storage.ts";
import type { ComposerAttachment } from "./attachments.ts";

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

/** Keep browser context useful without allowing a page to flood a prompt. */
export const MAX_BROWSER_CONTEXT_CHARS = 8_000;

/** Maximum encoded image size accepted for a browser capture. */
export const MAX_BROWSER_CAPTURE_BYTES = 5 * 1024 * 1024;

/** One explicit visual capture from a browser surface. */
export interface BrowserCapture {
  /** Data URL, kept in memory until the user sends or removes it. */
  dataUrl: string;
  /** URL shown in the browser surface when the capture was made. */
  url: string;
  selection?: string;
  comment?: string;
  capturedAt: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

function imageDataUrlParts(dataUrl: string): { mediaType: string; base64Data: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match || match[2].length === 0) return null;
  const mediaType = match[1].toLowerCase();
  const base64Data = match[2];
  const estimatedBytes = Math.floor((base64Data.length * 3) / 4) -
    (base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_BROWSER_CAPTURE_BYTES) return null;
  return { mediaType, base64Data };
}

/**
 * Turn a user-confirmed capture into the same attachment shape as a pasted
 * image. The URL and timestamp remain prompt text so an image never loses
 * its provenance when it leaves the browser panel.
 */
export function browserCaptureAttachment(capture: BrowserCapture): ComposerAttachment | null {
  const url = normalizeBrowserUrl(capture.url);
  const parts = imageDataUrlParts(capture.dataUrl);
  if (url === null || parts === null) return null;
  if (!Number.isInteger(capture.width) || capture.width < 1 || capture.width > 8_000) return null;
  if (!Number.isInteger(capture.height) || capture.height < 1 || capture.height > 8_000) return null;
  if (!Number.isFinite(capture.capturedAt) || capture.capturedAt <= 0) return null;
  return {
    id: `browser-capture:${capture.capturedAt}:${capture.width}x${capture.height}`,
    name: `muse-browser-${new Date(capture.capturedAt).toISOString().replace(/[:.]/g, "-")}.jpg`,
    mediaType: parts.mediaType,
    size: Math.floor((parts.base64Data.length * 3) / 4),
    kind: "image",
    base64Data: parts.base64Data,
    width: capture.width,
    height: capture.height,
  };
}

/** Build bounded text metadata to accompany a captured image attachment. */
export function formatBrowserCaptureContext(capture: BrowserCapture): string {
  const normalized = normalizeBrowserUrl(capture.url);
  if (normalized === null) return "";
  const dpr = Number.isFinite(capture.devicePixelRatio) && capture.devicePixelRatio > 0
    ? capture.devicePixelRatio
    : 1;
  const lines = [
    "[Browser capture]",
    `URL: ${normalized}`,
    `Captured: ${new Date(capture.capturedAt).toISOString()}`,
    `Viewport: ${capture.width}×${capture.height} · device pixel ratio ${dpr.toFixed(2)}`,
  ];
  if (capture.selection?.trim()) lines.push(`Selection: ${capture.selection.trim()}`);
  if (capture.comment?.trim()) lines.push(`Comment: ${capture.comment.trim()}`);
  lines.push("Image: attached below. Verify the page is still current before acting on it.");
  return Array.from(lines.join("\n")).slice(0, MAX_BROWSER_CONTEXT_CHARS).join("");
}

/**
 * Build the explicit text context inserted into the active composer. The
 * action is user-triggered and preserves provenance; it never executes page
 * content or implies that a visual screenshot was captured.
 */
export function formatBrowserContext(
  url: string,
  selection = "",
  comment = "",
): string {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === null) return "";
  const lines = [`[Browser context]`, `URL: ${normalized}`];
  if (selection.trim().length > 0) lines.push(`Selection: ${selection.trim()}`);
  if (comment.trim().length > 0) lines.push(`Comment: ${comment.trim()}`);
  const text = lines.join("\n");
  return Array.from(text).slice(0, MAX_BROWSER_CONTEXT_CHARS).join("");
}

function read<T>(key: string, fallback: T): T {
  return readStorageJson(key, fallback);
}

function write(key: string, value: unknown): void {
  writeStorageJson(key, value);
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
