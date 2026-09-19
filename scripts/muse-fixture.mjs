#!/usr/bin/env node

/**
 * Deterministic Muse MSP fixture for the approval/recovery contract.
 *
 * This is intentionally separate from scripts/msp-fixture.mjs: MCP uses
 * Content-Length framing, while a Muse sidecar uses one JSON-RPC object per
 * newline. The fixture keeps one durable in-memory store for the lifetime of
 * the process and never reads or writes a user workspace.
 *
 * Covered flow:
 *   initialize -> session/start -> turn/start -> approval/requested
 *   -> approval/decide -> approval/resolved -> item/* -> turn/completed
 *   -> session/read / approval/listPending / session/resume
 */

import process from "node:process";

const sessions = new Map();
let sessionNumber = 0;
let itemNumber = 0;
let turnNumber = 0;
let approvalNumber = 0;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function stringValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

const instancePrefix = process.env.MUSE_FIXTURE_PREFIX
  ? `${process.env.MUSE_FIXTURE_PREFIX}-`
  : "";

function id(prefix, counter) {
  return `${instancePrefix}${prefix}-${counter}`;
}

function timestamp() {
  return new Date().toISOString();
}

function sessionSnapshot(session, status = session.status) {
  return {
    sessionId: session.sessionId,
    path: session.path,
    workspaceRoot: session.workspaceRoot,
    status,
    approvalMode: { mode: session.approvalMode },
  };
}

function ensureSession(sessionId, workspaceRoot = "C:\\muse-fixture") {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const session = {
    sessionId,
    path: `${sessionId}.jsonl`,
    workspaceRoot,
    status: "idle",
    approvalMode: "promptUnmatched",
    items: [],
    pendingApprovals: [],
    activeTurnId: null,
  };
  sessions.set(sessionId, session);
  return session;
}

function item(session, turnId, kind, text, status = "completed") {
  const value = {
    itemId: id("item", ++itemNumber),
    turnId,
    kind,
    status,
    text,
    displayText: text,
    summary: kind === "reasoning" ? [text] : undefined,
    recordedAt: timestamp(),
  };
  session.items.push(value);
  return value;
}

