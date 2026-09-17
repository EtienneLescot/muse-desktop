/**
 * Connectors / MCP registry (US-24 + US-26).
 *
 * Dependency-light and safe to unit-test on the built-in node:test runner.
 *
 * - US-24: a curated in-app directory of LOCAL connectors installs in
 *   1 click (no manual JSON). Installed connectors hot-list their tools
 *   without restart: `listConnectorTools` re-reads the registry on every
 *   call, so there is no cache to invalidate; `diffTools` mirrors the
 *   `notifications/tools/list_changed` semantics for the UI.
 * - US-26: REMOTE entries are accepted only after a real initialize/tools
 *   exchange in `remoteMcp.ts`. A single-remote guard plus an explicit
 *   public-internet/allowlist message applies; private/VPN-style hosts are
 *   refused with a documented failure message. Tokens never enter this
 *   persisted registry.
 *
 * Persistence lives under `muse-desktop.connectors.v1` (localStorage,
 * best-effort). Under node:test there is no localStorage, so load/save
 * degrade gracefully to memory defaults.
 */

import { readStorageJson, writeStorageJson } from "./storage.ts";

/** Local (in-process/sidecar) vs remote (streamable HTTP/SSE). */
export type ConnectorKind = "local" | "remote";

/** Lifecycle state of a registry entry. */
export type ConnectorStatus = "installed" | "disabled" | "error";

/** One tool exposed by a connector. */
export interface ConnectorTool {
  name: string;
  description: string;
}

/** Result of a real local MCP initialize + tools/list exchange. */
export interface LocalMcpProbeResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  tools: ConnectorTool[];
  durationMs: number;
}

/** Result of a real local MCP tools/call exchange. */
export interface LocalMcpCallResult {
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

/** One curated directory entry: installable in 1 click, no JSON. */
export interface CuratedConnector {
  id: string;
  name: string;
  description: string;
  tools: ConnectorTool[];
}

/** One installed registry entry (persisted). */
export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  kind: ConnectorKind;
  tools: ConnectorTool[];
  status: ConnectorStatus;
  /** Remote-only: the configured endpoint URL. */
  url?: string;
  /** Local-only: explicit command used to probe/call this server. */
  command?: string;
  /** Explicit opt-in: pass this local server to new Muse sessions. */
  useInMuse?: boolean;
  /** Local-only: last successful tools/list timestamp. */
  lastProbeAt?: number;
  /** Local-only: server version reported by the last successful probe. */
  serverVersion?: string;
  /** Protocol version reported by the last successful MCP probe. */
  protocolVersion?: string;
  /** Local-only: one-step rollback snapshot from the previous tools/list. */
  previousTools?: ConnectorTool[];
  previousServerVersion?: string;
  /** Remote-only: human-readable guard failure, if the entry is blocked. */
  guardMessage?: string;
  addedAt: number;
}

/** Storage key (all writes confined to `muse-desktop.*`). */
export const CONNECTORS_KEY = "muse-desktop.connectors.v1";

/**
 * Curated in-app directory (reviewed entries; installing one never asks
 * for raw JSON).
 */
export const CURATED_CONNECTORS: CuratedConnector[] = [
  {
    id: "local-filesystem",
    name: "Filesystem",
    description: "Scoped read/write to workspace files.",
    tools: [
      { name: "fs.read", description: "Read a workspace file." },
      { name: "fs.write", description: "Write a workspace file." },
      { name: "fs.list", description: "List a workspace directory." },
    ],
  },
  {
    id: "local-fetch",
    name: "Fetch",
    description: "Fetch public URLs into the context.",
    tools: [
      { name: "fetch.url", description: "GET a public URL as text." },
    ],
  },
  {
    id: "local-sqlite",
    name: "SQLite",
    description: "Query a local SQLite database file.",
    tools: [
      { name: "sqlite.query", description: "Run a read-only SQL query." },
      { name: "sqlite.schema", description: "Describe tables and columns." },
    ],
  },
  {
    id: "local-git",
    name: "Git",
    description: "Inspect local git state (read-only).",
    tools: [
      { name: "git.status", description: "Working-tree status." },
      { name: "git.log", description: "Recent commits." },
      { name: "git.diff", description: "Uncommitted diff." },
    ],
  },
  {
    id: "local-github",
    name: "GitHub",
    description: "Read issues and pull requests via the local CLI auth.",
    tools: [
      { name: "github.issue_read", description: "Read an issue." },
      { name: "github.pr_read", description: "Read a pull request." },
      { name: "github.pr_diff", description: "Diff of a pull request." },
    ],
  },
];

