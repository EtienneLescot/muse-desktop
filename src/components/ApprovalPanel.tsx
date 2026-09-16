import { useEffect, useRef } from "react";
import type {
  AllowDecision,
  AllowRule,
  ApprovalRequest,
  ResolvedApproval,
} from "../hooks/useMuseSessions";
import { choiceIndexForKey, trapTabIndex } from "../lib/a11y";

interface Props {
  approvals: ApprovalRequest[];
  /** Kept optional for callers from older layouts; the control now lives in the composer. */
  authorizationMode?: import("../lib/authorization").AuthorizationMode;
  onAuthorizationModeChange?: (
    mode: import("../lib/authorization").AuthorizationMode,
  ) => void;
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
  if (resolved.networkDefaultDeny) return "network: no rule — denied";
  if (resolved.rule === null) return "no rule — prompt";
  return `rule: ${resolved.rule.decision}`;
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
  // US-32: focus the first decision button when a new approval arrives,
  // and trap Tab inside the panel while a decision is pending.
  const sectionRef = useRef<HTMLElement>(null);
  const prevApprovalKey = useRef<string | null>(null);
  const firstKey =
    approvals.length > 0 ? `${approvals[0].session_id}:${approvals[0].request_id}` : null;
  useEffect(() => {
    if (firstKey !== null && firstKey !== prevApprovalKey.current) {
      prevApprovalKey.current = firstKey;
      const el = sectionRef.current?.querySelector<HTMLButtonElement>(
        ".approval-actions button:not(:disabled)",
      );
      el?.focus();
    } else if (firstKey === null) {
      prevApprovalKey.current = null;
    }
  }, [firstKey]);

  function focusables(): HTMLButtonElement[] {
    const root = sectionRef.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLButtonElement>(".approval-actions button:not(:disabled)")];
  }

  function onSectionKeyDown(e: React.KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target === null || target.tagName !== "BUTTON") return;
    // Focus trap: while a decision is pending, Tab cycles inside the panel.
    if (e.key === "Tab" && approvals.length > 0) {
      const items = focusables();
      const idx = items.indexOf(target as HTMLButtonElement);
      if (idx === -1) return;
      e.preventDefault();
      const next = trapTabIndex(idx, items.length, e.shiftKey);
      if (next !== null) items[next].focus();
      return;
    }
    // Arrow/enter choice navigation between the buttons of one request.
    const group = target.closest(".approval-actions");
    if (!group) return;
    const items = [...group.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const idx = items.indexOf(target as HTMLButtonElement);
    if (idx === -1) return;
    const next = choiceIndexForKey(e.key, idx, items.length);
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    }
  }

  // The authorization posture lives in the composer (and Settings). Keep the
  // approval surface reserved for an action that actually needs attention;
  // an empty posture banner was a duplicate control in every conversation.
  if (approvals.length === 0) return null;

  return (
    <section
      className="approvals approvals-active"
      role="region"
      aria-label="Conversation authorization"
      ref={sectionRef}
      onKeyDown={onSectionKeyDown}
    >
      <header className="approvals-head">
        <div>
          <span className="approval-kicker">Permission review</span>
          <strong>
            {approvals.length} action{approvals.length === 1 ? "" : "s"} waiting
          </strong>
        </div>
      </header>
      {approvals.map((a) => {
        const resolved = decisionFor(a);
        const allowChoice = a.choices.find((c) => !c.decision.startsWith("denied"));
        const scopes = [...new Set(a.choices.map((c) => c.scope).filter((s) => s !== ""))];
        return (
          <div
            key={`${a.session_id}:${a.request_id}`}
            className="approval"
            role="group"
            data-decision={resolved.decision}
            aria-label={`Action needs attention${a.toolName !== "tool" ? ` for ${a.toolName}` : ""}`}
          >
            <div className="approval-text">
              <div className="approval-title-row">
                <strong>
                  {a.toolName !== "tool" ? a.toolName : "Tool action"}
                </strong>
                <span
                  className={`rule-badge rule-${resolved.decision}`}
                  title={
                    resolved.rule !== null
                      ? `Pattern ${resolved.rule.scope !== "" ? `${resolved.rule.pattern} · ${resolved.rule.scope}` : resolved.rule.pattern}`
                      : resolved.networkDefaultDeny
                        ? "Network scope without an allow rule: effectively denied"
                        : "No matching allowlist rule"
                  }
                >
                  {badgeText(resolved)}
                </span>
              </div>
              <details className="approval-details" open>
                <summary>Review command</summary>
                <pre>{a.summary}</pre>
              </details>
              {scopes.length > 0 && (
                <div className="muted approval-scope" title="Host scope">
                  scope: {scopes.join(" · ")}
                </div>
              )}
            </div>
            <div
              className="approval-actions"
              role="group"
              aria-label="Approval choices — arrow keys move, Enter chooses"
            >
              {a.choices.length > 0 ? (
                a.choices.map((c) => (
                  <button
                    key={c.choiceId}
                    className={c.decision.startsWith("denied") ? "deny" : "approve"}
                    title={`${c.scope} (←/→ to move, Enter to choose)`.trim()}
                    aria-label={`${c.label}${c.scope !== "" ? `, scope ${c.scope}` : ""}`}
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
                  title={`Approve and remember: pattern "${allowChoice.scope !== "" ? `${a.toolName} · ${allowChoice.scope}` : a.toolName}" as allow`}
                  onClick={() => onRemember(a, allowChoice.choiceId)}
                >
                  Allow in workspace
                </button>
              )}
            </div>
          </div>
        );
      })}
      {rules.length > 0 && (
        <details className="allowlist">
          <summary className="allowlist-title">
            Saved authorization rules ({rules.length})
          </summary>
          <ul className="allowlist-rows">
            {rules.map((r) => (
              <li key={r.id} className="allowlist-row">
                <button
                  className={`rule-badge rule-${r.decision}`}
                  title="Cycle decision (allow → prompt → forbidden)"
                  onClick={() => onRuleDecision(r.id, NEXT_DECISION[r.decision])}
                >
                  {r.decision}
                </button>
                <code className="allowlist-pattern" title="Remembered pattern">
                  {r.pattern}
                </code>
                {r.scope !== "" && (
                  <span className="muted allowlist-scope" title="Remembered scope">
                    {r.scope}
                  </span>
                )}
                <button
                  className="allowlist-revoke"
                  title="Revoke this rule"
                  onClick={() => onRevoke(r.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
