/**
 * M0-01c/M0-02c deterministic protocol proof. A real child process speaks
 * the newline-delimited Muse JSON-RPC protocol and holds an approval open
 * until the exact requirement token is returned. This is fixture coverage;
 * native sidecar/UI qualification remains a separate release gate.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "scripts", "muse-fixture.mjs");

type Frame = Record<string, unknown>;

class FixtureClient {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private queue: Frame[] = [];
  private waiters: Array<(frame: Frame) => void> = [];

  constructor() {
    this.child = spawn(process.execPath, [fixture], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.queue.push(frame);
      }
    });
  }

  write(frame: Frame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  read(): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolveFrame) => this.waiters.push(resolveFrame));
  }

  async request(id: number, method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    this.write({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      const frame = await this.read();
      if (frame.id === id) return frame;
      this.queue.push(frame);
    }
  }

  async close(): Promise<void> {
    if (!this.child.killed) this.child.kill();
    await once(this.child, "close");
  }
}

async function bootstrap(client: FixtureClient): Promise<string> {
  const init = await client.request(1, "initialize", {
    protocolVersion: "1",
    capabilities: {},
    clientInfo: { name: "muse-fixture-test", version: "1" },
  });
  assert.equal((init.result as Frame).serverInfo && ((init.result as Frame).serverInfo as Frame).name, "muse");
  assert.equal((init.result as Frame).sessionDurability, "durable");
  client.write({ jsonrpc: "2.0", method: "initialized" });
  const started = await client.request(2, "session/start", { workspaceRoot: "C:\\fixture-workspace" });
  const session = (started.result as Frame).session as Frame;
  assert.equal(session.status, "idle");
  return String(session.sessionId);
}

async function nextNotification(client: FixtureClient, method: string): Promise<Frame> {
  for (;;) {
    const frame = await client.read();
    if (frame.method === method) return frame;
  }
}

test("Muse fixture resumes a turn after a terminal approval", async () => {
  const client = new FixtureClient();
  try {
    const sessionId = await bootstrap(client);
    const turn = await client.request(3, "turn/start", {
      commandId: "command-1",
      sessionId,
      input: [{ type: "text", text: "Inspect the project" }],
    });
    const turnId = String((turn.result as Frame).turnId);
    const requested = await nextNotification(client, "approval/requested");
    const requestParams = requested.params as Frame;
    assert.equal(requestParams.sessionId, sessionId);
    assert.equal(requestParams.turnId, turnId);

    const pending = await client.request(4, "approval/listPending", { sessionId });
    const approvals = (pending.result as Frame).approvals as Frame[];
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].approvalId, requestParams.approvalId);

    const decided = await client.request(5, "approval/decide", {
      commandId: "command-2",
      sessionId,
      approvalId: requestParams.approvalId,
      requirementId: requestParams.currentRequirementId,
      choiceId: "allow-once",
    });
    assert.deepEqual(decided.result, { terminal: true });

    const resolved = await nextNotification(client, "approval/resolved");
    assert.equal((resolved.params as Frame).approvalId, requestParams.approvalId);
    let sawNestedReasoning = false;
    let sawNestedShell = false;
    let completed: Frame | undefined;
    for (;;) {
      const frame = await client.read();
      if (frame.method === "item/updated") {
        const item = ((frame.params as Frame).item ?? {}) as Frame;
        if (item.kind === "analysis" && item.status === "done" && item.turn_id === turnId) {
          sawNestedReasoning = true;
        }
        if (item.kind === "userShell" && item.status === "succeeded" && item.turn_id === turnId) {
          sawNestedShell = true;
        }
      }
      if (frame.method === "turn/completed") {
        completed = frame;
        break;
      }
    }
    assert.equal(sawNestedReasoning, true);
    assert.equal(sawNestedShell, true);
    assert.ok(completed);
    assert.equal((completed.params as Frame).turnId, turnId);

    const after = await client.request(6, "approval/listPending", { sessionId });
    assert.deepEqual((after.result as Frame).approvals, []);
  } finally {
    await client.close();
  }
});

test("Muse fixture keeps a durable transcript across read and resume", async () => {
  const client = new FixtureClient();
  try {
    const sessionId = await bootstrap(client);
    await client.request(3, "turn/start", {
      commandId: "command-1",
      sessionId,
      input: [{ type: "text", text: "Read the project" }],
    });
    const requested = await nextNotification(client, "approval/requested");
    const requestParams = requested.params as Frame;
    await client.request(4, "approval/decide", {
      commandId: "command-2",
      sessionId,
      approvalId: requestParams.approvalId,
      requirementId: requestParams.currentRequirementId,
      choiceId: "allow-once",
    });
    await nextNotification(client, "turn/completed");

    const read = await client.request(5, "session/read", { sessionId, excludeItems: false });
    const history = ((read.result as Frame).history as Frame).items as Frame[];
    assert.ok(history.length >= 4);
    const itemIds = history.map((entry) => entry.itemId);
    assert.equal(new Set(itemIds).size, itemIds.length);
    assert.ok(history.some((entry) => entry.kind === "reasoning"));
    assert.ok(history.some((entry) => entry.kind === "agentMessage"));

    const resumed = await client.request(6, "session/resume", { sessionId, excludeItems: true });
    const session = (resumed.result as Frame).session as Frame;
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.status, "idle");
    const listed = await client.request(7, "session/list");
    assert.equal(((listed.result as Frame).sessions as Frame[]).length, 1);
  } finally {
    await client.close();
  }
});
