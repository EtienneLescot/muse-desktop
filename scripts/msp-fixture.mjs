#!/usr/bin/env node

/**
 * Deterministic MSP fixture used by protocol/integration tests.
 *
 * It speaks the same line-delimited JSON-RPC framing as the Muse sidecar and
 * deliberately exposes failure modes that are difficult to reproduce with a
 * live model host. The process never reads or writes user files.
 *
 * Scenarios:
 *   success       initialize, tools/list and tools/call succeed
 *   interleaved   emit tools/list_changed before every response
 *   reject        reject tools/call with a stable JSON-RPC error
 *   drop          close stdout after initialize (host crash simulation)
 */

import process from "node:process";

const scenario = process.argv[2] ?? "success";
const validScenarios = new Set(["success", "interleaved", "reject", "drop"]);
if (!validScenarios.has(scenario)) {
  process.stderr.write(`unknown MSP fixture scenario: ${scenario}\n`);
  process.exitCode = 2;
}

const tools = [
  {
    name: "fixture.echo",
    description: "Echo a fixture argument.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
  },
];

let input = Buffer.alloc(0);

function send(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function notifyListChanged() {
  if (scenario === "interleaved") {
    send({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    });
  }
}

function handle(frame) {
  if (frame?.method === "notifications/initialized") return;
  if (typeof frame?.id !== "number") return;

  if (frame.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: frame.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: scenario === "interleaved" } },
        serverInfo: { name: "msp-fixture", version: "1.0.0" },
      },
    });
    if (scenario === "drop") {
      process.stdout.end(() => process.exit(0));
    }
    return;
  }

  if (scenario === "drop") {
    process.stdout.end(() => process.exit(0));
    return;
  }

  notifyListChanged();
  if (frame.method === "tools/list") {
    send({ jsonrpc: "2.0", id: frame.id, result: { tools } });
    return;
  }
  if (frame.method === "tools/call") {
    if (scenario === "reject") {
      send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32001, message: "fixture tool rejected" },
      });
      return;
    }
    const text = frame.params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id: frame.id,
      result: { content: [{ type: "text", text: String(text) }] },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: frame.id,
    error: { code: -32601, message: `fixture method not found: ${frame.method}` },
  });
}

function drain() {
  for (;;) {
    const headerEnd = input.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) return;
    const headers = input.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(headers);
    if (!match) {
      process.stderr.write("fixture received a frame without Content-Length\n");
      process.exitCode = 3;
      return;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length);
    input = input.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body.toString("utf8")));
    } catch {
      process.stderr.write("fixture received invalid JSON\n");
      process.exitCode = 3;
      return;
    }
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));
