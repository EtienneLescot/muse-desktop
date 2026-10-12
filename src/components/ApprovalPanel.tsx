import { useEffect, useRef } from "react";
import type { ApprovalRequest } from "../hooks/useMuseSessions";
import { choiceIndexForKey, trapTabIndex } from "../lib/a11y";
import { isApprovalDecisionAccepted } from "../lib/approvalResolution";

interface Props {
  approvals: ApprovalRequest[];
  /** Kept optional for callers from older layouts; the control now lives in the composer. */
  authorizationMode?: import("../lib/authorization").AuthorizationMode;
  onAuthorizationModeChange?: (
    mode: import("../lib/authorization").AuthorizationMode,
  ) => void;
  onDecision: (sessionId: string, approvalId: string, choiceId: string) => void;
}

/**
 * Pending tool-approval requests for the active session. Each request carries
 * the host's own choices (label + scope), persistent ones included when the
 * host offers them; the decision is forwarded verbatim via approval/decide.
 * While one is pending, the blocked tool call waits.
 *
 * No client-side rule: the host alone decides what prompts (decision 05/10).
 */
export function ApprovalPanel({ approvals, onDecision }: Props) {
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
        const scopes = [...new Set(a.choices.map((c) => c.scope).filter((s) => s !== ""))];
        return (
          <div
            key={`${a.session_id}:${a.request_id}`}
            className="approval"
            role="group"
            aria-label={`Action needs attention${a.toolName !== "tool" ? ` for ${a.toolName}` : ""}`}
          >
            <div className="approval-text">
              <div className="approval-title-row">
                <strong>
                  {a.toolName !== "tool" ? a.toolName : "Tool action"}
                </strong>
              </div>
              {a.summary !== "" && (
                <details className="approval-details" open>
                  <summary>Review command</summary>
                  <pre>{a.summary}</pre>
                </details>
              )}
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
                    className={isApprovalDecisionAccepted(c.decision) ? "approve" : "deny"}
                    title={`${c.scope} (←/→ to move, Enter to choose)`.trim()}
                    aria-label={`${c.label}${c.scope !== "" ? `, scope ${c.scope}` : ""}`}
                    // The second click of a double-click (detail 2) would be a
                    // second decision: on this card, or on the next stage's
                    // card if it has already replaced this one.
                    onClick={(e) => {
                      if (e.detail > 1) return;
                      onDecision(a.session_id, a.request_id, c.choiceId);
                    }}
                  >
                    {c.label}
                  </button>
                ))
              ) : (
                <span className="muted">No choices supplied by host.</span>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
