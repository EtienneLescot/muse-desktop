import type { ApprovalRequest } from "../hooks/useMuseSessions";

interface Props {
  approvals: ApprovalRequest[];
  onDecision: (sessionId: string, approvalId: string, choiceId: string) => void;
}

/**
 * Pending tool-approval requests for the active session. Each request carries
 * the host's own choices (label + scope); the decision is forwarded verbatim
 * via approval/decide. While one is pending, the blocked tool call waits.
 */
export function ApprovalPanel({ approvals, onDecision }: Props) {
  if (approvals.length === 0) return null;
  return (
    <section className="approvals" aria-label="Pending approvals">
      {approvals.map((a) => (
        <div key={`${a.session_id}:${a.request_id}`} className="approval">
          <div className="approval-text">
            <strong>
              Approval needed{a.toolName !== "tool" ? `: ${a.toolName}` : ""}
            </strong>
            <pre>{a.summary}</pre>
          </div>
          <div className="approval-actions">
            {a.choices.length > 0 ? (
              a.choices.map((c) => (
                <button
                  key={c.choiceId}
                  className={c.decision.startsWith("denied") ? "deny" : "approve"}
                  title={c.scope}
                  onClick={() => onDecision(a.session_id, a.request_id, c.choiceId)}
                >
                  {c.label}
                </button>
              ))
            ) : (
              <span className="muted">No choices supplied by host.</span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
