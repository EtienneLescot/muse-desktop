/**
 * Streamable HTTP transport for a remote MCP server.
 *
 * The endpoint and verified tool catalogue may be persisted by the connector
 * registry. The MCP session id stays in the caller's memory; the bearer too,
 * and on desktop it is also kept in the system's credential store, bound to
 * the URL it was used for (`encodeStoredBearer`), never in localStorage.
 * Every connection starts with a real initialize exchange; callers must not
 * present a remote connector as connected from metadata alone.
 */

import { isRemoteMcpUrlAllowed, type ConnectorTool } from "./connectors.ts";
import { hostPlatform } from "./platform.ts";

export const REMOTE_MCP_PROTOCOL_VERSION = "2025-06-18";
export const REMOTE_MCP_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_TOOLS = 500;
export const MAX_REMOTE_OUTPUT_CHARS = 200_000;

export interface RemoteMcpProbeResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  sessionId: string | null;
  tools: ConnectorTool[];
  durationMs: number;
}

export interface RemoteMcpCallResult {
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface RemoteMcpSession {
  url: string;
  token: string;
  sessionId: string | null;
  protocolVersion: string;
  nextRequestId: number;
}

/** Stable, metadata-safe key used by the native credential boundary. */
export function remoteMcpCredentialKey(connectorId: string): string {
  const safe = connectorId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return `remote-mcp-${safe || "connector"}`;
}

/** Authentication/session failures are safe to retry after a fresh initialize. */
export function isRemoteMcpAuthenticationError(message: string): boolean {
  return /remote MCP authentication was rejected or expired/i.test(message);
}

/** The server ended the MCP session (404 to its id): a new initialize starts another. */
export function isRemoteMcpSessionExpired(message: string): boolean {
  return /remote MCP session expired/i.test(message);
}

/**
 * The credential store keeps a bearer with the URL it was used for, and a
 * probe reads it for that URL only. Bound by the registry alone, it crossed:
 * a save that failed after a probe moved the connector to another URL left
 * the old URL's token behind, and the next Reconnect sent it to the new one
 * (M3-02 check, 06/10/2026).
 */
export function encodeStoredBearer(url: string, token: string): string {
  return JSON.stringify({ url: url.trim(), token: token.trim() });
}

/** Why a probe sent no token: none typed or stored, one stored for another URL, or a store that could not be read. */
export type NoTokenReason = "none" | "other-url" | "unreadable";

/** The stored bearer for `endpoint`, or why there is none. Anything but `{url, token}` for this URL is no token. */
export function storedBearerFor(raw: string | null, endpoint: string): { token: string; reason: NoTokenReason | null } {
  let stored: unknown = null;
  try {
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    stored = null;
  }
  const value = typeof stored === "object" && stored !== null ? stored as Record<string, unknown> : null;
  if (value === null || typeof value.url !== "string" || typeof value.token !== "string" || !value.token.trim()) {
    return { token: "", reason: "none" };
  }
  return value.url.trim() === endpoint.trim() ? { token: value.token, reason: null } : { token: "", reason: "other-url" };
}

/** A refusal of a request that carried no token says so, and why none was sent, instead of "rejected or expired". */
export function remoteMcpFailureMessage(message: string, sentToken: string, reason: NoTokenReason = "none"): string {
  if (!isRemoteMcpAuthenticationError(message) || sentToken.trim()) return message;
  const why = reason === "other-url"
    ? "the token stored for this connector belongs to its other URL"
    : reason === "unreadable"
      ? "the system's credential store could not be read"
      : "none typed or stored for this connector";
  return `remote MCP authentication was refused: no token was sent (${why}). Enter a bearer token, then connect.`;
}

/**
 * The token a connector row's Reconnect sends: the one typed in the form, only
 * while the form shows that row's URL. It sent whatever the field held, typed
 * for whichever URL (M3-02 check, 06/10/2026).
 */
export function reconnectToken(formUrl: string, typedToken: string, entryUrl: string): string {
  return formUrl.trim() === entryUrl.trim() ? typedToken : "";
}

/** Longest bearer a conversation's connector header accepts ("Bearer " + token, `mcp_session_config`). */
export const MAX_BEARER_CHARS = 1_993;
/** Windows Credential Manager keeps 2,560 bytes of UTF-16: the stored `{url, token}`, at most this long. */
export const MAX_WINDOWS_STORED_CHARS = 1_280;

/**
 * Why a bearer cannot be used, or null. Over the header limit every new
 * conversation failed while Use in Muse was on; over the Windows store limit
 * the save failed as "store unavailable" (M3-02 check, 06/10/2026).
 */
export function bearerTokenProblem(url: string, token: string, platform = hostPlatform()): string | null {
  const length = token.trim().length;
  if (length > MAX_BEARER_CHARS) {
    return `This bearer token has ${length} characters: a Muse conversation accepts at most ${MAX_BEARER_CHARS}. Use a shorter token.`;
  }
  if (platform === "windows" && encodeStoredBearer(url, token).length > MAX_WINDOWS_STORED_CHARS) {
    return `This bearer token has ${length} characters: Windows Credential Manager cannot keep it with this URL (${MAX_WINDOWS_STORED_CHARS} characters in all), so Reconnect could not work. Use a shorter token.`;
  }
  return null;
}

export type RemoteRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

function clip(value: string): string {
  if (value.length <= MAX_REMOTE_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_REMOTE_OUTPUT_CHARS)}\n[remote MCP output clipped]`;
}

function describeError(value: unknown): string {
  if (typeof value === "string") return clip(value);
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return clip(message);
  }
  return clip(JSON.stringify(value));
}

function parseTools(value: unknown): ConnectorTool[] {
  if (typeof value !== "object" || value === null) return [];
  const rows = (value as { tools?: unknown }).tools;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      name: typeof row.name === "string" ? row.name.trim() : "",
      description: typeof row.description === "string" ? clip(row.description.trim()) : "",
    }))
    .filter((tool) => tool.name.length > 0 && tool.name.length <= 200)
    .slice(0, MAX_REMOTE_TOOLS);
}

function parseSse(text: string): JsonRpcFrame[] {
  const frames: JsonRpcFrame[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length === 0) return;
    const payload = data.join("\n").trim();
    data = [];
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed === "object" && parsed !== null) frames.push(parsed as JsonRpcFrame);
    } catch {
      // Ignore non-JSON SSE events; the request remains a protocol error if
      // no matching JSON-RPC response is eventually found.
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    else if (line.trim() === "") flush();
  }
  flush();
  return frames;
}

const TIMED_OUT = "remote MCP request timed out";

/**
 * The body, within the request's deadline and size bound. The deadline used
 * to end with the headers: an SSE answer held open then hung the call for
 * good (M3-02 check, 06/10/2026). An SSE stream is read only until the frame
 * answering `expectId` arrives.
 */
async function readBody(response: Response, signal: AbortSignal, expectId?: unknown): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const stop = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  const sse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) throw new Error(TIMED_OUT);
        throw error;
      }
      if (signal.aborted) throw new Error(TIMED_OUT);
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_REMOTE_OUTPUT_CHARS) {
        stop();
        throw new Error(`remote MCP response exceeds ${MAX_REMOTE_OUTPUT_CHARS} characters`);
      }
      if (sse && expectId !== undefined && parseSse(text).some((frame) => frame.id === expectId)) {
        stop();
        return text;
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function readFrames(response: Response, signal: AbortSignal, expectId?: unknown): Promise<JsonRpcFrame[]> {
  if (response.status === 202 || response.status === 204) return [];
  const text = await readBody(response, signal, expectId);
  if (!text.trim()) return [];
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) return parseSse(text);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? [parsed as JsonRpcFrame] : [];
  } catch {
    throw new Error("remote MCP response is not valid JSON or SSE");
  }
}

function defaultRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new Error("remote MCP transport is unavailable in this runtime"));
  }
  return globalThis.fetch(input, init);
}

async function post(
  request: RemoteRequest,
  session: Pick<RemoteMcpSession, "url" | "token" | "sessionId">,
  frame: JsonRpcFrame & { method: string; params?: unknown },
): Promise<{ frames: JsonRpcFrame[]; sessionId: string | null }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (session.token.trim()) headers.Authorization = `Bearer ${session.token.trim()}`;
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REMOTE_MCP_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await request(session.url, {
        method: "POST",
        headers,
        body: JSON.stringify(frame),
        signal: controller.signal,
        // The URL guards check the registered URL only: a redirect would take
        // the bearer wherever the server points (M3-02 check, 06/10/2026).
        redirect: "manual",
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(TIMED_OUT);
      throw new Error(`remote MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Error("remote MCP endpoint answered with a redirect: Muse does not follow it. Register the address it redirects to.");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("remote MCP authentication was rejected or expired");
      }
      // MCP 2025-06-18: an ended session answers 404 to its id, and the client
      // must start a new one (the 404 of an initialize, sent without id, is not that).
      if (response.status === 404 && session.sessionId) throw new Error("remote MCP session expired");
      throw new Error(`remote MCP returned HTTP ${response.status}`);
    }
    const nextSessionId = response.headers.get("Mcp-Session-Id") ?? session.sessionId;
    const frames = await readFrames(response, controller.signal, frame.id);
    return { frames, sessionId: nextSessionId };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function request(
  transport: RemoteRequest,
  session: RemoteMcpSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = session.nextRequestId++;
  const response = await post(
    transport,
    session,
    { jsonrpc: "2.0", id, method, params } as JsonRpcFrame & { method: string; params: unknown },
  );
  session.sessionId = response.sessionId;
  const frame = response.frames.find((candidate) => candidate.id === id);
  if (!frame) throw new Error(`remote MCP response did not match request ${id}`);
  if (frame.error !== undefined) throw new Error(`remote MCP ${method} failed: ${describeError(frame.error)}`);
  return frame.result ?? null;
}

