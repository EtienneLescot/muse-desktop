import { useEffect, useRef } from "react";
import type { LogEntry } from "../lib/persist";

interface Props {
  entries: LogEntry[];
  sessionId: string | null;
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
      return "you";
    case "assistant":
      return "muse";
    case "subagent":
      return `subagent:${e.agentId ?? "agent"}`;
    case "tool":
      return "tool";
    case "system":
      return "sys";
  }
}

/**
 * Conversation stream for one session. Consecutive assistant chunks are
 * coalesced by the hook into a single entry; sub-agent entries render as
 * collapsible blocks grouped by agent id.
 */
export function StreamView({ entries, sessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    stickRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  if (sessionId === null) return null;

  return (
    <div className="stream" onScroll={onScroll} role="log" aria-live="off">
      {entries.length === 0 && (
        <p className="muted">
          No messages yet. Type a prompt below — history is stored locally and
          restored on restart.
        </p>
      )}
      {entries.map((e) =>
        e.role === "subagent" ? (
          <details key={e.id} className="msg subagent">
            <summary>
              <span className="role">{roleLabel(e)}</span>
              <span className="msg-summary">
                {e.text.split("\n")[0]?.slice(0, 90) || "(activity)"}
              </span>
              <span className="ts">{timeOf(e.ts)}</span>
            </summary>
            <pre>
              {e.text}
              {e.open && <span className="caret" aria-hidden="true" />}
            </pre>
          </details>
        ) : (
          <div key={e.id} className={`msg ${e.role}`}>
            <span className="role">{roleLabel(e)}</span>
            <pre>
              {e.text}
              {e.open && e.role === "assistant" && (
                <span className="caret" aria-hidden="true" />
              )}
            </pre>
            <span className="ts">{timeOf(e.ts)}</span>
          </div>
        ),
      )}
      <div ref={bottomRef} />
    </div>
  );
}
