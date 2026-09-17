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

export interface HostMcpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  mode: "optional";
}

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

/** Convert explicitly enabled local connectors into host startup config. */
export function buildHostMcpServers(entries: ConnectorEntry[]): HostMcpStdioServer[] {
  const result: HostMcpStdioServer[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "local" || entry.status !== "installed" || entry.useInMuse !== true) continue;
    const tokens = entry.command ? tokenizeMcpCommand(entry.command) : null;
    if (tokens === null) continue;
    const key = tokens.join("\u0000");
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
  }
  return result.slice(0, 32);
}
