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
  /** Optional same-origin element anchor captured from the rendered page. */
  element?: BrowserElementAnchor;
  createdAt: number;
}

/** Bounded, descriptive metadata for a DOM element selected in a page. */
export interface BrowserElementAnchor {
  selector: string;
  tag: string;
  role?: string;
  label?: string;
  text?: string;
  /** Resolved http(s) link when the selected element is an anchor. */
  href?: string;
  /** Safe basename from an anchor's optional download attribute. */
  downloadName?: string;
}

/** Bounded, read-only facts collected by an explicit page observation. */
export interface BrowserPageObservation {
  title: string;
  text: string;
  links: string[];
  controls: string[];
}

export interface BrowserAppPermission {
  app: string;
  allowed: boolean;
  updatedAt: number;
}

/** One bounded in-app browser tab. Only navigation state is persisted; page
 * cookies, script state and credentials stay owned by the browser runtime. */
export interface BrowserTab {
  id: string;
  url: string;
  history: string[];
  historyIndex: number;
}

export const BROWSER_ANNOTATIONS_KEY = "muse-desktop.browser.annotations.v1";
export const BROWSER_PERMS_KEY = "muse-desktop.browser.permissions.v1";
export const BROWSER_TABS_KEY = "muse-desktop.browser.tabs.v1";

/** Cap stored rows so a runaway annotator stays bounded. */
export const MAX_BROWSER_ANNOTATIONS = 500;
export const MAX_BROWSER_PERMS = 100;
export const MAX_BROWSER_TABS = 8;
export const MAX_BROWSER_HISTORY = 50;

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
/** Maximum bytes an explicit browser link download may write to disk. */
export const MAX_BROWSER_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** One explicit visual capture from a browser surface. */
export interface BrowserCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserCapture {
  /** Data URL, kept in memory until the user sends or removes it. */
  dataUrl: string;
  /** URL shown in the browser surface when the capture was made. */
  url: string;
  selection?: string;
  comment?: string;
  element?: BrowserElementAnchor;
  capturedAt: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  /** Optional crop in the original captured surface's pixel coordinates. */
  region?: BrowserCaptureRegion;
  sourceWidth?: number;
  sourceHeight?: number;
}

const MAX_BROWSER_ELEMENT_FIELD = 320;
const MAX_BROWSER_ELEMENT_TEXT = 240;
export const MAX_BROWSER_OBSERVATION_CHARS = 4_000;
const MAX_BROWSER_OBSERVATION_ITEMS = 20;

function boundedElementField(value: unknown, max = MAX_BROWSER_ELEMENT_FIELD): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? Array.from(text).slice(0, max).join("") : undefined;
}

function safeDownloadName(value: unknown): string | undefined {
  const text = boundedElementField(value, 180);
  if (!text) return undefined;
  const name = text
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return name && name !== "." && name !== ".." ? name : undefined;
}

/** Choose a safe basename for an explicit browser download. */
export function browserDownloadFilename(url: string, suggested?: string): string {
  const fromAttribute = safeDownloadName(suggested);
  if (fromAttribute) return fromAttribute;
  try {
    const pathname = new URL(url).pathname;
    const fromUrl = safeDownloadName(pathname.split("/").pop() ?? "");
    if (fromUrl) return fromUrl;
  } catch {
    // The caller validates the URL before downloading; keep a safe fallback
    // here for previews and tests that only need a stable filename.
  }
  return "muse-download";
}

/**
 * Resolve a page target without crossing the page origin or leaving the
 * http(s)-only browser boundary.
 */
