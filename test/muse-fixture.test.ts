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
  private closed = false;

  constructor(prefix?: string) {
    this.child = spawn(process.execPath, [fixture], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: prefix ? { ...process.env, MUSE_FIXTURE_PREFIX: prefix } : process.env,
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
    if (this.closed) return;
    this.closed = true;
    if (!this.child.killed) this.child.kill();
    await once(this.child, "close");
  }
}

async function bootstrap(client: FixtureClient, workspaceRoot = "C:\\fixture-workspace"): Promise<string> {
  const init = await client.request(1, "initialize", {
    protocolVersion: "1",
    capabilities: {},
    clientInfo: { name: "muse-fixture-test", version: "1" },
  });
  assert.equal((init.result as Frame).serverInfo && ((init.result as Frame).serverInfo as Frame).name, "muse");
  assert.equal((init.result as Frame).sessionDurability, "durable");
  client.write({ jsonrpc: "2.0", method: "initialized" });
  const started = await client.request(2, "session/start", { workspaceRoot });
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

test("Muse fixture isolates concurrent A/B sessions: B terminates abruptly while A completes approval and turn", async () => {
  const clientA = new FixtureClient("host-a");
  const clientB = new FixtureClient("host-b");
  try {
    const sessionA = await bootstrap(clientA, "C:\\fixture-workspace-a");
    const sessionB = await bootstrap(clientB, "C:\\fixture-workspace-b");
    assert.notEqual(sessionA, sessionB);

    const turnA = await clientA.request(3, "turn/start", {
      commandId: "cmd-a-1",
      sessionId: sessionA,
      input: [{ type: "text", text: "Task in workspace A" }],
    });
    const turnB = await clientB.request(3, "turn/start", {
      commandId: "cmd-b-1",
      sessionId: sessionB,
      input: [{ type: "text", text: "Task in workspace B" }],
    });

    const turnIdA = String((turnA.result as Frame).turnId);
    const turnIdB = String((turnB.result as Frame).turnId);
    assert.notEqual(turnIdA, turnIdB);

    const reqA = await nextNotification(clientA, "approval/requested");
    const reqB = await nextNotification(clientB, "approval/requested");
    const paramsA = reqA.params as Frame;
    const paramsB = reqB.params as Frame;
    assert.equal(paramsA.sessionId, sessionA);
    assert.equal(paramsB.sessionId, sessionB);
    assert.notEqual(paramsA.approvalId, paramsB.approvalId);

    // Host B dies abruptly while waiting for approval
    await clientB.close();

    // Host A continues: resolves approval and completes turn
    const decidedA = await clientA.request(4, "approval/decide", {
      commandId: "cmd-a-decide",
      sessionId: sessionA,
      approvalId: paramsA.approvalId,
      requirementId: paramsA.currentRequirementId,
      choiceId: "allow-once",
    });
    assert.deepEqual(decidedA.result, { terminal: true });

    const resolvedA = await nextNotification(clientA, "approval/resolved");
    assert.equal((resolvedA.params as Frame).approvalId, paramsA.approvalId);

    let completedA: Frame | undefined;
    for (;;) {
      const frame = await clientA.read();
      if (frame.method === "turn/completed") {
        completedA = frame;
        break;
      }
    }
    assert.ok(completedA);
    assert.equal((completedA.params as Frame).turnId, turnIdA);

    const readA = await clientA.request(5, "session/read", { sessionId: sessionA, excludeItems: false });
    const snapshotA = (readA.result as Frame).session as Frame;
    assert.equal(snapshotA.workspaceRoot, "C:\\fixture-workspace-a");
    assert.equal(snapshotA.sessionId, sessionA);
    const historyA = ((readA.result as Frame).history as Frame).items as Frame[];
    assert.ok(historyA.length >= 3);
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
  }
});

test("Muse fixture keeps a pending approval visible once across resume and resumes the same turn", async () => {
  const client = new FixtureClient();
  try {
    const sessionId = await bootstrap(client);
    const turn = await client.request(3, "turn/start", {
      commandId: "command-resume-1",
      sessionId,
      input: [{ type: "text", text: "Resume me after reconnect" }],
    });
    const turnId = String((turn.result as Frame).turnId);
    const requested = await nextNotification(client, "approval/requested");
    const requestParams = requested.params as Frame;

    const before = await client.request(4, "approval/listPending", { sessionId });
    assert.equal(((before.result as Frame).approvals as Frame[]).length, 1);

    const resumed = await client.request(5, "session/resume", { sessionId });
    assert.equal(((resumed.result as Frame).session as Frame).status, "running");

    const pending = await client.request(6, "approval/listPending", { sessionId });
    const approvals = ((pending.result as Frame).approvals as Frame[]);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].approvalId, requestParams.approvalId);
    assert.equal(approvals[0].currentRequirementId, requestParams.currentRequirementId);

    const read = await client.request(7, "session/read", { sessionId, excludeItems: false });
    const itemIds = (((read.result as Frame).history as Frame).items as Frame[]).map((entry) => entry.itemId);
    assert.equal(new Set(itemIds).size, itemIds.length);

    const decided = await client.request(8, "approval/decide", {
      commandId: "command-resume-2",
      sessionId,
      approvalId: requestParams.approvalId,
      requirementId: requestParams.currentRequirementId,
      choiceId: "allow-once",
    });
    assert.deepEqual(decided.result, { terminal: true });

    await nextNotification(client, "approval/resolved");
    const completed = await nextNotification(client, "turn/completed");
    assert.equal((completed.params as Frame).turnId, turnId);

    const after = await client.request(9, "approval/listPending", { sessionId });
    assert.deepEqual((after.result as Frame).approvals, []);
  } finally {
    await client.close();
  }
});