function errorResponse(frame, code, message, data) {
  send({
    jsonrpc: "2.0",
    id: frame.id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function resultResponse(frame, result) {
  send({ jsonrpc: "2.0", id: frame.id, result });
}

function emitTurnPrelude(session, turnId) {
  notify("turn/started", { sessionId: session.sessionId, turnId });
  const reasoning = {
    itemId: id("item", ++itemNumber),
    turnId,
    kind: "reasoning",
    status: "inProgress",
    text: "I’m checking the project context before running the requested action.",
    summary: ["I’m checking the project context before running the requested action."],
    recordedAt: timestamp(),
  };
  session.items.push(reasoning);
  notify("item/started", { sessionId: session.sessionId, turnId, item: reasoning });
  notify("item/delta", {
    sessionId: session.sessionId,
    turnId,
    itemId: reasoning.itemId,
    delta: "I’m checking the project context before running the requested action.",
  });

  const approvalId = id("approval", ++approvalNumber);
  const requirementId = id("requirement", approvalNumber);
  const pending = {
    approvalId,
    currentRequirementId: requirementId,
    turnId,
    kind: "shell",
    subject: { kind: "shell", command: "git status --short" },
    status: "pending",
  };
  session.pendingApprovals.push(pending);
  notify("approval/requested", {
    sessionId: session.sessionId,
    turnId,
    approvalId,
    currentRequirementId: requirementId,
    subject: pending.subject,
  });
}

function finishApprovedTurn(session, pending, choiceId) {
  const reasoning = session.items.find((entry) => entry.turnId === pending.turnId && entry.kind === "reasoning");
  if (reasoning) {
    reasoning.status = "completed";
    notify("item/updated", { sessionId: session.sessionId, turnId: pending.turnId, item: reasoning });
    // Keep one raw MSP-shaped snapshot in the fixture as well. Real hosts may
    // nest the item and use protocol vocabulary that differs from the bridge's
    // flattened aliases. The renderer must still close the thinking lane.
    notify("item/updated", {
      sessionId: session.sessionId,
      turnId: pending.turnId,
      item: {
        itemId: reasoning.itemId,
        turn_id: pending.turnId,
        kind: "analysis",
        status: "done",
        content: reasoning.text,
        revision: 2,
      },
    });
    notify("item/completed", { sessionId: session.sessionId, turnId: pending.turnId, item: reasoning });
  }
  const tool = item(session, pending.turnId, "toolCall", "git status --short\n(clean fixture workspace)");
  tool.tool = "bash";
  tool.args = JSON.stringify({ command: "git status --short" });
  tool.visibleOutput = "(clean fixture workspace)";
  notify("item/started", { sessionId: session.sessionId, turnId: pending.turnId, item: { ...tool, status: "inProgress" } });
  notify("item/completed", { sessionId: session.sessionId, turnId: pending.turnId, item: tool });
  notify("item/updated", {
    sessionId: session.sessionId,
    turnId: pending.turnId,
    item: {
      itemId: tool.itemId,
      turn_id: pending.turnId,
      kind: "userShell",
      status: "succeeded",
      content: tool.visibleOutput,
      command_text: tool.args,
      revision: 1,
    },
  });
  const assistant = item(session, pending.turnId, "agentMessage", `Action approved (${choiceId}); the fixture turn resumed successfully.`);
  notify("item/started", { sessionId: session.sessionId, turnId: pending.turnId, item: assistant });
  notify("item/delta", {
    sessionId: session.sessionId,
    turnId: pending.turnId,
    itemId: assistant.itemId,
    delta: assistant.text,
  });
  notify("item/completed", { sessionId: session.sessionId, turnId: pending.turnId, item: assistant });
  session.status = "idle";
  session.activeTurnId = null;
  notify("turn/completed", {
    sessionId: session.sessionId,
    turnId: pending.turnId,
    status: "completed",
    usage: { inputTokens: 12, outputTokens: 19 },
  });
}

function handle(frame) {
  if (!frame || typeof frame !== "object") return;
  if (frame.method === "initialized" || frame.method === "notifications/initialized") return;
  if (typeof frame.id !== "number" && typeof frame.id !== "string") return;

  switch (frame.method) {
    case "initialize":
      resultResponse(frame, {
        protocolVersion: "1",
        schema: { version: 1, fingerprint: "muse-fixture-approval" },
        serverInfo: { name: "muse", version: "fixture-1.0.0" },
        sessionDurability: "durable",
        grantedCapabilities: ["userShell"],
      });
      return;
    case "session/start": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const sessionId = id("session", ++sessionNumber);
      const session = ensureSession(sessionId, stringValue(params.workspaceRoot, "C:\\muse-fixture"));
      resultResponse(frame, { session: sessionSnapshot(session) });
      return;
    }
    case "session/read": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const sessionId = stringValue(params.sessionId);
      const session = sessions.get(sessionId);
      if (!session) {
        errorResponse(frame, -32004, `session not found: ${sessionId}`);
        return;
      }
      resultResponse(frame, {
        session: sessionSnapshot(session),
        history: params.excludeItems === true ? { items: [] } : { items: session.items },
        snapshot: { queuedTurns: [] },
      });
      return;
    }
    case "session/resume": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      session.status = session.activeTurnId ? "running" : "idle";
      resultResponse(frame, { session: sessionSnapshot(session) });
      return;
    }
    case "session/list":
      resultResponse(frame, {
        sessions: [...sessions.values()].map((session) => sessionSnapshot(session)),
        nextCursor: null,
      });
      return;
    case "approval/listPending": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      resultResponse(frame, { approvals: session.pendingApprovals });
      return;
    }
    case "turn/start": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      const turnId = id("turn", ++turnNumber);
      const input = Array.isArray(params.input) ? params.input : [];
      const text = input.filter((part) => part?.type === "text").map((part) => part.text).join(" ").trim();
      item(session, turnId, "userMessage", text || "fixture input");
      session.status = "running";
      session.activeTurnId = turnId;
      resultResponse(frame, { status: "accepted", turnId });
      queueMicrotask(() => emitTurnPrelude(session, turnId));
      return;
    }
    case "approval/decide": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      const approvalId = stringValue(params.approvalId);
      const requirementId = stringValue(params.requirementId);
      const choiceId = stringValue(params.choiceId, "allow-once");
      const pending = session?.pendingApprovals.find((entry) => entry.approvalId === approvalId);
      if (!session || !pending) {
        errorResponse(frame, -32054, "unknown or stale approval");
        return;
      }
      if (pending.currentRequirementId !== requirementId) {
        errorResponse(frame, -32053, "approval requirement is stale");
        return;
      }
      session.pendingApprovals = session.pendingApprovals.filter((entry) => entry !== pending);
      resultResponse(frame, { terminal: true });
      queueMicrotask(() => {
        notify("approval/resolved", {
          sessionId: session.sessionId,
          turnId: pending.turnId,
          approvalId,
          requirementId,
          choiceId,
          terminal: true,
        });
        finishApprovedTurn(session, pending, choiceId);
      });
      return;
    }
    case "turn/interrupt": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      const turnId = stringValue(params.turnId, session.activeTurnId ?? "");
      session.status = "idle";
      session.activeTurnId = null;
      resultResponse(frame, { status: "accepted", turnId });
      notify("turn/stopped", { sessionId: session.sessionId, turnId, status: "stopped" });
      return;
    }
    case "session/setApprovalMode": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      session.approvalMode = stringValue(params.mode, session.approvalMode);
      resultResponse(frame, { session: sessionSnapshot(session) });
      notify("session/approvalModeChanged", { sessionId: session.sessionId, mode: session.approvalMode });
      return;
    }
    case "view/page": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      resultResponse(frame, {
        events: session.items.flatMap((entry) => [
          { method: "item/completed", params: { sessionId: session.sessionId, turnId: entry.turnId, item: entry } },
        ]),
        nextCursor: null,
      });
      return;
    }
    default:
      errorResponse(frame, -32601, `fixture method not found: ${frame.method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`fixture received invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
      return;
    }
  }
});

process.stdin.on("end", () => process.exit(0));
