import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHostMcpServers,
  conversationsHoldingRemote,
  heldBearerLine,
  heldBearerNotice,
  hostMcpConfig,
  tokenizeMcpCommand,
} from "../src/lib/hostMcp.ts";
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
  it("hands computer use to the host, from the entry Rust built", () => {
    // The renderer never composes a driver path or an endpoint: the entry it
    // forwards is exactly what `computer_mcp_server` returned.
    const entry = {
      transport: "stdio" as const,
      command: "C:\\Users\\u\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
      args: ["mcp", "--socket", "\\\\.\\pipe\\muse-desktop-computer"],
      mode: "optional" as const,
    };
    const servers = buildHostMcpServers([], {}, entry);
    assert.deepEqual(servers, [entry]);
    // Without a live grant the caller passes null, and the host gets nothing.
    assert.deepEqual(buildHostMcpServers([], {}, null), []);
  });

  it("does not attach the same driver twice when it is also a connector", () => {
    const entry = {
      transport: "stdio" as const,
      command: "C:\\cua-driver.exe",
      args: ["mcp", "--socket", "\\\\.\\pipe\\p"],
      mode: "optional" as const,
    };
    const duplicate = local({ command: '"C:\\cua-driver.exe" mcp --socket \\\\.\\pipe\\p' });
    const servers = buildHostMcpServers([duplicate], {}, entry);
    assert.equal(servers.length, 1, "one runtime, one entry");
  });

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

  // M3-02 proof (06/10/2026) and check (F2): Forget token left the bearer with
  // every conversation already started with Use in Muse, and said nothing.
  it("knows which open conversations were handed a remote's bearer, and tells them", () => {
    const remote = local({ id: "remote-test", name: "Acme", kind: "remote", command: undefined, url: "https://mcp.example.test/mcp" });
    const session = { url: "https://mcp.example.test/mcp", token: "t", sessionId: null, protocolVersion: "2025-06-18", nextRequestId: 3 };
    assert.deepEqual(hostMcpConfig([local(), remote], { "remote-test": session }).remoteIds, ["remote-test"]);
    assert.deepEqual(hostMcpConfig([local(), remote], {}).remoteIds, [], "not connected: nothing handed");
    assert.deepEqual(hostMcpConfig([{ ...remote, useInMuse: false }], { "remote-test": session }).remoteIds, []);

    const handed = { a: ["remote-test"], b: ["remote-test"], c: [] };
    assert.deepEqual(conversationsHoldingRemote(handed, ["a", "c"], "remote-test"), ["a"], "b is no longer open");
    const line = heldBearerLine("Acme", "its token was forgotten");
    assert.match(line, /^Acme: its token was forgotten in Extensions, but this conversation's Muse host still has its token/);
    assert.match(line, /until you use "Reconnect with current connectors" or close the conversation/);
    assert.match(line, /a tool already allowed here keeps working without asking/);
    assert.equal(heldBearerNotice(0), null);
    assert.match(heldBearerNotice(1) ?? "", /^1 open conversation still has its token: it keeps using it until/);
    assert.match(heldBearerNotice(2) ?? "", /^2 open conversations still have its token: they keep using it/);
  });
});