/** Probe a remote endpoint and return only data confirmed by the exchange. */
export async function probeRemoteMcp(
  url: string,
  token = "",
  transport: RemoteRequest = defaultRequest,
  now = Date.now(),
): Promise<RemoteMcpProbeResult> {
  const endpoint = url.trim();
  if (!isRemoteMcpUrlAllowed(endpoint)) {
    throw new Error("remote MCP requires a public HTTPS endpoint");
  }
  const started = now;
  const session: RemoteMcpSession = {
    url: endpoint,
    token,
    sessionId: null,
    protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
    nextRequestId: 1,
  };
  const initialized = await request(transport, session, "initialize", {
    protocolVersion: REMOTE_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "muse-desktop", version: "0.1.0" },
  });
  const init = typeof initialized === "object" && initialized !== null ? initialized as Record<string, unknown> : {};
  const serverInfo = typeof init.serverInfo === "object" && init.serverInfo !== null
    ? init.serverInfo as Record<string, unknown>
    : {};
  session.protocolVersion = typeof init.protocolVersion === "string" && init.protocolVersion.trim()
    ? init.protocolVersion
    : REMOTE_MCP_PROTOCOL_VERSION;
  await post(transport, session, { jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await request(transport, session, "tools/list", {});
  return {
    protocolVersion: session.protocolVersion,
    serverName: typeof serverInfo.name === "string" && serverInfo.name.trim() ? serverInfo.name : "Remote MCP server",
    serverVersion: typeof serverInfo.version === "string" && serverInfo.version.trim() ? serverInfo.version : "unknown",
    sessionId: session.sessionId,
    tools: parseTools(listed),
    durationMs: Math.max(0, Date.now() - started),
  };
}

/** Call a tool through an already authenticated in-memory session. */
export async function callRemoteMcp(
  session: RemoteMcpSession,
  toolName: string,
  argumentsValue: unknown,
  transport: RemoteRequest = defaultRequest,
): Promise<RemoteMcpCallResult> {
  const name = toolName.trim();
  if (!name || name.length > 200) throw new Error("remote MCP tool name is empty or too long");
  const started = Date.now();
  const args = typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {};
  const result = await request(transport, session, "tools/call", { name, arguments: args });
  const object = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  return {
    toolName: name,
    result: object,
    isError: object.isError === true,
    durationMs: Math.max(0, Date.now() - started),
  };
}
