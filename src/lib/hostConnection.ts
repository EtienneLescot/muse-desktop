/**
 * M4-07 — Remote / Cloud execution abstraction (HostConnection).
 *
 * Provides pure contracts and lifecycle state transitions for connecting
 * Muse-Desktop to external execution environments:
 * - Local sidecar (default)
 * - Remote SSH devbox / server
 * - Cloud provisioned runner
 *
 * Zero DOM imports: safe for both Node.js test runner and browser runtime.
 * Sensitive credentials (keys, tokens) are never persisted in plain text,
 * and state transitions follow a strict fail-closed state machine.
 */

export const HOST_CONNECTIONS_SCHEMA = "muse-desktop.host-connections.v1";
export const HOST_CONNECTIONS_KEY = "muse-desktop.host-connections.v1";

export type HostEnvironmentType = "local" | "remote-ssh" | "cloud-runner";

export type HostConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type HostAuthType = "none" | "token" | "key" | "credential-broker";

export const MAX_HOST_CONNECTIONS = 20;
export const MAX_LABEL_LENGTH = 80;
export const MAX_ENDPOINT_LENGTH = 250;
export const MAX_WORKSPACE_PATH_LENGTH = 400;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface HostConnectionConfig {
  id: string;
  label: string;
  type: HostEnvironmentType;
  endpoint: string;
  authType: HostAuthType;
  workspaceRoot: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostConnectionRecord {
  config: HostConnectionConfig;
  state: HostConnectionState;
  latencyMs: number | null;
  lastHeartbeatAt: string | null;
  reconnectAttempts: number;
  errorMessage: string | null;
  activeSessionIds: string[];
}

export interface HostConnectionStore {
  schema: typeof HOST_CONNECTIONS_SCHEMA;
  activeConnectionId: string | null;
  connections: HostConnectionConfig[];
}

/** Sanitize an endpoint string and check scheme compatibility. */
export function sanitizeEndpoint(
  endpoint: string,
  type: HostEnvironmentType,
): { valid: boolean; normalized: string; error?: string } {
  const trimmed = (endpoint || "").trim();
  if (!trimmed) {
    if (type === "local") {
      return { valid: true, normalized: "local://sidecar" };
    }
    return { valid: false, normalized: "", error: "Endpoint cannot be empty" };
  }
  if (trimmed.length > MAX_ENDPOINT_LENGTH) {
    return {
      valid: false,
      normalized: "",
      error: `Endpoint exceeds max length of ${MAX_ENDPOINT_LENGTH} characters`,
    };
  }

  if (type === "local") {
    return { valid: true, normalized: "local://sidecar" };
  }

  if (type === "remote-ssh") {
    const isSshUri = /^ssh:\/\/([^@:]+@)?([a-zA-Z0-9.-]+)(:\d+)?(\/.*)?$/i.test(trimmed);
    const isHostPort = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+(:\d+)?$/i.test(trimmed);
    const isHostOnly = /^[a-zA-Z0-9.-]+(:\d+)?$/i.test(trimmed);
    if (!isSshUri && !isHostPort && !isHostOnly) {
      return {
        valid: false,
        normalized: trimmed,
        error: "Invalid SSH endpoint format (expected ssh://user@host:port or user@host)",
      };
    }
    const normalized = trimmed.startsWith("ssh://") ? trimmed : `ssh://${trimmed}`;
    return { valid: true, normalized };
  }

  if (type === "cloud-runner") {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {
          valid: false,
          normalized: trimmed,
          error: "Cloud runner endpoint must use http:// or https:// protocol",
        };
      }
      return { valid: true, normalized: parsed.origin + parsed.pathname.replace(/\/+$/, "") };
    } catch {
      return {
        valid: false,
        normalized: trimmed,
        error: "Invalid cloud runner URL format",
      };
    }
  }

  return { valid: false, normalized: trimmed, error: "Unknown host environment type" };
}

