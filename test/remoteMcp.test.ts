import assert from "node:assert/strict";
import test from "node:test";
import { callRemoteMcp, probeRemoteMcp, type RemoteRequest } from "../src/lib/remoteMcp.ts";

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
