/**
 * M4-06: publishing a share bundle to a **self-hosted mini-server** (product
 * decision of 29/09/2026 — no account, no identity layer). Muse publishes the
 * bundle plus a token and a duration to a small share service the user runs
 * themselves (LAN, VPS, NAS); revocation is served by that service and is
 * therefore observable from any client. The choice of where the service lives
 * stays with the user.
 *
 * This module is the pure client half: endpoint validation and the exact
 * HTTP requests, so the wire contract is one reviewable surface shared by the
 * publisher and the reference server (`scripts/share-server.mjs`). No URL is
 * announced before its real creation: a publish is only as real as the
 * server's 201. The bearer token is the publish/revoke credential only — a
 * reader needs nothing, which is what makes revocation observable.
 *
 * Unit-tested; the reference server is exercised end to end in
 * `test/sharePublish.test.ts` over real loopback HTTP.
 */

import type { ShareBundle } from "./sharing.ts";
import { readStorageJson, writeStorageJson } from "./storage.ts";

/** The published bundle, as the wire carries it. */
export interface PublishedBundle {
  bundle: ShareBundle;
  /** Epoch ms after which the server must serve 404 for the bundle. */
  expiresAt: number;
}

export interface ShareEndpoint {
  /** Base URL, http(s), no query, no fragment, no credentials in the URL. */
  baseUrl: string;
  /** Publish/revoke bearer token; optional (a tokenless LAN service is fine). */
  token: string;
}

/** The publish duration is a decision, not a default: 1 h – 30 d. */
export const SHARE_DURATION_MIN_HOURS = 1;
export const SHARE_DURATION_MAX_HOURS = 24 * 30;
export const SHARE_BODY_LIMIT = 240 * 1024;
export const PUBLISH_PATH = "/muse-share";

function cleanUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.length > 400) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  if (parsed.searchParams.size > 0) return "";
  return trimmed;
}

/** Validate one endpoint from untrusted Settings input. `null` = refused. */
export function validateShareEndpoint(input: unknown): ShareEndpoint | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const baseUrl = cleanUrl(raw.baseUrl);
  if (!baseUrl) return null;
  if (raw.token !== undefined && typeof raw.token !== "string") return null;
  const tokenRaw = typeof raw.token === "string" ? raw.token : "";
  // A control character in a token is a paste error, never a credential.
  if (tokenRaw.length > 256 || /[\0\r\n]/.test(tokenRaw)) return null;
  const token = tokenRaw.trim();
  return { baseUrl, token };
}

/** The public URL a second client opens. Pure string work, no fetch. */
export function bundleUrl(endpoint: ShareEndpoint, bundleId: string): string | null {
  if (!/^share-[A-Za-z0-9_-]{4,64}$/.test(bundleId)) return null;
  return `${endpoint.baseUrl}${PUBLISH_PATH}/${bundleId}`;
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The publish request for one bundle and one duration. `null` for a duration
 * out of bounds, a non-object bundle, or an oversized body: the server would
 * refuse them, and asking would be a lie the UI would have to walk back.
 */
export function buildPublishRequest(
  endpoint: ShareEndpoint,
  bundle: ShareBundle,
  durationHours: number,
  now: number,
): { method: string; url: string; headers: Record<string, string>; body: string } | null {
  if (!Number.isInteger(durationHours) || durationHours < SHARE_DURATION_MIN_HOURS || durationHours > SHARE_DURATION_MAX_HOURS) return null;
  if (typeof bundle !== "object" || bundle === null) return null;
  const id = bundleUrl(endpoint, bundle.bundleId);
  if (!id) return null;
  const published: PublishedBundle = { bundle, expiresAt: now + durationHours * 3_600_000 };
  const body = JSON.stringify(published);
  if (body.length > SHARE_BODY_LIMIT) return null;
  return { method: "PUT", url: id, headers: authHeaders(endpoint.token), body };
}

/** The revoke request. Revocation is deny-only: no body, token required. */
export function buildRevokeRequest(endpoint: ShareEndpoint, bundleId: string): { method: string; url: string; headers: Record<string, string> } | null {
  const url = bundleUrl(endpoint, bundleId);
  if (!url) return null;
  return { method: "DELETE", url, headers: authHeaders(endpoint.token) };
}

/**
 * Parse a publish response. Only a real 201 with a body the server wrote
 * yields a URL — "no URL announced before its real creation" is enforced
 * here, not in the UI copy.
 */
export function parsePublishResponse(status: number, body: string): { url: string } | null {
  if (status !== 201) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.url !== "string" || !parsed.url.startsWith("http")) return null;
    return { url: parsed.url };
  } catch {
    return null;
  }
}

/** Where the configured endpoint persists (Settings writes, the panel reads). */
export const SHARE_ENDPOINT_KEY = "muse-desktop.share-endpoint.v1";

/** Read the configured endpoint, re-validating what was stored. */
export function loadShareEndpoint(): ShareEndpoint | null {
  return validateShareEndpoint(readStorageJson<unknown>(SHARE_ENDPOINT_KEY, null));
}

/** Persist the endpoint (already validated) or clear it with `null`. */
export function saveShareEndpoint(endpoint: ShareEndpoint | null): void {
  writeStorageJson(SHARE_ENDPOINT_KEY, endpoint);
}

/** The publish call as the panel needs it: network errors surface as strings,
 *  a refused status is a value. Returns the server-minted URL and the local
 *  expiry the UI shows. */
export async function publishToServer(
  endpoint: ShareEndpoint,
  bundle: ShareBundle,
  durationHours: number,
): Promise<{ ok: true; url: string; expiresAt: number } | { ok: false; error: string }> {
  const request = buildPublishRequest(endpoint, bundle, durationHours, Date.now());
  if (!request) return { ok: false, error: "this bundle cannot be published (duration, size or id out of bounds)" };
  let response: Response;
  try {
    response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  } catch (error) {
    return { ok: false, error: `the share service did not answer: ${String(error).slice(0, 160)}` };
  }
  const body = await response.text().catch(() => "");
  if (response.status === 403) return { ok: false, error: "the service refused the token (403)" };
  if (response.status === 413) return { ok: false, error: "the service refused the bundle as too large (413)" };
  const parsed = parsePublishResponse(response.status, body);
  if (!parsed) return { ok: false, error: `the service did not create a URL (status ${response.status})` };
  return { ok: true, url: parsed.url, expiresAt: Date.now() + durationHours * 3_600_000 };
}

/** The revoke call. Revocation is deny-only: 204 on the server, 404 already
 *  gone — both leave the link dead for every client. */
export async function revokeOnServer(
  endpoint: ShareEndpoint,
  bundleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = buildRevokeRequest(endpoint, bundleId);
  if (!request) return { ok: false, error: "invalid bundle id" };
  let response: Response;
  try {
    response = await fetch(request.url, { method: request.method, headers: request.headers });
  } catch (error) {
    return { ok: false, error: `the share service did not answer: ${String(error).slice(0, 160)}` };
  }
  if (response.status === 204 || response.status === 404) return { ok: true };
  if (response.status === 403) return { ok: false, error: "the service refused the token (403)" };
  return { ok: false, error: `the service refused the revocation (status ${response.status})` };
}