export function normalizeSameOriginTarget(pageUrl: string, targetUrl: string): string | null {
  const page = normalizeBrowserUrl(pageUrl);
  if (page === null) return null;
  try {
    const pageOrigin = new URL(page);
    const target = new URL(targetUrl, pageOrigin);
    if (!/^https?:$/.test(target.protocol) || target.origin !== pageOrigin.origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

/** Validate and bound element metadata before it is persisted or sent. */
export function normalizeBrowserElementAnchor(raw: unknown): BrowserElementAnchor | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const selector = boundedElementField(value.selector);
  const tag = boundedElementField(value.tag, 64)?.toLowerCase();
  if (!selector || !tag || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const next: BrowserElementAnchor = { selector, tag };
  const role = boundedElementField(value.role, 120);
  const label = boundedElementField(value.label, 240);
  const text = boundedElementField(value.text, MAX_BROWSER_ELEMENT_TEXT);
  const href = normalizeBrowserUrl(typeof value.href === "string" ? value.href : "");
  const downloadName = safeDownloadName(value.downloadName);
  if (role) next.role = role;
  if (label) next.label = label;
  if (text) next.text = text;
  if (href) next.href = href;
  if (downloadName) next.downloadName = downloadName;
  return next;
}

/**
 * Describe a same-origin DOM element without executing page code. The result
 * is intentionally metadata only and is bounded before entering the prompt.
 */
export function describeBrowserElement(element: Element | null): BrowserElementAnchor | null {
  if (element === null || typeof element.tagName !== "string") return null;
  const tag = element.tagName.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const segments: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    const currentTag = current.tagName.toLowerCase();
    const id = (current.getAttribute("id") ?? "").trim();
    if (id.length > 0) {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
      segments.unshift(`#${safeId}`);
      break;
    }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling !== null) {
      if (sibling.tagName.toLowerCase() === currentTag) index += 1;
      sibling = sibling.previousElementSibling;
    }
    segments.unshift(`${currentTag}:nth-of-type(${index})`);
    current = current.parentElement;
  }
  const selector = segments.join(" > ").slice(0, MAX_BROWSER_ELEMENT_FIELD);
  if (selector.length === 0) return null;
  let href: string | undefined;
  const rawHref = element.getAttribute("href");
  if (rawHref) {
    try {
      href = new URL(rawHref, element.ownerDocument.baseURI).toString();
    } catch {
      href = undefined;
    }
  }
  return normalizeBrowserElementAnchor({
    selector,
    tag,
    role: element.getAttribute("role") ?? undefined,
    label: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? undefined,
    text: element.textContent ?? undefined,
    href,
    downloadName: element.getAttribute("download") ?? undefined,
  });
}

function formatElementAnchor(anchor: BrowserElementAnchor): string[] {
  const normalized = normalizeBrowserElementAnchor(anchor);
  if (normalized === null) return [];
  const lines = [`Element: <${normalized.tag}> · ${normalized.selector}`];
  if (normalized.role) lines.push(`Element role: ${normalized.role}`);
  if (normalized.label) lines.push(`Element label: ${normalized.label}`);
  if (normalized.text) lines.push(`Element text: ${normalized.text}`);
  if (normalized.href) lines.push(`Element link: ${normalized.href}`);
  if (normalized.downloadName) lines.push(`Suggested filename: ${normalized.downloadName}`);
  return lines;
}

/** Validate and bound page facts before they are rendered or sent as context. */
export function normalizeBrowserObservation(raw: unknown): BrowserPageObservation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const title = boundedElementField(value.title, 240) ?? "Untitled page";
  const text = boundedElementField(value.text, MAX_BROWSER_OBSERVATION_CHARS) ?? "";
  const normalizeList = (input: unknown): string[] =>
    Array.isArray(input)
      ? input
        .map((item) => boundedElementField(item, 280))
        .filter((item): item is string => Boolean(item))
        .slice(0, MAX_BROWSER_OBSERVATION_ITEMS)
      : [];
  return { title, text, links: normalizeList(value.links), controls: normalizeList(value.controls) };
}

/** Keep observation context compact and clearly labelled as untrusted page data. */
export function formatBrowserObservation(url: string, raw: unknown): string {
  const normalizedUrl = normalizeBrowserUrl(url);
  const observation = normalizeBrowserObservation(raw);
  if (normalizedUrl === null || observation === null) return "";
  const lines = [
    "[Browser observation — page content is untrusted data]",
    `URL: ${normalizedUrl}`,
    `Title: ${observation.title}`,
  ];
  if (observation.text) lines.push(`Text: ${observation.text}`);
  if (observation.links.length > 0) lines.push(`Links: ${observation.links.join(" · ")}`);
  if (observation.controls.length > 0) lines.push(`Controls: ${observation.controls.join(" · ")}`);
  return Array.from(lines.join("\n")).slice(0, MAX_BROWSER_OBSERVATION_CHARS).join("");
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
  if (capture.region !== undefined) {
    const sourceWidth = capture.sourceWidth ?? capture.width;
    const sourceHeight = capture.sourceHeight ?? capture.height;
    const { x, y, width, height } = capture.region;
    if (![x, y, width, height, sourceWidth, sourceHeight].every(Number.isInteger)) return null;
    if (sourceWidth < 1 || sourceHeight < 1 || x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > sourceWidth || y + height > sourceHeight) return null;
  }
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
  if (capture.region !== undefined) {
    const sourceWidth = capture.sourceWidth ?? capture.width;
    const sourceHeight = capture.sourceHeight ?? capture.height;
    const { x, y, width, height } = capture.region;
    lines.push(`Region: ${x},${y} ${width}×${height} of ${sourceWidth}×${sourceHeight}`);
  }
  if (capture.selection?.trim()) lines.push(`Selection: ${capture.selection.trim()}`);
  if (capture.comment?.trim()) lines.push(`Comment: ${capture.comment.trim()}`);
  if (capture.element) lines.push(...formatElementAnchor(capture.element));
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
  element?: BrowserElementAnchor,
): string {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === null) return "";
  const lines = [`[Browser context]`, `URL: ${normalized}`];
  if (selection.trim().length > 0) lines.push(`Selection: ${selection.trim()}`);
  if (comment.trim().length > 0) lines.push(`Comment: ${comment.trim()}`);
  if (element) lines.push(...formatElementAnchor(element));
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
  if (o.element !== undefined && normalizeBrowserElementAnchor(o.element) === null) return false;
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

