/**
 * Sub-agent payload helpers (US-6 controls). Dependency-free and unit-tested:
 * the hook owns transport, this module owns parsing only.
 *
 * Wire shape (from the Rust supervisor): JSON `{agent_id, text,
 * childSessionId?, objective?, role?, depth?}`, or legacy tagged/plain text.
 */

export interface ParsedSubagent {
  agentId: string;
  itemId?: string;
  text: string;
  childSessionId?: string;
  objective?: string;
  role?: string;
  depth?: number;
  status?: SubagentStatus;
  /** A host item update is a full replacement rather than a delta. */
  replace?: boolean;
  revision?: number;
}

/** Host-confirmed lifecycle states that can be rendered safely in the UI. */
export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "stopped"
  | "paused"
  | "failed"
  | "unknown";

const STATUS_ALIASES: Record<string, SubagentStatus> = {
  unknown: "unknown",
  queued: "queued",
  pending: "queued",
  running: "running",
  working: "running",
  inprogress: "running",
  started: "running",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  succeeded: "completed",
  success: "completed",
  interrupted: "interrupted",
  interrupt: "interrupted",
  cancelled: "interrupted",
  canceled: "interrupted",
  stopped: "stopped",
  stop: "stopped",
  paused: "paused",
  pause: "paused",
  failed: "failed",
  error: "failed",
};

const SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "queued",
  "running",
  "completed",
  "interrupted",
  "stopped",
  "paused",
  "failed",
  "unknown",
]);

function optionalStatus(value: unknown): SubagentStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return STATUS_ALIASES[normalized] ?? "unknown";
}

function optionalRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function isTerminalSubagentStatus(
  status: SubagentStatus | undefined,
): boolean {
  return status === "completed" || status === "interrupted" ||
    status === "stopped" || status === "failed";
}

export function isSubagentStatus(value: unknown): value is SubagentStatus {
  return typeof value === "string" && SUBAGENT_STATUSES.has(value as SubagentStatus);
}

export function subagentStatusLabel(status: SubagentStatus | undefined): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Completed";
    case "interrupted": return "Interrupted";
    case "stopped": return "Stopped";
    case "paused": return "Paused";
    case "failed": return "Failed";
    default: return "Awaiting host status";
  }
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optionalDepth(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Best-effort parse of a subagent payload: JSON or tagged/plain text.
 * Never throws; unknown shapes collapse to `{agentId: "agent", text}`.
 */
export function parseSubagentPayload(payload: string): ParsedSubagent {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const agentId =
        nonEmptyString(obj.agent_id) ||
        nonEmptyString(obj.id) ||
        nonEmptyString(obj.name) ||
        "agent";
      const text =
        nonEmptyString(obj.text) ??
        nonEmptyString(obj.chunk) ??
        nonEmptyString(obj.output) ??
        (optionalStatus(obj.status ?? obj.state ?? obj.phase ?? obj.event) === undefined
          ? payload
          : "");
      const out: ParsedSubagent = { agentId, text };
      const itemId = nonEmptyString(obj.itemId) ?? nonEmptyString(obj.item_id);
      if (itemId !== undefined) out.itemId = itemId;
      const child =
        nonEmptyString(obj.childSessionId) ||
        nonEmptyString(obj.child_session_id) ||
        nonEmptyString(obj.childSession);
      if (child !== undefined) out.childSessionId = child;
      const objective = nonEmptyString(obj.objective);
      if (objective !== undefined) out.objective = objective;
      const role = nonEmptyString(obj.role);
      if (role !== undefined) out.role = role;
      const depth = optionalDepth(obj.depth);
      if (depth !== undefined) out.depth = depth;
      const status = optionalStatus(obj.status ?? obj.state ?? obj.phase ?? obj.event);
      if (status !== undefined) out.status = status;
      if (obj.replace === true) out.replace = true;
      const revision = optionalRevision(obj.revision);
      if (revision !== undefined) out.revision = revision;
      return out;
    } catch {
      // fall through to plain text
    }
  }
  const m =
    /^\/\*([^*]+)\*\/\s*([\s\S]*)$/.exec(trimmed) ??
    /^([A-Za-z0-9_-]{1,32}):\s+([\s\S]+)$/.exec(trimmed);
  if (m) return { agentId: m[1].trim() || "agent", text: m[2] };
  return { agentId: "agent", text: payload };
}

/**
 * One-line header for a sub-agent block: objective first, then role/depth.
 * Falls back to the first text line, then to a bare activity marker.
 */
export function subagentSummary(p: {
  objective?: string;
  subagentRole?: string;
  depth?: number;
  text: string;
}): string {
  const bits: string[] = [];
  if (p.objective) bits.push(p.objective);
  const attrs: string[] = [];
  if (p.subagentRole) attrs.push(p.subagentRole);
  if (p.depth !== undefined) attrs.push(`depth ${p.depth}`);
  const head = bits.length > 0 ? bits.join(" — ") : (p.text.split("\n")[0]?.slice(0, 90) || "(activity)");
  return attrs.length > 0 ? `${head} (${attrs.join(", ")})` : head;
}

/** Human-readable rendering of a `subagent/readResult` response value. */
export function formatSubagentResult(res: unknown): string {
  if (typeof res === "string") return res.slice(0, 4000);
  if (res !== null && typeof res === "object") {
    const o = res as Record<string, unknown>;
    const summary = nonEmptyString(o.summary);
    const text = nonEmptyString(o.text);
    if (summary !== undefined || text !== undefined) {
      return [summary, text].filter((s) => s !== undefined).join("\n").slice(0, 4000);
    }
  }
  try {
    return JSON.stringify(res, null, 2).slice(0, 4000);
  } catch {
    return String(res).slice(0, 4000);
  }
}

/** Human-readable rendering of a `session/read` drill-down response. */
export function formatDrilldown(res: unknown): string {
  if (res !== null && typeof res === "object") {
    const o = res as Record<string, unknown>;
    const events = o.events;
    if (Array.isArray(events)) {
      return `Child session transcript: ${events.length} event(s).\n` +
        JSON.stringify(events.slice(-20), null, 2).slice(0, 4000);
    }
  }
  return formatSubagentResult(res);
}
