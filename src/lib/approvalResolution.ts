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
  /** Host turn that will resume after an accepted decision, when supplied. */
  turnId?: string;
}

/** Minimal approval shape needed to classify the choice currently selected. */
export interface ApprovalDecisionRequest {
  session_id: string;
  request_id: string;
  choices: readonly { choiceId: string; decision: unknown }[];
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

/**
 * Resolve a click against the session-scoped approval snapshot. An unknown
 * request/choice keeps the legacy optimistic path; a known choice is always
 * classified from its current decision so a rejection cannot paint a resume
 * state. Keeping this lookup pure makes the identity boundary testable.
 */
export function isSelectedApprovalAccepted(
  approvals: readonly ApprovalDecisionRequest[],
  sessionId: string,
  approvalId: string,
  choiceId: string,
): boolean {
  const approval = approvals.find(
    (candidate) => candidate.session_id === sessionId && candidate.request_id === approvalId,
  );
  const choice = approval?.choices.find((candidate) => candidate.choiceId === choiceId);
  return choice === undefined ? true : isApprovalDecisionAccepted(choice.decision);
}

/**
 * Legacy hosts omit the `updated` marker on a later approval stage. Once the
 * user has accepted the previous stage, closing the open lane would erase the
 * visible resume bridge and make the conversation look stuck in thinking.
 */
export function shouldCloseApprovalLane(updated: boolean, resumePending: boolean): boolean {
  return !updated && !resumePending;
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
    const rawTurnId = value.turnId ?? value.turn_id ?? nested?.turnId ?? nested?.turn_id;
    const turnId = typeof rawTurnId === "string" && rawTurnId.trim().length > 0
      ? rawTurnId.trim().slice(0, 160)
      : undefined;
    const decision = normalizeDecision(
      value.decision ?? value.outcome ?? nested?.decision ?? nested?.outcome,
    );
    return {
      approvalId,
      decision,
      accepted: isApprovalDecisionAccepted(decision),
      ...(turnId === undefined ? {} : { turnId }),
    };
  } catch {
    return { approvalId: null, decision: null, accepted: false };
  }
}