/** Free-like plan: at most one remote connector at a time. */
export const REMOTE_LIMIT = 1;

/**
 * Documented VPN/private-network failure message (US-26 AC): remote MCP
 * requires a public-internet endpoint plus allowlisted IPs; VPN or
 * firewall-private hosts are unreachable from the connector runtime.
 */
export const VPN_FAILURE_MESSAGE =
  "Remote connector unreachable: the host looks like a private/VPN address. " +
  "Remote MCP requires a public-internet HTTPS endpoint with allowlisted IPs; " +
  "VPN or firewall-private hosts (localhost, 10/8, 172.16/12, 192.168/16, " +
  "*.local/*.internal) cannot be reached. Expose the server publicly or run " +
  "it locally as a local connector instead.";

/** Explicit single-remote guard message (US-26 AC). */
export const REMOTE_LIMIT_MESSAGE =
  `Only ${REMOTE_LIMIT} remote connector is allowed on this plan: ` +
  "remove the existing remote connector before adding another. Remote MCP " +
  "also requires a public-internet HTTPS endpoint with allowlisted IPs.";

/** Stable id for a user-named local MCP connector. */
export function localConnectorIdForName(name: string): string {
  return `local-mcp-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Find a curated entry by id, or null. */
export function findCurated(id: string): CuratedConnector | null {
  for (const c of CURATED_CONNECTORS) {
    if (c.id === id) return c;
  }
  return null;
}

/** Find an installed entry by id, or null. */
export function findConnector(
  registry: ConnectorEntry[],
  id: string,
): ConnectorEntry | null {
  for (const e of registry) {
    if (e.id === id) return e;
  }
  return null;
}

/**
 * 1-click install of a LOCAL connector from the curated directory.
 * Idempotent: reinstalling returns the existing entry (`already: true`).
 * Returns null when `dirId` is not a curated entry (unknown ids never
 * install; remote endpoints go through `requestRemoteConnector`).
 */
export function installConnector(
  registry: ConnectorEntry[],
  dirId: string,
  now: number = Date.now(),
): { registry: ConnectorEntry[]; entry: ConnectorEntry; already: boolean } | null {
  const curated = findCurated(dirId);
  if (curated === null) return null;
  const existing = findConnector(registry, dirId);
  if (existing !== null) return { registry, entry: existing, already: true };
  const entry: ConnectorEntry = {
    id: curated.id,
    name: curated.name,
    description: curated.description,
    kind: "local",
    tools: curated.tools.map((t) => ({ ...t })),
    status: "installed",
    addedAt: now,
  };
  return { registry: [...registry, entry], entry, already: false };
}

/** Register a local server only after a real tools/list response. */
export function registerLocalConnector(
  registry: ConnectorEntry[],
  spec: {
    id: string;
    name: string;
    command: string;
    tools: ConnectorTool[];
    serverVersion?: string;
  },
  now: number = Date.now(),
): { registry: ConnectorEntry[]; entry: ConnectorEntry } | null {
  const id = spec.id.trim();
  const name = spec.name.trim();
  const command = spec.command.trim();
  if (!id || !name || !command || spec.tools.length === 0) return null;
  const existing = findConnector(registry, id);
  const entry: ConnectorEntry = {
    id,
    name,
    description: "Verified local MCP server.",
    kind: "local",
    tools: spec.tools.map((tool) => ({
      name: tool.name.trim(),
      description: tool.description.trim(),
    })),
    status: existing?.status === "disabled" ? "disabled" : "installed",
    command,
    lastProbeAt: now,
    ...(spec.serverVersion?.trim() ? { serverVersion: spec.serverVersion.trim() } : {}),
    ...(existing?.tools?.length
      ? { previousTools: existing.tools.map((tool) => ({ ...tool })) }
      : {}),
    ...(existing?.serverVersion
      ? { previousServerVersion: existing.serverVersion }
      : {}),
    addedAt: existing?.addedAt ?? now,
  };
  if (entry.tools.some((tool) => tool.name.length === 0)) return null;
  return {
    registry: existing
      ? registry.map((item) => (item.id === id ? entry : item))
      : [...registry, entry],
    entry,
  };
}

/**
 * Replace the tools from a previously verified local MCP connector.
 *
 * Refresh is deliberately narrower than registration: it can only target an
 * existing local entry with a persisted command, keeps its identity/status,
 * and refuses an empty or malformed tools/list response.
 */
export function refreshLocalConnector(
  registry: ConnectorEntry[],
  id: string,
  tools: ConnectorTool[],
  now: number = Date.now(),
  serverVersion?: string,
): { registry: ConnectorEntry[]; entry: ConnectorEntry } | null {
  const existing = findConnector(registry, id);
  if (existing === null || existing.kind !== "local" || !existing.command) {
    return null;
  }
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const nextTools = tools.map((tool) => ({
    name: tool.name.trim(),
    description: tool.description.trim(),
  }));
  if (nextTools.some((tool) => tool.name.length === 0)) return null;
  const entry: ConnectorEntry = {
    ...existing,
    tools: nextTools,
    lastProbeAt: now,
    previousTools: existing.tools.map((tool) => ({ ...tool })),
    ...(existing.serverVersion
      ? { previousServerVersion: existing.serverVersion }
      : {}),
    ...(serverVersion?.trim() ? { serverVersion: serverVersion.trim() } : {}),
  };
  return {
    registry: registry.map((item) => (item.id === id ? entry : item)),
    entry,
  };
}

/** Restore the immediately preceding valid tools/list snapshot. */
export function rollbackLocalConnector(
  registry: ConnectorEntry[],
  id: string,
): { registry: ConnectorEntry[]; entry: ConnectorEntry } | null {
  const existing = findConnector(registry, id);
  if (
    existing === null ||
    existing.kind !== "local" ||
    !existing.command ||
    !existing.previousTools ||
    existing.previousTools.length === 0
  ) {
    return null;
  }
  const entry: ConnectorEntry = {
    ...existing,
    tools: existing.previousTools.map((tool) => ({ ...tool })),
    ...(existing.previousServerVersion
      ? { serverVersion: existing.previousServerVersion }
      : {}),
  };
  delete entry.previousTools;
  delete entry.previousServerVersion;
  return {
    registry: registry.map((item) => (item.id === id ? entry : item)),
    entry,
  };
}

/** Remove an entry by id. Missing ids are a no-op (`removed: false`). */
export function uninstallConnector(
  registry: ConnectorEntry[],
  id: string,
): { registry: ConnectorEntry[]; removed: boolean } {
  const next = registry.filter((e) => e.id !== id);
  return { registry: next, removed: next.length !== registry.length };
}

/**
 * Enable/disable an entry. Missing ids leave the registry unchanged
 * (`changed: false`).
 */
export function setConnectorEnabled(
  registry: ConnectorEntry[],
  id: string,
  enabled: boolean,
): { registry: ConnectorEntry[]; changed: boolean } {
  let changed = false;
  const next = registry.map((e) => {
    if (e.id !== id) return e;
    const status: ConnectorStatus = enabled ? "installed" : "disabled";
    if (e.status === status) return e;
    changed = true;
    return { ...e, status };
  });
  return { registry: next, changed };
}

/** Toggle host injection without changing connector availability. */
export function setConnectorUseInMuse(
  registry: ConnectorEntry[],
  id: string,
  enabled: boolean,
): ConnectorEntry[] {
  return registry.map((entry) =>
    entry.id === id && entry.kind === "local" && entry.command
      ? { ...entry, useInMuse: enabled }
      : entry,
  );
}

/**
 * Hot-list tools without restart: re-reads the registry on every call
 * (no cache), skipping disabled entries. Callers diff successive results
 * with `diffTools` for `list_changed`-style updates.
 */
export function listConnectorTools(registry: ConnectorEntry[]): ConnectorTool[] {
  const out: ConnectorTool[] = [];
  for (const e of registry) {
    if (e.status !== "installed") continue;
    for (const t of e.tools) out.push({ ...t });
  }
  return out;
}

/** Tool names present in `after` but not `before` (and vice versa). */
export function diffTools(
  before: ConnectorTool[],
  after: ConnectorTool[],
): { added: string[]; removed: string[] } {
  const hasBefore = new Set(before.map((t) => t.name));
  const hasAfter = new Set(after.map((t) => t.name));
  return {
    added: after.map((t) => t.name).filter((n) => !hasBefore.has(n)),
    removed: before.map((t) => t.name).filter((n) => !hasAfter.has(n)),
  };
}

/** True when `url` is an https URL on a plausibly public host. */
export function isPublicHttpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) return false;
  let host = "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0) return false;
  if (host === "localhost") return false;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".localhost") ||
    host === "localhost"
  ) {
    return false;
  }
  // URL.hostname keeps IPv6 brackets. Reject loopback, unspecified,
  // link-local and unique-local ranges before any DNS lookup is attempted.
  if (host.startsWith("[") && host.endsWith("]")) {
    const ipv6 = host.slice(1, -1);
    if (
      ipv6 === "::1" ||
      ipv6 === "::" ||
      ipv6.startsWith("fc") ||
      ipv6.startsWith("fd") ||
      ipv6.startsWith("fe8") ||
      ipv6.startsWith("fe9") ||
      ipv6.startsWith("fea") ||
      ipv6.startsWith("feb")
    ) {
      return false;
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    const second = Number(host.split(".")[1]);
    if (host.startsWith("172.") && second >= 16 && second <= 31) return false;
    if (host.startsWith("127.")) return false;
    if (host.startsWith("169.254.")) return false;
    if (host === "0.0.0.0") return false;
    if (host.startsWith("100.") && Number(host.split(".")[1]) >= 64 && Number(host.split(".")[1]) <= 127) return false;
  }
  return true;
}

export type RemoteGuardCode = "remote-limit" | "private-network";

/** Outcome of requesting a remote (US-26) connector entry. */
export type RemoteRequestResult =
  | { ok: true; registry: ConnectorEntry[]; entry: ConnectorEntry }
  | { ok: false; registry: ConnectorEntry[]; code: RemoteGuardCode; message: string };

/**
 * Validate the guards for a REMOTE connector before a transport attempt.
 * This legacy helper returns a provisional row for callers that only need to
 * inspect the plan limit; real registration must use `registerRemoteConnector`
 * after a successful exchange. Guards, in order:
 * 1. single-remote limit (any existing remote entry blocks a new one);
 * 2. public-internet/allowlist check on the URL (private/VPN hosts are
 *    refused with the documented VPN failure message).
 */
export function requestRemoteConnector(
  registry: ConnectorEntry[],
  spec: { id: string; name: string; url: string },
  now: number = Date.now(),
): RemoteRequestResult {
  const existingRemote = registry.find((e) => e.kind === "remote") ?? null;
  if (existingRemote !== null) {
    return { ok: false, registry, code: "remote-limit", message: REMOTE_LIMIT_MESSAGE };
  }
  if (!isPublicHttpUrl(spec.url)) {
    return { ok: false, registry, code: "private-network", message: VPN_FAILURE_MESSAGE };
  }
  const entry: ConnectorEntry = {
    id: spec.id,
    name: spec.name,
    description: `Remote MCP endpoint ${spec.url} (single-remote plan).`,
    kind: "remote",
    tools: [],
    status: "error",
    url: spec.url,
    guardMessage:
      "Registered, no transport yet: tools will list once the remote " +
      "endpoint is reachable over the public internet with allowlisted IPs.",
    addedAt: now,
  };
  return { ok: true, registry: [...registry, entry], entry };
}

/** Register a remote endpoint only after a real initialize + tools/list exchange. */
export function registerRemoteConnector(
  registry: ConnectorEntry[],
  spec: {
    id: string;
    name: string;
    url: string;
    tools: ConnectorTool[];
    protocolVersion?: string;
    serverVersion?: string;
  },
  now: number = Date.now(),
): { registry: ConnectorEntry[]; entry: ConnectorEntry } | null {
  const id = spec.id.trim();
  const name = spec.name.trim();
  const url = spec.url.trim();
  if (!id || !name || !isPublicHttpUrl(url) || !Array.isArray(spec.tools)) return null;
  const tools = spec.tools
    .map((tool) => ({ name: tool.name.trim(), description: tool.description.trim() }))
    .filter((tool) => tool.name.length > 0 && tool.name.length <= 200);
  if (tools.length !== spec.tools.length) return null;
  const existing = findConnector(registry, id);
  const entry: ConnectorEntry = {
    id,
    name,
    description: `Verified remote MCP endpoint ${url}.`,
    kind: "remote",
    tools,
    status: existing?.status === "disabled" ? "disabled" : "installed",
    url,
    lastProbeAt: now,
    ...(spec.protocolVersion?.trim() ? { protocolVersion: spec.protocolVersion.trim() } : {}),
    ...(spec.serverVersion?.trim() ? { serverVersion: spec.serverVersion.trim() } : {}),
    addedAt: existing?.addedAt ?? now,
  };
  return {
    registry: existing
      ? registry.map((item) => (item.id === id ? entry : item))
      : [...registry, entry],
    entry,
  };
}

function isValidEntry(e: unknown): e is ConnectorEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    (r["id"] as string).length > 0 &&
    typeof r["name"] === "string" &&
    (r["kind"] === "local" || r["kind"] === "remote") &&
    Array.isArray(r["tools"])
  );
}

/** Load the persisted registry; corrupt/missing data yields []. */
export function loadConnectors(): ConnectorEntry[] {
  const parsed = readStorageJson<unknown>(CONNECTORS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidEntry).map((e) => ({
      ...e,
      tools: e.tools.filter(
        (t): t is ConnectorTool =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as ConnectorTool).name === "string",
      ),
      status:
        e.status === "installed" || e.status === "disabled" || e.status === "error"
          ? e.status
          : "installed",
      command: typeof e.command === "string" ? e.command : undefined,
      useInMuse: e.useInMuse === true,
      lastProbeAt: typeof e.lastProbeAt === "number" ? e.lastProbeAt : undefined,
      serverVersion: typeof e.serverVersion === "string" ? e.serverVersion : undefined,
      protocolVersion: typeof e.protocolVersion === "string" ? e.protocolVersion : undefined,
      previousTools: Array.isArray(e.previousTools)
        ? e.previousTools.filter(
            (t): t is ConnectorTool =>
              typeof t === "object" &&
              t !== null &&
              typeof (t as ConnectorTool).name === "string",
          )
        : undefined,
      previousServerVersion:
        typeof e.previousServerVersion === "string" ? e.previousServerVersion : undefined,
    }));
}

/** Persist the registry (best-effort: quota/private mode never throws). */
export function saveConnectors(registry: ConnectorEntry[]): void {
  writeStorageJson(CONNECTORS_KEY, registry);
}
