/**
 * Normalize the small status payload emitted when a host settles an approval.
 *
 * Resolution can arrive without the renderer's click promise (for example
 * after reconnect). Keeping this parser pure lets the session hook restore
 * the same resume bridge for both paths without trusting raw payload text.
 */

export interface ApprovalResolution {
  approvalId: string | null;
  decision: string | null;
  accepted: boolean;
}

const ACCEPTED_DECISIONS = new Set([
  "allow",
  "allowed",
  "allow_once",
  "allow_once_in_workspace",
  "always_allow",
  "approved",
  "approve",
  "accepted",
  "continue",
  "granted",
  "resolved",
]);

function normalizeDecision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const decision = value.trim().toLowerCase().replace(/\s+/g, "_");
  return decision.length > 0 ? decision : null;
}

/** Whether a host decision represents permission to continue the turn. */
export function isApprovalDecisionAccepted(value: unknown): boolean {
  const decision = normalizeDecision(value);
  return decision !== null && ACCEPTED_DECISIONS.has(decision);
}

/** Parse a host approval status without exposing its raw payload to the UI. */
export function parseApprovalResolution(payload: string): ApprovalResolution {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    const nested = typeof value.resolution === "object" && value.resolution !== null
      ? value.resolution as Record<string, unknown>
      : null;
    const id = value.approvalId ?? value.approval_id ?? value.requestId ?? value.request_id;
    const approvalId = typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
    const decision = normalizeDecision(
      value.decision ?? value.outcome ?? nested?.decision ?? nested?.outcome,
    );
    return {
      approvalId,
      decision,
      accepted: isApprovalDecisionAccepted(decision),
    };
  } catch {
    return { approvalId: null, decision: null, accepted: false };
  }
}
