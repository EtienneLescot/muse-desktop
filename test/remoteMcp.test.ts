import assert from "node:assert/strict";
import test from "node:test";
import { registerRemoteConnector } from "../src/lib/connectors.ts";
import {
  REMOTE_MCP_TIMEOUT_MS,
  bearerTokenProblem,
  callRemoteMcp,
  encodeStoredBearer,
  isRemoteMcpAuthenticationError,
  isRemoteMcpSessionExpired,
  probeRemoteMcp,
  reconnectToken,
  remoteMcpCredentialKey,
  remoteMcpFailureMessage,
  storedBearerFor,
  type RemoteRequest,
} from "../src/lib/remoteMcp.ts";

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

// M3-02 native proof, 06/10/2026: a server that ends the MCP session answers
// 404 to its id (MCP 2025-06-18), and the app disconnected on "HTTP 404"
// instead of starting a new session.
test("remote MCP reads a 404 to a session id as an ended session, not to an initialize", async () => {
  const notFound: RemoteRequest = async () => response({ error: "session not found" }, {}, 404);
  await assert.rejects(
    () => callRemoteMcp({ url: "https://mcp.example.com/rpc", token: "t", sessionId: "gone", protocolVersion: "2025-06-18", nextRequestId: 3 }, "echo", {}, notFound),
    (error: Error) => isRemoteMcpSessionExpired(error.message),
  );
  await assert.rejects(() => probeRemoteMcp("https://mcp.example.com/rpc", "t", notFound), /returned HTTP 404/);
  assert.equal(isRemoteMcpSessionExpired("remote MCP returned HTTP 404"), false);
});

// M3-02 native proof, 06/10/2026: a probe under an existing connector's name
// to another URL, token field empty, re-read the stored bearer and sent it there.
// M3-02 check (F1), 06/10/2026: bound by the registry alone, it still crossed
// when the save failed after a probe moved the connector to another URL.
test("a stored bearer is read for the URL it was saved with only", () => {
  const saved = encodeStoredBearer(" https://mcp.example.com/rpc ", "token-a");
  assert.deepEqual(storedBearerFor(saved, "https://mcp.example.com/rpc"), { token: "token-a", reason: null });
  assert.deepEqual(storedBearerFor(saved, "https://mcp.example.com/other"), { token: "", reason: "other-url" });
  assert.deepEqual(storedBearerFor(saved, "https://evil.example.net/rpc"), { token: "", reason: "other-url" });
  // Anything else fails closed: nothing stored, a bare token of unknown URL, garbage.
  for (const raw of [null, "token-a", "{", JSON.stringify({ token: "token-a" }), JSON.stringify({ url: "https://mcp.example.com/rpc", token: "" })]) {
    assert.deepEqual(storedBearerFor(raw, "https://mcp.example.com/rpc"), { token: "", reason: "none" }, String(raw));
  }
});

// After Forget token, Reconnect sent no token and read "rejected or expired";
// and "none stored" also showed when one was stored for another URL.
test("a refusal of a request without a token says no token was sent, and why", () => {
  const rejected = "remote MCP authentication was rejected or expired";
  assert.match(remoteMcpFailureMessage(rejected, ""), /no token was sent \(none typed or stored for this connector\)/);
  assert.match(remoteMcpFailureMessage(rejected, "", "other-url"), /no token was sent \(the token stored for this connector belongs to its other URL\)/);
  assert.match(remoteMcpFailureMessage(rejected, "", "unreadable"), /no token was sent \(the system's credential store could not be read\)/);
  assert.equal(remoteMcpFailureMessage(rejected, "a-token"), rejected);
  assert.equal(remoteMcpFailureMessage("remote MCP returned HTTP 500", ""), "remote MCP returned HTTP 500");
});

// F3: the row's Reconnect sent whatever the token field held, typed for any URL.
test("a row's Reconnect sends the typed token only to the URL it was typed for", () => {
  assert.equal(reconnectToken("https://a.example.com/mcp", "typed", " https://a.example.com/mcp "), "typed");
  assert.equal(reconnectToken("https://b.example.com/mcp", "typed", "https://a.example.com/mcp"), "");
  assert.equal(reconnectToken("", "typed", "https://a.example.com/mcp"), "");
});

// F7: over 1,993 characters every new conversation failed while Use in Muse
// was on; over Windows Credential Manager's 2,560 bytes the save failed.
test("a bearer no conversation header or Windows store can take is refused up front", () => {
  const url = "https://mcp.example.com/rpc";
  assert.equal(bearerTokenProblem(url, "x".repeat(1_993), "linux"), null);
  assert.match(bearerTokenProblem(url, "x".repeat(1_994), "linux") ?? "", /1994 characters: a Muse conversation accepts at most 1993/);
  const fits = 1_280 - encodeStoredBearer(url, "").length;
  assert.equal(bearerTokenProblem(url, "x".repeat(fits), "windows"), null);
  assert.match(bearerTokenProblem(url, "x".repeat(fits + 1), "windows") ?? "", /Windows Credential Manager cannot keep it/);
  assert.equal(bearerTokenProblem(url, "x".repeat(fits + 1), "macos"), null);
});

// F4: fetch followed redirects, so the URL guards checked the first request only.
test("remote MCP never follows a redirect", async () => {
  const seen: Array<RequestInit | undefined> = [];
  const redirect: RemoteRequest = async (_input, init) => {
    seen.push(init);
    return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.net/mcp" } });
  };
  await assert.rejects(() => probeRemoteMcp("https://mcp.example.com/rpc", "secret", redirect), /redirect: Muse does not follow it/);
  assert.equal(seen.length, 1, "nothing sent after the redirect");
  assert.equal(seen[0]?.redirect, "manual", "the browser itself must not follow it either");
});

// F6: the deadline ended with the headers, so an SSE answer held open hung the call.
test("remote MCP reads an SSE answer only until its frame, and times out a stream held open without it", { timeout: 5_000 }, async (t) => {
  const encoder = new TextEncoder();
  const held = (text: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) { if (text) controller.enqueue(encoder.encode(text)); },
  }), { headers: { "content-type": "text/event-stream" } });
  const answered: RemoteRequest = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { serverInfo: { name: "Held", version: "1" } } : { tools: [] };
    return held(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
  };
  assert.equal((await probeRemoteMcp("https://sse.example.com/mcp", "", answered)).serverName, "Held");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const silent = probeRemoteMcp("https://sse.example.com/mcp", "", async () => held(""));
  await new Promise((done) => setImmediate(done));
  t.mock.timers.tick(REMOTE_MCP_TIMEOUT_MS);
  await assert.rejects(silent, /timed out/);
});

test("remote MCP bounds a response body while it streams", { timeout: 5_000 }, async () => {
  const flood: RemoteRequest = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(65_536))); },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(() => probeRemoteMcp("https://mcp.example.com/rpc", "", flood), /exceeds 200000 characters/);
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