/** Validate one host connection config safely from unknown JSON input. */
export function parseHostConnectionConfig(raw: unknown): HostConnectionConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id || id.length > 64) return null;

  const rawType = o.type;
  const type: HostEnvironmentType =
    rawType === "remote-ssh" || rawType === "cloud-runner" || rawType === "local"
      ? rawType
      : "local";

  const rawAuth = o.authType;
  const authType: HostAuthType =
    rawAuth === "token" || rawAuth === "key" || rawAuth === "credential-broker"
      ? rawAuth
      : "none";

  const rawLabel = typeof o.label === "string" ? o.label.trim() : "";
  const label = (rawLabel || id).slice(0, MAX_LABEL_LENGTH);

  const rawEndpoint = typeof o.endpoint === "string" ? o.endpoint : "";
  const endpointSanitized = sanitizeEndpoint(rawEndpoint, type);
  const endpoint = endpointSanitized.valid
    ? endpointSanitized.normalized
    : type === "local"
      ? "local://sidecar"
      : "";

  if (!endpoint) return null;

  const workspaceRoot =
    typeof o.workspaceRoot === "string"
      ? o.workspaceRoot.trim().slice(0, MAX_WORKSPACE_PATH_LENGTH)
      : "";

  const hasCredential = o.hasCredential === true;

  const createdAt = typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString();
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : createdAt;

  return {
    id,
    label,
    type,
    endpoint,
    authType,
    workspaceRoot,
    hasCredential,
    createdAt,
    updatedAt,
  };
}

/** Parse and bound a collection of host connection configs. */
export function parseHostConnections(raw: unknown): HostConnectionStore {
  const fallback: HostConnectionStore = {
    schema: HOST_CONNECTIONS_SCHEMA,
    activeConnectionId: null,
    connections: [],
  };

  if (typeof raw !== "object" || raw === null) return fallback;
  const o = raw as Record<string, unknown>;

  const list = Array.isArray(o.connections) ? o.connections : [];
  const connections: HostConnectionConfig[] = [];
  const seenIds = new Set<string>();

  for (const item of list) {
    const parsed = parseHostConnectionConfig(item);
    if (parsed && !seenIds.has(parsed.id)) {
      seenIds.add(parsed.id);
      connections.push(parsed);
      if (connections.length >= MAX_HOST_CONNECTIONS) break;
    }
  }

  const rawActive = typeof o.activeConnectionId === "string" ? o.activeConnectionId : null;
  const activeConnectionId =
    rawActive && seenIds.has(rawActive) ? rawActive : connections[0]?.id ?? null;

  return {
    schema: HOST_CONNECTIONS_SCHEMA,
    activeConnectionId,
    connections,
  };
}

