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
 *
 * Approvals behave as on the 1.4.2 host
 * (docs/evidence/2026-10-05-roadmap-closure/m0-05-msp-approval-*-1.4.2.json):
 * each stage arrives twice, as the `approval/requested` notification and as
 * the `approval/request` server request; the requirement token is the object
 * `{approvalId, sourceIndex}`; `approval/decide` refuses a choice not offered
 * (-32052), a stale stage (-32053) and a resolved approval (-32051); `abort`
 * resolves as a denial and the turn ends without running the action.
 *
 * Scenario flags, in the turn/start text:
 *   [fixture:two-stage]  a compound command: the first decide answers
 *                        `terminal: false`, the host re-issues the approval
 *                        at stage 1.
 *   [fixture:exit]       the process exits before it answers, as a host
 *                        crashing mid-send (M0-14 E2E).
 */

import { createHash } from "node:crypto";
import process from "node:process";

const sessions = new Map();
let sessionNumber = 0;
let itemNumber = 0;
let turnNumber = 0;
let approvalNumber = 0;
let requestNumber = 0;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function stringValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

// Ids stay unique across the hosts of one app run (one fixture per workspace).
const instancePrefix = `${process.env.MUSE_FIXTURE_PREFIX || `p${process.pid}`}-`;

// The 1.4.2 host's choices (docs/evidence/2026-10-05-roadmap-closure/m0-05-msp-approval-prompt-1.4.2.json).
const choices = [
  { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "abort", label: "Reject", decision: "abort", scope: "once" },
];
// One command per stage of a compound approval.
const stageCommands = ["git status --short", "git diff --stat"];

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
    resolvedApprovals: new Map(),
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

/** `approval/request(ed)` params at the current stage, also the `approval/listPending` row. */
function approvalParams(session, pending) {
  return {
    sessionId: session.sessionId,
    turnId: pending.turnId,
    approvalId: pending.approvalId,
    itemId: pending.approvalId,
    currentRequirementId: { approvalId: pending.approvalId, sourceIndex: pending.stage },
    subject: { kind: "shell", command: stageCommands[pending.stage] },
    availableChoices: choices,
  };
}

/** A stage reaches the client twice, as on 1.4.2: the notification, then the server request. */
function requestApproval(session, pending) {
  const params = approvalParams(session, pending);
  notify("approval/requested", params);
  send({ jsonrpc: "2.0", id: `fixture-request-${++requestNumber}`, method: "approval/request", params });
}

function emitTurnPrelude(session, turnId, stages) {
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

  const pending = { approvalId: id("approval", ++approvalNumber), turnId, stage: 0, stages };
  session.pendingApprovals.push(pending);
  requestApproval(session, pending);
}

function finishTurn(session, pending, choice) {
  const approved = choice.decision === "approved";
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
  // A denial runs nothing: the model is told and ends the turn.
  if (approved) {
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
  }
  const assistant = item(session, pending.turnId, "agentMessage", approved
    ? `Action approved (${choice.choiceId}); the fixture turn resumed successfully.`
    : `Action rejected (${choice.choiceId}); the fixture turn ended without running it.`);
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
  // The client's receipt for an `approval/request`: it carries nothing.
  if (typeof frame.method !== "string") return;
  if (typeof frame.id !== "number" && typeof frame.id !== "string") return;

  switch (frame.method) {
    case "initialize":
      resultResponse(frame, {
        protocolVersion: "1",
        // The supervisor's handshake accepts a `sha256:` fingerprint only.
        schema: { version: 1, fingerprint: `sha256:${createHash("sha256").update("muse-fixture-approval").digest("hex")}` },
        serverInfo: { name: "muse", version: "fixture-1.0.0" },
        sessionDurability: "durable",
        grantedCapabilities: ["userShell"],
      });
      return;
    case "session/start": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const sessionId = id("session", ++sessionNumber);
      const session = ensureSession(sessionId, stringValue(params.workspaceRoot, "C:\\muse-fixture"));
      session.approvalMode = stringValue(params.approvalMode, session.approvalMode);
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
      resultResponse(frame, {
        approvals: session.pendingApprovals.map((pending) => approvalParams(session, pending)),
        userInputs: [],
      });
      return;
    }
    case "turn/start": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      if (!session) {
        errorResponse(frame, -32004, "session not found");
        return;
      }
      const input = Array.isArray(params.input) ? params.input : [];
      const text = input.filter((part) => part?.type === "text").map((part) => part.text).join(" ").trim();
      if (text.includes("[fixture:exit]")) process.exit(1);
      const turnId = id("turn", ++turnNumber);
      item(session, turnId, "userMessage", text || "fixture input");
      session.status = "running";
      session.activeTurnId = turnId;
      resultResponse(frame, { status: "accepted", turnId });
      queueMicrotask(() => emitTurnPrelude(session, turnId, text.includes("[fixture:two-stage]") ? 2 : 1));
      return;
    }
    case "approval/decide": {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      const session = sessions.get(stringValue(params.sessionId));
      const approvalId = stringValue(params.approvalId);
      // Resolved first, then the stage, then the choice: 1.4.2 answers a replay
      // after the end with -32051, and a choice on a moved stage reads as stale.
      const resolution = session?.resolvedApprovals.get(approvalId);
      if (resolution) {
        errorResponse(frame, -32051, `approval ${approvalId} is already resolved`, { kind: "approvalAlreadyResolved", approvalId, resolution, retryable: false });
        return;
      }
      const pending = session?.pendingApprovals.find((entry) => entry.approvalId === approvalId);
      if (!pending) {
        errorResponse(frame, -32050, `approval ${approvalId} not found`, { kind: "approvalNotFound", approvalId, retryable: false });
        return;
      }
      const current = approvalParams(session, pending).currentRequirementId;
      if (params.requirementId?.approvalId !== current.approvalId || params.requirementId?.sourceIndex !== current.sourceIndex) {
        errorResponse(frame, -32053, `approval ${approvalId} requirement is stale`, { kind: "approvalRequirementStale", approvalId, currentRequirementId: current, retryable: false });
        return;
      }
      const choice = choices.find((entry) => entry.choiceId === params.choiceId);
      if (!choice) {
        errorResponse(frame, -32052, `approval ${approvalId} does not offer that choice`, { kind: "approvalChoiceInvalid", approvalId, choiceId: params.choiceId, retryable: false });
        return;
      }
      // A denial ends the approval at any stage; an approval moves to the next stage, if any.
      const terminal = choice.decision !== "approved" || pending.stage + 1 === pending.stages;
      if (terminal) {
        session.pendingApprovals = session.pendingApprovals.filter((entry) => entry !== pending);
        session.resolvedApprovals.set(approvalId, { decision: choice.decision, resolvedBy: "user" });
      } else {
        pending.stage += 1;
      }
      resultResponse(frame, { approvalId, commandId: params.commandId, status: "accepted", terminal });
      queueMicrotask(() => {
        if (!terminal) {
          notify("approval/updated", approvalParams(session, pending));
          requestApproval(session, pending);
          return;
        }
        notify("approval/resolved", {
          sessionId: session.sessionId,
          turnId: pending.turnId,
          approvalId,
          itemId: approvalId,
          decision: choice.decision,
          policyResult: choice.decision === "approved" ? "allow" : "deny",
          resolvedBy: "user",
          decidedByCommandId: params.commandId,
        });
        finishTurn(session, pending, choice);
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
      resultResponse(frame, {
        status: "accepted",
        applyOutcome: "completed",
        commandId: stringValue(params.commandId),
        effectiveMode: { mode: session.approvalMode, source: "approvalReconfigure" },
      });
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
