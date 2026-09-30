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
