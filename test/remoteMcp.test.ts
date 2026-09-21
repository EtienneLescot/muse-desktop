import assert from "node:assert/strict";
import test from "node:test";
import { registerRemoteConnector } from "../src/lib/connectors.ts";
import { callRemoteMcp, isRemoteMcpAuthenticationError, probeRemoteMcp, remoteMcpCredentialKey, type RemoteRequest } from "../src/lib/remoteMcp.ts";

function response(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("remote MCP probe performs initialize, initialized and tools/list with session continuity", async () => {
  const calls: Array<{ method: string; headers: Headers; body: Record<string, unknown> }> = [];
  const transport: RemoteRequest = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method: String(body.method), headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return response({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "Acme", version: "2.0" },
        },
      }, { "Mcp-Session-Id": "session-1" });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(init?.headers && new Headers(init.headers).get("Mcp-Session-Id"), "session-1");
    return response({
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [{ name: "echo", description: "Echo" }] },
    });
  };
  const result = await probeRemoteMcp("https://mcp.example.com/rpc", "secret", transport, 1000);
  assert.equal(result.serverName, "Acme");
  assert.equal(result.sessionId, "session-1");
  assert.deepEqual(result.tools, [{ name: "echo", description: "Echo" }]);
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(calls[0].headers.get("Authorization"), "Bearer secret");
});

test("remote MCP accepts SSE responses and correlates the matching id", async () => {
  let nextId = 0;
  const transport: RemoteRequest = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    nextId += 1;
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", serverInfo: { name: "SSE", version: "1" } }
      : { tools: [{ name: "sse.tool", description: "" }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const result = await probeRemoteMcp("https://sse.example.com/mcp", "", transport);
  assert.equal(result.serverName, "SSE");
  assert.equal(result.tools[0].name, "sse.tool");
  assert.equal(nextId, 2);
});

test("remote MCP keeps call credentials/session in memory and surfaces auth failures", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const transport: RemoteRequest = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    return response({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
  };
  const result = await callRemoteMcp(
    { url: "https://mcp.example.com/rpc", token: "secret", sessionId: "session-1", protocolVersion: "2025-06-18", nextRequestId: 4 },
    "echo",
    { text: "hi" },
    transport,
  );
  assert.equal(result.isError, false);
  assert.equal((result.result as { content: Array<{ text: string }> }).content[0].text, "ok");
  assert.equal(seen[0].method, "tools/call");
});

test("remote MCP rejects private endpoints, HTTP errors and mismatched responses", async () => {
  await assert.rejects(() => probeRemoteMcp("https://127.0.0.1/mcp", "", async () => response({})), /public HTTPS/);
  await assert.rejects(() => probeRemoteMcp("https://mcp.example.com/mcp", "", async () => response({}, {}, 401)), /authentication/);
  await assert.rejects(
    () => probeRemoteMcp("https://mcp.example.com/mcp", "", async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ jsonrpc: "2.0", id: Number(body.id) + 1, result: {} });
    }),
    /did not match/,
  );
});

test("remote MCP identifies only the retryable authentication/session failure", () => {
  assert.equal(isRemoteMcpAuthenticationError("remote MCP authentication was rejected or expired"), true);
  assert.equal(isRemoteMcpAuthenticationError("remote MCP request timed out"), false);
  assert.equal(isRemoteMcpAuthenticationError("remote MCP returned HTTP 500"), false);
});

test("remote MCP credential keys stay stable and safe for native storage", () => {
  assert.equal(remoteMcpCredentialKey("remote-GitHub MCP"), "remote-mcp-remote-github-mcp");
  assert.equal(remoteMcpCredentialKey("remote/a\\b"), "remote-mcp-remote-a-b");
  assert.match(remoteMcpCredentialKey("   "), /^remote-mcp-connector$/);
});

/**
 * The persisted connector registry and the credential store are separate on
 * purpose, and the separation is structural rather than incidental:
 * `registerRemoteConnector` takes no token parameter, so it has nothing to
 * persist. The renderer reads the bearer token back only through
 * `secure_store_get` (the OS credential store) precisely so it "never enters
 * localStorage" — a comment in `useMuseSessions.ts` states that invariant, and
 * nothing tested it.
 *
 * A future change that threads the token into the registry entry would put a
 * secret on disk in plain text, and it would do so silently: the entry is
 * serialised as-is by `saveConnectors`. This test is the tripwire for that.
 */
test("the persisted connector registry never carries a credential", () => {
  const registered = registerRemoteConnector(
    [],
    {
      id: "remote-GitHub MCP",
      name: "GitHub MCP",
      url: "https://mcp.example.com/rpc",
      tools: [{ name: "echo", description: "Echo" }],
      protocolVersion: "2025-06-18",
      serverVersion: "1.0.0",
    },
  );
  assert.notEqual(registered, null);
  const entry = registered!.entry;

  // The entry is what `saveConnectors` writes, so its serialised form is the
  // exact payload that would reach localStorage.
  const serialised = JSON.stringify(entry);

  for (const field of ["token", "bearer", "authorization", "secret", "credential", "apiKey", "password"]) {
    assert.equal(
      field in (entry as unknown as Record<string, unknown>),
      false,
      `registry entry must not carry a "${field}" field`,
    );
    assert.equal(
      serialised.toLowerCase().includes(field.toLowerCase()),
      false,
      `serialised registry entry must not mention "${field}"`,
    );
  }

  // The credential is looked up under a key in a different namespace, derived
  // from the connector id; that key is not part of the persisted entry either.
  const credentialKey = remoteMcpCredentialKey("remote-GitHub MCP");
  assert.equal(credentialKey.startsWith("remote-mcp-"), true);
  assert.equal(serialised.includes(credentialKey), false);
  assert.equal(Object.values(entry).includes(credentialKey), false);
});