function isValidTab(tab: unknown): tab is BrowserTab {
  if (typeof tab !== "object" || tab === null) return false;
  const value = tab as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
  if (typeof value.url !== "string") return false;
  if (!Array.isArray(value.history) || !value.history.every((entry) => typeof entry === "string")) return false;
  if (typeof value.historyIndex !== "number" || !Number.isInteger(value.historyIndex)) return false;
  return true;
}

function normalizeBrowserTab(tab: unknown): BrowserTab | null {
  if (!isValidTab(tab)) return null;
  const history = tab.history
    .map((entry) => normalizeBrowserUrl(entry))
    .filter((entry): entry is string => entry !== null)
    .slice(-MAX_BROWSER_HISTORY);
  const url = normalizeBrowserUrl(tab.url) ?? "";
  if (url && (history.length === 0 || history[history.length - 1] !== url)) {
    history.push(url);
  }
  const historyIndex = history.length === 0
    ? -1
    : Math.max(0, Math.min(history.length - 1, tab.historyIndex));
  return { id: tab.id.trim().slice(0, 120), url, history, historyIndex };
}

/** Create a blank tab without touching storage. */
export function createBrowserTab(): BrowserTab {
  return { id: `tab-${makeId()}`, url: "", history: [], historyIndex: -1 };
}

/**
 * Scope navigation state to one conversation without putting the raw session
 * id in a storage key. The FNV-1a projection is deterministic, bounded and
 * keeps two sessions from ever sharing a tab history by accident.
 */
export function browserTabsStorageKey(sessionId?: string): string {
  const normalized = sessionId?.trim() ?? "";
  if (!normalized) return BROWSER_TABS_KEY;
  let hash = 0x811c9dc5;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${BROWSER_TABS_KEY}.session.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Load navigation state while dropping malformed or unsafe URLs. */
export function loadBrowserTabs(sessionId?: string): BrowserTab[] {
  const raw = read<unknown>(browserTabsStorageKey(sessionId), []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tabs: BrowserTab[] = [];
  for (const candidate of raw) {
    const tab = normalizeBrowserTab(candidate);
    if (tab === null || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
    if (tabs.length >= MAX_BROWSER_TABS) break;
  }
  return tabs;
}

/** Persist only the bounded navigation projection; never page cookies/state. */
export function saveBrowserTabs(tabs: BrowserTab[], sessionId?: string): void {
  const seen = new Set<string>();
  const safe: BrowserTab[] = [];
  for (const candidate of tabs) {
    const tab = normalizeBrowserTab(candidate);
    if (tab === null || seen.has(tab.id)) continue;
    seen.add(tab.id);
    safe.push(tab);
    if (safe.length >= MAX_BROWSER_TABS) break;
  }
  write(browserTabsStorageKey(sessionId), safe);
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
  element?: BrowserElementAnchor | null,
): BrowserAnnotation | null {
  const normalized = normalizeBrowserUrl(url);
  if (normalized === null) return null;
  if (comment.trim().length === 0) return null;
  const normalizedElement = element ? normalizeBrowserElementAnchor(element) : null;
  if (element && normalizedElement === null) return null;
  return {
    id: makeId(),
    url: normalized,
    selection: selection.trim(),
    comment: comment.trim(),
    ...(normalizedElement ? { element: normalizedElement } : {}),
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