/** Serialize the host connections to a storage-ready JSON string. */
export function serializeHostConnections(store: HostConnectionStore): string {
  const clean: HostConnectionStore = {
    schema: HOST_CONNECTIONS_SCHEMA,
    activeConnectionId: store.activeConnectionId,
    connections: store.connections.map((c) => ({
      id: c.id,
      label: c.label,
      type: c.type,
      endpoint: c.endpoint,
      authType: c.authType,
      workspaceRoot: c.workspaceRoot,
      hasCredential: c.hasCredential,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  };
  return JSON.stringify(clean, null, 2);
}

/** Create a new connection configuration with validated values. */
export function createHostConnection(params: {
  id?: string;
  label: string;
  type: HostEnvironmentType;
  endpoint: string;
  authType?: HostAuthType;
  workspaceRoot?: string;
  hasCredential?: boolean;
}): { config: HostConnectionConfig | null; error?: string } {
  const check = sanitizeEndpoint(params.endpoint, params.type);
  if (!check.valid) {
    return { config: null, error: check.error || "Invalid endpoint" };
  }

  const label = (params.label || "").trim().slice(0, MAX_LABEL_LENGTH);
  if (!label) {
    return { config: null, error: "Connection label cannot be empty" };
  }

  const now = new Date().toISOString();
  const generatedId =
    params.id?.trim() ||
    `host-${params.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const config: HostConnectionConfig = {
    id: generatedId.slice(0, 64),
    label,
    type: params.type,
    endpoint: check.normalized,
    authType: params.authType || "none",
    workspaceRoot: (params.workspaceRoot || "").trim().slice(0, MAX_WORKSPACE_PATH_LENGTH),
    hasCredential: params.hasCredential === true,
    createdAt: now,
    updatedAt: now,
  };

  return { config };
}

/** Initialize a runtime record from a configuration. */
export function createConnectionRecord(config: HostConnectionConfig): HostConnectionRecord {
  return {
    config,
    state: config.type === "local" ? "connected" : "disconnected",
    latencyMs: null,
    lastHeartbeatAt: config.type === "local" ? new Date().toISOString() : null,
    reconnectAttempts: 0,
    errorMessage: null,
    activeSessionIds: [],
  };
}

/** Pure state transition machine for host connection records. */
export function transitionConnectionState(
  record: HostConnectionRecord,
  nextState: HostConnectionState,
  options?: {
    errorMessage?: string | null;
    latencyMs?: number | null;
    heartbeatAt?: string | null;
  },
): HostConnectionRecord {
  const updatedAttempts =
    nextState === "reconnecting"
      ? record.reconnectAttempts + 1
      : nextState === "connected"
        ? 0
        : record.reconnectAttempts;

  const errorMessage =
    options?.errorMessage !== undefined
      ? options.errorMessage
      : nextState === "connected" || nextState === "connecting"
        ? null
        : record.errorMessage;

  const latencyMs =
    options?.latencyMs !== undefined ? options.latencyMs : nextState === "disconnected" ? null : record.latencyMs;

  const lastHeartbeatAt =
    options?.heartbeatAt !== undefined
      ? options.heartbeatAt
      : nextState === "connected"
        ? new Date().toISOString()
        : record.lastHeartbeatAt;

  return {
    ...record,
    state: nextState,
    reconnectAttempts: updatedAttempts,
    errorMessage,
    latencyMs,
    lastHeartbeatAt,
  };
}

/** Compute exponential backoff with bounded jitter. */
export function calculateReconnectBackoff(
  attempts: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (attempts <= 0) return baseMs;
  const factor = Math.min(Math.pow(2, attempts), 32);
  const calculated = baseMs * factor;
  return Math.min(calculated, maxMs);
}

/** Evaluate heartbeat liveness for an active connection. */
export function evaluateHeartbeat(
  record: HostConnectionRecord,
  nowMs: number,
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): { alive: boolean; updatedRecord: HostConnectionRecord } {
  if (record.state !== "connected" || record.config.type === "local") {
    return { alive: record.state === "connected", updatedRecord: record };
  }

  if (!record.lastHeartbeatAt) {
    const dropped = transitionConnectionState(record, "reconnecting", {
      errorMessage: "Heartbeat timeout (no response from remote host)",
    });
    return { alive: false, updatedRecord: dropped };
  }

  const lastTime = new Date(record.lastHeartbeatAt).getTime();
  if (isNaN(lastTime) || nowMs - lastTime > timeoutMs) {
    const dropped = transitionConnectionState(record, "reconnecting", {
      errorMessage: `Heartbeat missed: last response ${Math.round((nowMs - lastTime) / 1000)}s ago`,
    });
    return { alive: false, updatedRecord: dropped };
  }

  return { alive: true, updatedRecord: record };
}

/** Route a command or session to a connection ensuring workspace isolation. */
export function routeSessionToHost(
  sessionId: string,
  records: HostConnectionRecord[],
  targetHostId?: string | null,
): { targetRecord: HostConnectionRecord | null; isolated: boolean; error?: string } {
  if (!sessionId) {
    return { targetRecord: null, isolated: false, error: "Session id is required" };
  }

  // 1. If explicitly requested, match target host
  if (targetHostId) {
    const found = records.find((r) => r.config.id === targetHostId);
    if (!found) {
      return {
        targetRecord: null,
        isolated: false,
        error: `Target host ${targetHostId} not found`,
      };
    }
    return { targetRecord: found, isolated: found.config.type !== "local" };
  }

  // 2. Check if session is already bound to a record
  const existing = records.find((r) => r.activeSessionIds.includes(sessionId));
  if (existing) {
    return { targetRecord: existing, isolated: existing.config.type !== "local" };
  }

  // 3. Default to the local or first connected host
  const localOrConnected =
    records.find((r) => r.config.type === "local") ||
    records.find((r) => r.state === "connected") ||
    records[0] ||
    null;

  return {
    targetRecord: localOrConnected,
    isolated: localOrConnected ? localOrConnected.config.type !== "local" : false,
  };
}

/** Terminate and detach an environment cleanly without leaving orphan routes. */
export function destroyHostEnvironment(
  connectionId: string,
  records: HostConnectionRecord[],
): {
  remaining: HostConnectionRecord[];
  terminatedSessions: string[];
  removedRecord: HostConnectionRecord | null;
} {
  const target = records.find((r) => r.config.id === connectionId) ?? null;
  if (!target) {
    return { remaining: records, terminatedSessions: [], removedRecord: null };
  }

  const terminatedSessions = [...target.activeSessionIds];
  const remaining = records.filter((r) => r.config.id !== connectionId);

  return { remaining, terminatedSessions, removedRecord: target };
}
