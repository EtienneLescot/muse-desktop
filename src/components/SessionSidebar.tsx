import { useMemo, useState } from "react";
import type { MuseSession } from "../hooks/useMuseSessions";
import {
  countRunning,
  cycleThreadId,
  selectActiveThreads,
  selectArchivedThreads,
  type CycleDir,
} from "../lib/threads";

interface Props {
  sessions: MuseSession[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: (id: string) => void;
  onKill: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
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

/**
 * US-5 threads sidebar: active threads (running first) + collapsible
 * archived section. Arrow up/down moves selection inside the active list;
 * ctrl-tab / ctrl-shift-tab is handled globally in App so it works from
 * the composer too.
 */
export function SessionSidebar({
  sessions,
  activeId,
  pendingCounts,
  onSelect,
  onNew,
  onCancel,
  onKill,
  onArchive,
  onRestore,
  canStart,
}: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = useMemo(() => selectActiveThreads(sessions), [sessions]);
  const archived = useMemo(() => selectArchivedThreads(sessions), [sessions]);
  const runningCount = useMemo(() => countRunning(sessions), [sessions]);
  const activeIds = useMemo(() => active.map((s) => s.session_id), [active]);

  function moveSelection(dir: CycleDir): void {
    const next = cycleThreadId(activeIds, activeId, dir);
    if (next !== null) onSelect(next);
  }

  function onListKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    }
  }

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span>
          Threads ({active.length}
          <span aria-live="polite" title={`${runningCount} running`}>
            {runningCount > 0 ? `, ${runningCount} live` : ""}
          </span>
          )
        </span>
        <button onClick={onNew} disabled={!canStart} title="New session">
          + New
        </button>
      </div>
      <p className="muted threads-hint" title="Keyboard thread switch">
        ↑↓ or Ctrl+Tab / Ctrl+Shift+Tab to switch
      </p>
      {active.length === 0 && (
        <p className="muted">No active threads. Start one to begin.</p>
      )}
      <ul
        className="session-items"
        role="listbox"
        aria-label="Active threads"
        onKeyDown={onListKeyDown}
      >
        {active.map((s) => {
          const pending = pendingCounts[s.session_id] ?? 0;
          const isActive = s.session_id === activeId;
          return (
            <li
              key={s.session_id}
              role="option"
              aria-selected={isActive}
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
                {s.running && (
                  <span className="threads-live" title="Agent running">
                    live
                  </span>
                )}
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
                    onClick={() => onArchive(s.session_id)}
                    title="Archive thread (kept in local history)"
                  >
                    Archive
                  </button>
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
      {archived.length > 0 && (
        <div className="archived-section">
          <button
            className="archived-toggle"
            onClick={() => setArchivedOpen((v) => !v)}
            aria-expanded={archivedOpen}
            title={archivedOpen ? "Collapse archived threads" : "Expand archived threads"}
          >
            {archivedOpen ? "▾" : "▸"} Archived ({archived.length})
          </button>
          {archivedOpen && (
            <ul className="session-items" aria-label="Archived threads">
              {archived.map((s) => (
                <li key={s.session_id} className="session-item archived">
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
                    <span className="session-title">
                      {s.title || shortId(s.session_id)}
                    </span>
                  </button>
                  <div className="session-meta">
                    <span className="muted">{timeOf(s.createdAt)}</span>
                    <span className="session-actions">
                      <button
                        onClick={() => onRestore(s.session_id)}
                        title="Restore thread to the active list"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => onKill(s.session_id)}
                        title="Kill session and delete its local history"
                      >
                        Del
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
