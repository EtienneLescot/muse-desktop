import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "../lib/persist";
import { REFLEXIVE_LABEL } from "../lib/phase";
import { subagentSummary } from "../lib/subagent";
import { MessageContent } from "./MessageContent";

/** US-6 controls for one sub-agent block. Read-result and drill-down resolve
 *  to display text (also logged as system lines by the hook); the rest are
 *  fire-and-forget with errors surfaced in the hook error banner. */
export interface SubagentControls {
  onInterrupt: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onResume: (agentId: string) => void;
  onFollowup: (agentId: string, task: string) => void;
  onReadResult: (agentId: string) => Promise<string | null>;
  onDrilldown: (entry: LogEntry) => Promise<string | null>;
}

interface Props {
  entries: LogEntry[];
  sessionId: string | null;
  controls?: SubagentControls;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function roleLabel(e: LogEntry): string {
  switch (e.role) {
    case "user":
      return "Vous";
    case "assistant":
      return "Muse";
    case "subagent":
      return `Agent ${e.agentId ?? ""}`;
    case "tool":
      return "Outil";
    case "system":
      return "Information";
  }
}

function agentOf(e: LogEntry): string {
  return e.agentId ?? e.itemId ?? "agent";
}

/**
 * Conversation stream for one session. Consecutive assistant chunks are
 * coalesced by the hook into a single entry; sub-agent entries render as
 * collapsible blocks grouped by agent id, each with its US-6 controls
 * (interrupt/stop/resume/follow-up/read-result/drill-down).
 */
export function StreamView({ entries, sessionId, controls }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const stickRef = useRef(true);
  const [followupFor, setFollowupFor] = useState<string | null>(null);
  const [followupText, setFollowupText] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    stickRef.current = true;
    setAwayFromBottom(false);
  }, [sessionId]);

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAwayFromBottom(!stickRef.current);
  }

  async function runResult(
    entry: LogEntry,
    kind: "result" | "drilldown",
  ): Promise<void> {
    if (!controls || busy === entry.id) return;
    setBusy(entry.id);
    try {
      const text =
        kind === "result"
          ? await controls.onReadResult(agentOf(entry))
          : await controls.onDrilldown(entry);
      if (text !== null) setShown((cur) => ({ ...cur, [entry.id]: text }));
    } finally {
      setBusy(null);
    }
  }

  function sendFollowup(entry: LogEntry): void {
    if (!controls) return;
    const task = followupText.trim();
    if (!task) return;
    controls.onFollowup(agentOf(entry), task);
    setFollowupFor(null);
    setFollowupText("");
  }

  if (sessionId === null) return null;

  return (
    <div className="stream" onScroll={onScroll} role="log" aria-live="off">
      {entries.length === 0 && (
        <p className="muted">
          Commencez la conversation. Votre historique est conservé localement.
        </p>
      )}
      {entries.map((e) => {
        // US-10 reflexive phase: an open entry with no text yet (send just
        // happened, or `item/started` arrived before the first delta) shows
        // a plain muted label. The label is rendered, never stored: the
        // first delta coalesces into the empty text.
        const reflexive = e.open === true && e.text === "";
        return e.role === "subagent" ? (
          <details key={e.id} className="msg subagent">
            <summary>
              <span className="role">{roleLabel(e)}</span>
              <span className="msg-summary">
                {reflexive
                  ? REFLEXIVE_LABEL
                  : subagentSummary({
                      objective: e.objective,
                      subagentRole: e.subagentRole,
                      depth: e.depth,
                      text: e.text,
                    })}
              </span>
              <span className="ts">{timeOf(e.ts)}</span>
            </summary>
            <pre>
              {reflexive ? (
                <span className="muted">{REFLEXIVE_LABEL}</span>
              ) : (
                e.text
              )}
              {e.open && <span className="caret" aria-hidden="true" />}
            </pre>
            {e.childSessionId && (
              <div className="muted subagent-child">
                child: {e.childSessionId}
              </div>
            )}
            {controls && (
              <div className="subagent-controls">
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onInterrupt(agentOf(e))}
                  title="subagent/interrupt"
                >
                  Interrompre
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onStop(agentOf(e))}
                  title="subagent/stop"
                >
                  Arrêter
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onResume(agentOf(e))}
                  title="subagent/resume"
                >
                  Reprendre
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => {
                    setFollowupFor(followupFor === e.id ? null : e.id);
                    setFollowupText("");
                  }}
                  title="subagent/followupTask"
                >
                  Préciser
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => void runResult(e, "result")}
                  title="subagent/readResult"
                >
                  Lire le résultat
                </button>
                {e.childSessionId && (
                  <button
                    type="button"
                    disabled={busy === e.id}
                    onClick={() => void runResult(e, "drilldown")}
                    title="session/read"
                  >
                    Conversation de l’agent
                  </button>
                )}
              </div>
            )}
            {followupFor === e.id && controls && (
              <div className="subagent-followup">
                <input
                  type="text"
                  value={followupText}
                  placeholder="Votre instruction pour cet agent…"
                  onChange={(ev) => setFollowupText(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") sendFollowup(e);
                    if (ev.key === "Escape") {
                      setFollowupFor(null);
                      setFollowupText("");
                    }
                  }}
                  aria-label="Instruction pour cet agent"
                />
                <button type="button" onClick={() => sendFollowup(e)}>
                  Envoyer
                </button>
              </div>
            )}
            {shown[e.id] && (
              <pre className="subagent-result">{shown[e.id]}</pre>
            )}
          </details>
        ) : (
          <div key={e.id} className={`msg ${e.role}`}>
            <span className="role">{roleLabel(e)}</span>
            {e.role === "assistant" && !reflexive ? (
              <>
                <MessageContent text={e.text} />
                {e.open && <span className="caret" aria-hidden="true" />}
              </>
            ) : (
              <pre>
                {reflexive ? (
                  <span className="muted">{REFLEXIVE_LABEL}</span>
                ) : (
                  e.text
                )}
                {e.open && e.role === "assistant" && (
                  <span className="caret" aria-hidden="true" />
                )}
              </pre>
            )}
            <span className="ts">{timeOf(e.ts)}</span>
          </div>
        );
      })}
      <div ref={bottomRef} />
      {awayFromBottom && (
        <button
          className="jump-to-latest"
          onClick={() => {
            stickRef.current = true;
            setAwayFromBottom(false);
            bottomRef.current?.scrollIntoView({ block: "end" });
          }}
        >
          ↓ Derniers messages
        </button>
      )}
    </div>
  );
}
