/**
 * Streamable HTTP transport for a remote MCP server.
 *
 * The endpoint and verified tool catalogue may be persisted by the connector
 * registry, but bearer tokens and the MCP session id deliberately stay in the
 * caller's memory. Every connection starts with a real initialize exchange;
 * callers must not present a remote connector as connected from metadata
 * alone.
 */

import { isPublicHttpUrl, type ConnectorTool } from "./connectors.ts";

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

/** Authentication/session failures are safe to retry after a fresh initialize. */
export function isRemoteMcpAuthenticationError(message: string): boolean {
  return /remote MCP authentication was rejected or expired/i.test(message);
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

async function readFrames(response: Response): Promise<JsonRpcFrame[]> {
  if (response.status === 202 || response.status === 204) return [];
  const text = await response.text();
  if (text.length > MAX_REMOTE_OUTPUT_CHARS) {
    throw new Error(`remote MCP response exceeds ${MAX_REMOTE_OUTPUT_CHARS} characters`);
  }
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

function withTimeout(
  request: RemoteRequest,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REMOTE_MCP_TIMEOUT_MS);
  const signal = init.signal ?? controller.signal;
  return request(input, { ...init, signal }).finally(() => globalThis.clearTimeout(timer));
}

async function post(
  request: RemoteRequest,
  session: Pick<RemoteMcpSession, "url" | "token" | "sessionId">,
  frame: JsonRpcFrame & { method: string; params?: unknown },
  expectResponse = true,
): Promise<{ frames: JsonRpcFrame[]; sessionId: string | null }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (session.token.trim()) headers.Authorization = `Bearer ${session.token.trim()}`;
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  let response: Response;
  try {
    response = await withTimeout(request, session.url, {
      method: "POST",
      headers,
      body: JSON.stringify(frame),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("remote MCP request timed out");
    }
    throw new Error(`remote MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("remote MCP authentication was rejected or expired");
    }
    throw new Error(`remote MCP returned HTTP ${response.status}`);
  }
  const nextSessionId = response.headers.get("Mcp-Session-Id") ?? session.sessionId;
  const frames = await readFrames(response);
  if (!expectResponse) return { frames, sessionId: nextSessionId };
  return { frames, sessionId: nextSessionId };
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
  if (!isPublicHttpUrl(endpoint)) {
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
  await post(transport, session, { jsonrpc: "2.0", method: "notifications/initialized" }, false);
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
