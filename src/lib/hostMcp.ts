/**
 * Build the small, typed MCP configuration accepted by Muse `session/start`.
 *
 * Connector commands are entered as a single command line in the UI because
 * the standalone probe runs through the platform shell. The host's stdio
 * configuration needs an executable plus argv, so this module performs a
 * conservative tokenizer and rejects shell syntax instead of forwarding a
 * command string with surprising semantics.
 */

import type { ConnectorEntry } from "./connectors";
import type { RemoteMcpSession } from "./remoteMcp";

export interface HostMcpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  mode: "optional";
}

export interface HostMcpStreamableHttpServer {
  transport: "streamableHttp";
  url: string;
  headers?: Record<string, string>;
  mode: "optional";
}

export type HostMcpServer = HostMcpStdioServer | HostMcpStreamableHttpServer;

const MAX_TOKENS = 64;
const MAX_TOKEN_CHARS = 1_000;
const SHELL_META = /[&|;<>`$()]/;

/** Tokenize a quoted command line without interpreting shell expansion. */
export function tokenizeMcpCommand(command: string): string[] | null {
  const input = command.trim();
  if (!input || input.length > 2_000 || SHELL_META.test(input)) return null;
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        if (current.length > MAX_TOKEN_CHARS) return null;
        tokens.push(current);
        if (tokens.length > MAX_TOKENS) return null;
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (quote !== null) return null;
  if (tokenStarted) {
    if (current.length > MAX_TOKEN_CHARS) return null;
    tokens.push(current);
  }
  return tokens.length > 0 && tokens.length <= MAX_TOKENS ? tokens : null;
}

/**
 * Convert explicitly enabled local connectors into host startup config.
 *
 * `computerUseServer` is the entry Rust built for the app's own CUA service. It
 * arrives fully formed on purpose: the renderer never composes a driver path or
 * an endpoint, so a compromised renderer cannot aim computer use elsewhere.
 */
export function buildHostMcpServers(
  entries: ConnectorEntry[],
  remoteSessions: Record<string, RemoteMcpSession> = {},
  computerUseServer: HostMcpStdioServer | null = null,
): HostMcpServer[] {
  return hostMcpConfig(entries, remoteSessions, computerUseServer).servers;
}

/** The host config, and the remote connectors whose bearer it hands to the conversation. */
export function hostMcpConfig(
  entries: ConnectorEntry[],
  remoteSessions: Record<string, RemoteMcpSession> = {},
  computerUseServer: HostMcpStdioServer | null = null,
): { servers: HostMcpServer[]; remoteIds: string[] } {
  const result: HostMcpServer[] = [];
  const owners: (string | null)[] = [];
  const seen = new Set<string>();
  if (computerUseServer !== null) {
    const tokens = [computerUseServer.command, ...(computerUseServer.args ?? [])];
    seen.add(`stdio:${tokens.join("\u0000")}`);
    result.push(computerUseServer);
  }
  for (const entry of entries) {
    if (entry.status !== "installed" || entry.useInMuse !== true) continue;
    if (entry.kind === "local") {
      const tokens = entry.command ? tokenizeMcpCommand(entry.command) : null;
      if (tokens === null) continue;
      const key = `stdio:${tokens.join("\u0000")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        transport: "stdio",
        command: tokens[0],
        ...(tokens.length > 1 ? { args: tokens.slice(1) } : {}),
        // An unavailable optional connector must not make a new conversation
        // unusable. The user can inspect its probe status in Extensions.
        mode: "optional",
      });
      continue;
    }
    const session = remoteSessions[entry.id];
    if (!session || !entry.url || session.url !== entry.url) continue;
    const url = session.url.trim();
    if (!url || url.length > 2_000) continue;
    const key = `http:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const token = session.token.trim();
    owners[result.length] = entry.id;
    result.push({
      transport: "streamableHttp",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      mode: "optional",
    });
  }
  return {
    servers: result.slice(0, 32),
    remoteIds: owners.slice(0, 32).filter((id): id is string => typeof id === "string"),
  };
}

/**
 * M3-02: the open conversations whose host was handed this remote connector's
 * bearer (Use in Muse). Forget token, Disconnect, Disable, Remove or Use in
 * Muse off cannot take it back from them.
 */
export function conversationsHoldingRemote(
  handed: Record<string, readonly string[]>,
  connected: readonly string[],
  connectorId: string,
): string[] {
  return connected.filter((sessionId) => handed[sessionId]?.includes(connectorId) === true);
}

/** What each of those conversations is told, in its transcript. */
export function heldBearerLine(connectorName: string, action: string): string {
  return `${connectorName}: ${action} in Extensions, but this conversation's Muse host still has its token: it keeps using it until you use "Reconnect with current connectors" or close the conversation, and a tool already allowed here keeps working without asking.`;
}

/** The connector panel's word on them, or null when none holds the token. */
export function heldBearerNotice(count: number): string | null {
  return count === 0
    ? null
    : `${count} open conversation${count === 1 ? " still has" : "s still have"} its token: ${count === 1 ? "it keeps" : "they keep"} using it until you use "Reconnect with current connectors" on ${count === 1 ? "it" : "them"} or close ${count === 1 ? "it" : "them"}, and a tool already allowed there keeps working without asking.`;
}
