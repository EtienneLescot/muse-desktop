import type {
  AllowDecision,
  AllowRule,
  ApprovalRequest,
  ResolvedApproval,
} from "../hooks/useMuseSessions";

interface Props {
  approvals: ApprovalRequest[];
  /** US-15 persisted rules (pattern + scope → allow/prompt/forbidden). */
  rules: AllowRule[];
  onDecision: (sessionId: string, approvalId: string, choiceId: string) => void;
  /** Approve, then memorize an allow rule for this command + scope. */
  onRemember: (approval: ApprovalRequest, choiceId: string) => void;
  /** Effective allowlist decision for one pending request (badge). */
  decisionFor: (approval: ApprovalRequest) => ResolvedApproval;
  onRevoke: (id: string) => void;
  onRuleDecision: (id: string, decision: AllowDecision) => void;
}

const NEXT_DECISION: Record<AllowDecision, AllowDecision> = {
  allow: "prompt",
  prompt: "forbidden",
  forbidden: "allow",
};

function badgeText(resolved: ResolvedApproval): string {
  if (resolved.networkDefaultDeny) return "réseau sans règle : refusé";
  if (resolved.rule === null) return "aucune règle : demande";
  return `règle : ${resolved.rule.decision}`;
}

/**
 * Pending tool-approval requests for the active session. Each request carries
 * the host's own choices (label + scope); the decision is forwarded verbatim
 * via approval/decide. While one is pending, the blocked tool call waits.
 *
 * US-15: each request shows its effective allowlist badge (most-restrictive
 * match, network default-deny), offers "toujours autoriser" (approve +
 * memorize command pattern + scope), and the stored rules can be switched
 * (allow/prompt/forbidden) or revoked below.
 */
export function ApprovalPanel({
  approvals,
  rules,
  onDecision,
  onRemember,
  decisionFor,
  onRevoke,
  onRuleDecision,
}: Props) {
  if (approvals.length === 0 && rules.length === 0) return null;
  return (
    <section className="approvals" aria-label="Pending approvals">
      {approvals.map((a) => {
        const resolved = decisionFor(a);
        const allowChoice = a.choices.find((c) => !c.decision.startsWith("denied"));
        const scopes = [...new Set(a.choices.map((c) => c.scope).filter((s) => s !== ""))];
        return (
          <div key={`${a.session_id}:${a.request_id}`} className="approval">
            <div className="approval-text">
              <strong>
                Approval needed{a.toolName !== "tool" ? `: ${a.toolName}` : ""}
              </strong>{" "}
              <span
                className={`rule-badge rule-${resolved.decision}`}
                title={
                  resolved.rule !== null
                    ? `Motif « ${resolved.rule.scope !== "" ? `${resolved.rule.pattern} · ${resolved.rule.scope}` : resolved.rule.pattern} »`
                    : resolved.networkDefaultDeny
                      ? "Scope réseau sans règle allow : refus effectif"
                      : "Aucune règle allowlist ne correspond"
                }
              >
                {badgeText(resolved)}
              </span>
              <pre>{a.summary}</pre>
              {scopes.length > 0 && (
                <div className="muted approval-scope" title="Host scope">
                  scope : {scopes.join(" · ")}
                </div>
              )}
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
              {allowChoice !== undefined && (
                <button
                  className="remember"
                  title={`Approuver et mémoriser : motif « ${allowChoice.scope !== "" ? `${a.toolName} · ${allowChoice.scope}` : a.toolName} » en allow`}
                  onClick={() => onRemember(a, allowChoice.choiceId)}
                >
                  Toujours autoriser
                </button>
              )}
            </div>
          </div>
        );
      })}
      {rules.length > 0 && (
        <div className="allowlist">
          <div className="muted allowlist-title">
            Allowlist ({rules.length}) — motif + scope persistés après restart
          </div>
          <ul className="allowlist-rows">
            {rules.map((r) => (
              <li key={r.id} className="allowlist-row">
                <button
                  className={`rule-badge rule-${r.decision}`}
                  title="Changer la décision (allow → prompt → forbidden)"
                  onClick={() => onRuleDecision(r.id, NEXT_DECISION[r.decision])}
                >
                  {r.decision}
                </button>
                <code className="allowlist-pattern" title="Motif mémorisé">
                  {r.pattern}
                </code>
                {r.scope !== "" && (
                  <span className="muted allowlist-scope" title="Scope mémorisé">
                    {r.scope}
                  </span>
                )}
                <button
                  className="allowlist-revoke"
                  title="Révoquer cette règle"
                  onClick={() => onRevoke(r.id)}
                >
                  Révoquer
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
