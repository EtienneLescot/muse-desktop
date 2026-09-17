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
});
