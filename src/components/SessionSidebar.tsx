import { useMemo, useState } from "react";
import type { MuseSession } from "../hooks/useMuseSessions";
import {
  countRunning,
  cycleThreadId,
  selectActiveThreads,
  selectArchivedThreads,
  type CycleDir,
} from "../lib/threads";
import type { Project, ThreadProjectMap } from "../lib/projects";

interface Props {
  sessions: MuseSession[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  /** US-4: ids of threads holding a stored summary (compacted). */
  compactedIds?: string[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: (id: string) => void;
  onKill: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  canStart: boolean;
  /** US-3: project grouping (absent/empty = flat list, as before). */
  projects?: Project[];
  threadProjects?: ThreadProjectMap;
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
  compactedIds,
  onSelect,
  onNew,
  onCancel,
  onKill,
  onArchive,
  onRestore,
  canStart,
  projects,
  threadProjects,
}: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = useMemo(() => selectActiveThreads(sessions), [sessions]);
  const archived = useMemo(() => selectArchivedThreads(sessions), [sessions]);
  const runningCount = useMemo(() => countRunning(sessions), [sessions]);
  const activeIds = useMemo(() => active.map((s) => s.session_id), [active]);
  // US-3: group active threads under their project heading; threads with
  // no (or a dangling) attachment stay under Ungrouped. Null = flat list.
  const groups = useMemo(() => {
    if (projects === undefined || threadProjects === undefined || projects.length === 0) {
      return null;
    }
    const per = projects
      .map((p) => ({
        project: p,
        items: active.filter((s) => threadProjects[s.session_id] === p.id),
      }))
      .filter((g) => g.items.length > 0);
    const groupedIds = new Set(per.flatMap((g) => g.items.map((s) => s.session_id)));
    return { per, ungrouped: active.filter((s) => !groupedIds.has(s.session_id)) };
  }, [projects, threadProjects, active]);
  const projectNameOf = (sessionId: string): string | null => {
    if (projects === undefined || threadProjects === undefined) return null;
    const pid = threadProjects[sessionId] ?? null;
    if (pid === null) return null;
    return projects.find((p) => p.id === pid)?.name ?? null;
  };

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

  // One active-thread row (shared by the flat list and project groups).
  function renderThread(s: MuseSession) {
    const pending = pendingCounts[s.session_id] ?? 0;
    const isActive = s.session_id === activeId;
    const projectName = projectNameOf(s.session_id);
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
          {projectName !== null && (
            <span className="project-badge" title={`Project: ${projectName}`}>
              {projectName}
            </span>
          )}
          {s.running && (
            <span className="threads-live" title="Agent running">
              live
            </span>
          )}
          {compactedIds?.includes(s.session_id) && (
            <span className="compact-flag" title="Thread compacté — résumé disponible">
              compacté
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
  }

  return (
    <div className="session-list" role="navigation" aria-label="Threads">
      <div
        className="session-list-header"
        title="↑↓ or Ctrl+Tab / Ctrl+Shift+Tab to switch threads"
      >
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
      {active.length === 0 && (
        <p className="muted">No active threads. Start one to begin.</p>
      )}
      {groups === null ? (
        <ul
          className="session-items"
          role="listbox"
          aria-label="Active threads"
          onKeyDown={onListKeyDown}
        >
          {active.map(renderThread)}
        </ul>
      ) : (
        <div onKeyDown={onListKeyDown}>
          {groups.per.map((g) => (
            <div key={g.project.id} className="project-group">
              <div className="project-group-header">
                {g.project.name} ({g.items.length})
              </div>
              <ul
                className="session-items"
                role="listbox"
                aria-label={`Threads in ${g.project.name}`}
              >
                {g.items.map(renderThread)}
              </ul>
            </div>
          ))}
          {groups.ungrouped.length > 0 && (
            <div className="project-group">
              <div className="project-group-header muted">
                Ungrouped ({groups.ungrouped.length})
              </div>
              <ul
                className="session-items"
                role="listbox"
                aria-label="Ungrouped threads"
              >
                {groups.ungrouped.map(renderThread)}
              </ul>
            </div>
          )}
        </div>
      )}
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
