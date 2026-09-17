import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHostMcpServers, tokenizeMcpCommand } from "../src/lib/hostMcp.ts";
import type { ConnectorEntry } from "../src/lib/connectors.ts";

const local = (overrides: Partial<ConnectorEntry> = {}): ConnectorEntry => ({
  id: "local-test",
  name: "Test",
  description: "Test connector",
  kind: "local",
  tools: [{ name: "test", description: "test" }],
  status: "installed",
  command: "node server.js --stdio",
  addedAt: 1,
  useInMuse: true,
  ...overrides,
});

describe("host MCP session configuration", () => {
  it("tokenizes quoted executable paths without shell expansion", () => {
    assert.deepEqual(tokenizeMcpCommand('"C:\\Program Files\\node.exe" server.js'), [
      "C:\\Program Files\\node.exe",
      "server.js",
    ]);
    assert.equal(tokenizeMcpCommand("node server.js && whoami"), null);
    assert.equal(tokenizeMcpCommand("'unterminated"), null);
  });

  it("only attaches explicitly enabled, installed local connectors", () => {
    assert.deepEqual(buildHostMcpServers([
      local(),
      local({ id: "disabled", status: "disabled" }),
      local({ id: "opt-out", useInMuse: false }),
      local({ id: "remote", kind: "remote", command: undefined }),
    ]), [{
      transport: "stdio",
      command: "node",
      args: ["server.js", "--stdio"],
      mode: "optional",
    }]);
  });

  it("attaches a connected remote only with its in-memory bearer", () => {
    const remote = local({
      id: "remote-test",
      kind: "remote",
      command: undefined,
      url: "https://mcp.example.test/sse",
      useInMuse: true,
    });
    assert.deepEqual(buildHostMcpServers([remote], {
      "remote-test": {
        url: "https://mcp.example.test/sse",
        token: "secret-token",
        sessionId: "session-1",
        protocolVersion: "2025-06-18",
        nextRequestId: 3,
      },
    }), [{
      transport: "streamableHttp",
      url: "https://mcp.example.test/sse",
      headers: { Authorization: "Bearer secret-token" },
      mode: "optional",
    }]);
    assert.deepEqual(buildHostMcpServers([remote]), []);
  });
});
