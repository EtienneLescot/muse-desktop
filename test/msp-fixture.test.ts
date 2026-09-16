/**
 * M0-14 protocol fixture tests. These tests exercise a real child process,
 * framed JSON-RPC bytes and the controlled failure modes used by the native
 * supervisor. They never invoke a model or touch a user workspace.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "scripts", "msp-fixture.mjs");

type Frame = Record<string, unknown>;

function startFixture(scenario: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [fixture, scenario], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function writeFrame(child: ChildProcessWithoutNullStreams, frame: Frame): void {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

async function readFrame(child: ChildProcessWithoutNullStreams): Promise<Frame> {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headers = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1] ?? NaN);
      assert.ok(Number.isSafeInteger(length) && length >= 0, "fixture response has a valid length");
      const bodyStart = headerEnd + 4;
      if (buffer.length >= bodyStart + length) {
        const body = buffer.subarray(bodyStart, bodyStart + length);
        return JSON.parse(body.toString("utf8")) as Frame;
      }
    }
    const [chunk] = (await once(child.stdout, "data")) as [Buffer];
    buffer = Buffer.concat([buffer, chunk]);
  }
}

async function initialize(child: ChildProcessWithoutNullStreams): Promise<Frame> {
  writeFrame(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "muse-fixture-test", version: "1" },
    },
  });
  return readFrame(child);
}

function close(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill();
  return once(child, "close").then(() => undefined);
}

test("MSP fixture completes initialize/list/call", async () => {
  const child = startFixture("success");
  try {
    const init = await initialize(child);
    assert.equal(init.id, 1);
    assert.equal((init.result as Frame).serverInfo && ((init.result as Frame).serverInfo as Frame).name, "msp-fixture");
    writeFrame(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    writeFrame(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await readFrame(child);
    assert.equal(listed.id, 2);
    assert.equal(((listed.result as Frame).tools as unknown[]).length, 1);
    writeFrame(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fixture.echo", arguments: { text: "hello" } },
    });
    const called = await readFrame(child);
    assert.equal(called.id, 3);
    assert.equal(
      (((called.result as Frame).content as Frame[])[0].text),
      "hello",
    );
  } finally {
    await close(child);
  }
});

test("MSP fixture can interleave list_changed notifications", async () => {
  const child = startFixture("interleaved");
  try {
    await initialize(child);
    writeFrame(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const notification = await readFrame(child);
    assert.equal(notification.method, "notifications/tools/list_changed");
    const response = await readFrame(child);
    assert.equal(response.id, 2);
  } finally {
    await close(child);
  }
});

test("MSP fixture returns a structured tool rejection", async () => {
  const child = startFixture("reject");
  try {
    await initialize(child);
    writeFrame(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fixture.echo", arguments: {} },
    });
    const response = await readFrame(child);
    assert.equal(response.id, 2);
    assert.equal((response.error as Frame).message, "fixture tool rejected");
  } finally {
    await close(child);
  }
});

test("MSP fixture closes stdout to model a host crash", async () => {
  const child = startFixture("drop");
  try {
    await initialize(child);
    await once(child, "close");
  } finally {
    if (!child.killed) child.kill();
  }
});
