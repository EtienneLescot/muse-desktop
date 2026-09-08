import type { MuseSession } from "../hooks/useMuseSessions";

interface Props {
  sessions: MuseSession[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: (id: string) => void;
  onKill: (id: string) => void;
  canStart: boolean;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function timeOf(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Dense session list: switch, stop, delete; running dot + pending count. */
export function SessionSidebar({
  sessions,
  activeId,
  pendingCounts,
  onSelect,
  onNew,
  onCancel,
  onKill,
  canStart,
}: Props) {
  return (
    <div className="session-list">
      <div className="session-list-header">
        <span>Sessions ({sessions.length})</span>
        <button onClick={onNew} disabled={!canStart} title="New session">
          + New
        </button>
      </div>
      {sessions.length === 0 && (
        <p className="muted">No sessions yet. Start one to begin.</p>
      )}
      <ul className="session-items">
        {sessions.map((s) => {
          const pending = pendingCounts[s.session_id] ?? 0;
          const isActive = s.session_id === activeId;
          return (
            <li
              key={s.session_id}
              className={isActive ? "session-item active" : "session-item"}
            >
              <button
                className="session-select"
                onClick={() => onSelect(s.session_id)}
                title={s.session_id}
              >
                <span
                  className="dot"
                  data-running={s.running}
                  title={s.running ? "running" : "stopped"}
                />
                <span className="session-title">{s.title || shortId(s.session_id)}</span>
                {pending > 0 && (
                  <span className="badge" title={`${pending} pending approval(s)`}>
                    {pending}
                  </span>
                )}
              </button>
              <div className="session-meta">
                <span className="muted">{timeOf(s.createdAt)}</span>
                <span className="session-actions">
                  {s.running && (
                    <button
                      onClick={() => onCancel(s.session_id)}
                      title="Stop sidecar (cancel session)"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    onClick={() => onKill(s.session_id)}
                    title="Kill session and delete its local history"
                  >
                    Del
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
