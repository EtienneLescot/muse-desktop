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

/** Why a bounded recovery attempt could not provide durable progress. */
export type StreamRecoveryNotice = "unsupported" | "failed";

/** Stable, product-facing copy for a recovery notice. */
export function streamRecoveryDetail(notice: StreamRecoveryNotice): string {
  return notice === "unsupported"
    ? "This host does not expose durable recovery yet. Your local transcript is safe; keep the host open for live progress."
    : "Muse could not refresh the host state. Try again or reconnect before sending another message.";
}

/**
 * Return the remaining grace period before an accepted decision should get
 * one silent recovery read. Invalid timestamps fail closed by disabling the
 * timer rather than scheduling an unbounded retry loop.
 */
export function resumeRecoveryDelay(requestedAt: number, now = Date.now()): number | null {
  if (!Number.isFinite(requestedAt) || !Number.isFinite(now)) return null;
  return Math.max(0, STREAM_STALE_AFTER_MS - Math.max(0, now - requestedAt));
}

export type StreamHealth =
  | "idle"
  | "working"
  | "retrying"
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
  /** The host scheduled another attempt and supplied its backoff metadata. */
  retryScheduled?: RetryScheduled | null;
  now: number;
}

/** Host-provided retry metadata kept as ephemeral renderer state. */
export interface RetryScheduled {
  delayMs: number;
  attempt: number | null;
  maxAttempts: number | null;
  reason: string | null;
  turnId?: string;
  scheduledAt: number;
}

/**
 * Reject retry metadata that belongs to a different or already terminal turn.
 *
 * Hosts may deliver buffered notifications after a reconnect. A retry event
 * for an older turn must never repaint the current conversation as retrying.
 * Events without a turn id remain compatible with older hosts and are
 * accepted because there is no safe identity to compare.
 */
export function shouldAcceptRetryScheduled(
  retry: RetryScheduled,
  currentTurnId?: string,
  lastTerminalTurnId?: string,
): boolean {
  const turnId = retry.turnId?.trim();
  if (!turnId) return true;
  if (lastTerminalTurnId !== undefined && turnId === lastTerminalTurnId) return false;
  if (currentTurnId !== undefined && turnId !== currentTurnId) return false;
  return true;
}

/**
 * Parse the additive `turn/retryScheduled` payload without exposing raw host
 * JSON. Unknown or unbounded values are ignored; the caller can fall back to
 * the generic liveness row when an older host omits this metadata.
 */
export function parseRetryScheduled(payload: string, scheduledAt = Date.now()): RetryScheduled | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null) return null;
    const obj = value as Record<string, unknown>;
    const rawDelay = obj.delayMs ?? obj.retryAfterMs;
    if (typeof rawDelay !== "number" || !Number.isFinite(rawDelay)) return null;
    const delayMs = Math.max(0, Math.min(10 * 60_000, Math.round(rawDelay)));
    const integer = (input: unknown): number | null =>
      typeof input === "number" && Number.isInteger(input) && input >= 1 && input <= 100
        ? input
        : null;
    const reason = typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim().slice(0, 180)
      : null;
    const turnId = typeof obj.turnId === "string" && obj.turnId.trim().length > 0
      ? obj.turnId.trim().slice(0, 160)
      : undefined;
    return {
      delayMs,
      attempt: integer(obj.attempt),
      maxAttempts: integer(obj.maxAttempts),
      reason,
      ...(turnId === undefined ? {} : { turnId }),
      scheduledAt,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the least surprising status for the current conversation.
 * Explicit user actions are checked before elapsed time so a quiet approval
 * or input request never gets mislabeled as a stalled model.
 */
export function classifyStreamHealth(input: StreamHealthInput): StreamHealth {
  if (input.stopping) {
    // An interrupt acknowledgement is not a terminal event. Keep the calm
    // stopping copy briefly, then expose the same recovery actions as any
    // other stale stream instead of leaving the user in an endless spinner.
    const elapsed = input.lastEventAt === null
      ? STREAM_STALE_AFTER_MS
      : Math.max(0, input.now - input.lastEventAt);
    return elapsed >= STREAM_STALE_AFTER_MS ? "stalled" : "stopping";
  }
  if (input.pendingApprovals > 0) return "waiting-approval";
  if (input.pendingInputs > 0) return "waiting-input";
  if (!input.running) return "idle";
  if (input.retryScheduled !== undefined && input.retryScheduled !== null) {
    const elapsed = Math.max(0, input.now - input.retryScheduled.scheduledAt);
    // Keep the explicit retry explanation visible through the backoff and a
    // short grace period. If the host never emits the next attempt, the
    // regular stalled state regains the recovery actions.
    if (elapsed < input.retryScheduled.delayMs + STREAM_STALE_AFTER_MS) return "retrying";
  }
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
    case "retrying":
      return "Muse is retrying";
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
    "client/usershell": "command sent",
    shell_output: "shell output",
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
    "turn/stopped": "turn stopped",
    "turn/retryscheduled": "retry scheduled",
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
