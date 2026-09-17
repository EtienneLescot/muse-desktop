/**
 * User-facing liveness for a conversation turn.
 *
 * The host can legitimately spend several seconds between events (especially
 * while a model is reasoning), so this is deliberately a soft signal. It
 * never changes the running state or cancels work; it only tells the user
 * when reconnecting or stopping is worth considering.
 */

/** A quiet stream becomes actionable after this interval. */
export const STREAM_STALE_AFTER_MS = 15_000;

export type StreamHealth =
  | "idle"
  | "working"
  | "resuming"
  | "stopping"
  | "waiting-approval"
  | "waiting-input"
  | "waiting-host"
  | "stalled";

export interface StreamHealthInput {
  running: boolean;
  /** A user cancellation has been accepted; wait for host confirmation. */
  stopping?: boolean;
  lastEventAt: number | null;
  pendingApprovals: number;
  pendingInputs: number;
  /** A decision was accepted; wait for the next host event before calling it working. */
  resumePendingAt?: number | null;
  now: number;
}

/**
 * Derive the least surprising status for the current conversation.
 * Explicit user actions are checked before elapsed time so a quiet approval
 * or input request never gets mislabeled as a stalled model.
 */
export function classifyStreamHealth(input: StreamHealthInput): StreamHealth {
  if (input.stopping) return "stopping";
  if (input.pendingApprovals > 0) return "waiting-approval";
  if (input.pendingInputs > 0) return "waiting-input";
  if (!input.running) return "idle";
  if (input.resumePendingAt !== undefined && input.resumePendingAt !== null) {
    const elapsed = Math.max(0, input.now - input.resumePendingAt);
    return elapsed >= STREAM_STALE_AFTER_MS ? "stalled" : "resuming";
  }
  if (input.lastEventAt === null) return "waiting-host";
  const elapsed = Math.max(0, input.now - input.lastEventAt);
  return elapsed >= STREAM_STALE_AFTER_MS ? "stalled" : "working";
}

/** Stable wording for the compact status row in the conversation stream. */
export function streamHealthLabel(health: StreamHealth): string {
  switch (health) {
    case "working":
      return "Muse is working";
    case "resuming":
      return "Muse is resuming";
    case "stopping":
      return "Stopping Muse";
    case "waiting-approval":
      return "Waiting for your approval";
    case "waiting-input":
      return "Waiting for your answer";
    case "waiting-host":
      return "Waiting for the desktop host";
    case "stalled":
      return "No recent host update";
    case "idle":
      return "Ready for your next message";
  }
}

/**
 * Turn an internal event kind into a compact, user-facing progress hint.
 * Event names are transport details, so keep the mapping allowlisted instead
 * of exposing raw host strings in the conversation UI.
 */
export function streamEventLabel(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const normalized = kind.trim().toLowerCase().replace(/\\/g, "/");
  const labels: Record<string, string> = {
    "client/send": "message accepted",
    "client/steer": "steering accepted",
    "client/approval": "authorization sent",
    "client/input": "answer sent",
    "history/reconciled": "conversation synchronized",
    output: "response update",
    thinking: "reasoning update",
    reasoning: "reasoning update",
    "item/started": "work item started",
    item_started: "work item started",
    "item/done": "work item completed",
    item_done: "work item completed",
    tool_request: "tool request",
    input_request: "waiting for your answer",
    "approval/resolved": "authorization resolved",
    "approval/updated": "authorization updated",
    status: "status update",
    subagent_event: "sub-agent update",
    "turn/completed": "turn completed",
    "turn/retracted": "turn cancelled",
    host_exited: "host disconnected",
  };
  const exact = labels[normalized];
  if (exact) return exact;
  // A bounded fallback helps future additive event kinds remain diagnosable
  // without rendering arbitrary payload text in the UI.
  const compact = normalized
    .replace(/^turn\//, "")
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  return `${compact.slice(0, 48)}${compact.length > 48 ? "…" : ""}`;
}

/** Human-readable elapsed time without noisy millisecond precision. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
