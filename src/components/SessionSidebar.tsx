import { Icon } from "./Icon";
import { primaryModifier } from "../lib/a11y";
import { useMemo, useRef, useState } from "react";
import type { MuseSession } from "../hooks/useMuseSessions";
import {
  countRunning,
  selectActiveThreads,
  selectArchivedThreads,
} from "../lib/threads";
import type { Project, ThreadProjectMap } from "../lib/projects";

interface Props {
  showArchived?: boolean;
  sessions: MuseSession[];
  activeId: string | null;
  pendingCounts: Record<string, number>;
  /** M0-03: retryable sends across all conversations. */
  pendingSendCount?: number;
  onOpenPendingSends?: () => void;
  /** US-4: ids of threads holding a stored summary (compacted). */
  compactedIds?: string[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  canStart: boolean;
  /** US-3: project grouping (absent/empty = flat list, as before). */
  projects?: Project[];
  threadProjects?: ThreadProjectMap;
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
  showArchived = false,
  activeId,
  pendingCounts,
  pendingSendCount = 0,
  onOpenPendingSends,
  onSelect,
  onNew,
  onCancel,
  onKill,
  onRename,
  onTogglePin,
  onMove,
  onArchive,
  onRestore,
  canStart,
  projects,
  threadProjects,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<MuseSession | null>(null);
  const [rename, setRename] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  function closeActions() {
    dialog.current?.close();
    setSelected(null);
    setConfirmDelete(false);
    actionTrigger.current?.focus();
    actionTrigger.current = null;
  }
  const active = useMemo(() => selectActiveThreads(sessions), [sessions]);
  const archived = useMemo(() => selectArchivedThreads(sessions), [sessions]);
  const runningCount = useMemo(() => countRunning(sessions), [sessions]);
  // US-3: group active threads under their project heading; threads with
  // no (or a dangling) attachment stay under Ungrouped. Null = flat list.
  const groups = useMemo(() => {
    if (
      projects === undefined ||
      threadProjects === undefined ||
      projects.length === 0
    ) {
      return null;
    }
    const per = projects
      .map((p) => ({
        project: p,
        items: active.filter((s) => threadProjects[s.session_id] === p.id),
      }))
      .filter((g) => g.items.length > 0);
    const groupedIds = new Set(
      per.flatMap((g) => g.items.map((s) => s.session_id)),
    );
    return {
      per,
      ungrouped: active.filter((s) => !groupedIds.has(s.session_id)),
    };
  }, [projects, threadProjects, active]);
  function onListKeyDown(e: React.KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(".session-select"),
    ).filter((row) => !row.closest("details:not([open])"));
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    rows[
      (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
    ]?.focus();
  }

  // One active-thread row (shared by the flat list and project groups).
  function renderThread(s: MuseSession) {
    const pending = pendingCounts[s.session_id] ?? 0;
    const isActive = s.session_id === activeId;
    return (
      <li
        key={s.session_id}
        className={isActive ? "session-item active" : "session-item"}
      >
        <button
          className="session-select"
          aria-current={isActive ? "page" : undefined}
          onClick={() => onSelect(s.session_id)}
          title={s.title || "New conversation"}
        >
          <span
            className="dot"
            data-running={s.running}
            title={s.running ? "Working" : "Idle"}
          />
          <span className="session-title">
            {s.title?.replace(/^Session [\w-]+$/, "New conversation") ||
              "New conversation"}
          </span>
          {s.pinned === true && (
            <span className="session-pin" title="Pinned conversation">
              <Icon name="pin" />
            </span>
          )}
          {s.unread === true && (
            <span className="session-unread" title="Unread response">
              new
            </span>
          )}
          {pending > 0 && (
            <span className="badge" title={`${pending} response(s) needed`}>
              {pending}
            </span>
          )}
        </button>
        <button
          className="conversation-more icon"
          aria-label={`Actions for ${s.title || "New conversation"}`}
          aria-haspopup="dialog"
          onClick={(event) => {
            actionTrigger.current = event.currentTarget;
            setSelected(s);
            setRename(s.title);
            setConfirmDelete(false);
            dialog.current?.showModal();
          }}
        >
          <Icon name="more" />
        </button>
      </li>
    );
  }

  return (
    <div className="session-list" role="navigation" aria-label="Conversations">
      <div
        className="section-label threads-label"
        title={`↑↓ to navigate · ${primaryModifier()}+Tab to switch conversations`}
      >
        <span>
          Conversations ({active.length}
          <span aria-live="polite" title={`${runningCount} working`}>
            {runningCount > 0 ? `, ${runningCount} working` : ""}
          </span>
          )
        </span>
        <button
          type="button"
          className="icon"
          onClick={onNew}
          disabled={!canStart}
          title="New conversation"
          aria-label="New conversation"
        >
          +
        </button>
      </div>
      {pendingSendCount > 0 && (
        <div className="sidebar-outbox" role="status" aria-live="polite">
          <span>
            {pendingSendCount} unsent message{pendingSendCount === 1 ? "" : "s"} need review.
          </span>
          {onOpenPendingSends && (
            <button type="button" onClick={onOpenPendingSends}>
              Review
            </button>
          )}
        </div>
      )}
      {active.length === 0 && (
        <p className="muted">Your conversations will appear here.</p>
      )}
      {groups === null ? (
        <ul
          className="session-items"
          aria-label="Recent conversations"
          onKeyDown={onListKeyDown}
        >
          {active.map(renderThread)}
        </ul>
      ) : (
        <div onKeyDown={onListKeyDown}>
          {groups.per.map((g) => (
            <details key={g.project.id} className="project-group" open>
              <summary className="project-group-header">
                {g.project.name} ({g.items.length})
              </summary>
              <ul
                className="session-items"
                aria-label={`Conversations in ${g.project.name}`}
              >
                {g.items.map(renderThread)}
              </ul>
            </details>
          ))}
          {groups.ungrouped.length > 0 && (
            <div className="project-group">
              <div className="project-group-header muted">
                Ungrouped ({groups.ungrouped.length})
              </div>
              <ul
                className="session-items"
                aria-label="Ungrouped conversations"
              >
                {groups.ungrouped.map(renderThread)}
              </ul>
            </div>
          )}
        </div>
      )}
      {showArchived && archived.length > 0 && (
        <div className="archived-section">
          <div className="section-label">Archived ({archived.length})</div>
          <ul className="session-items" aria-label="Archived threads">
            {archived.map((s) => (
              <li key={s.session_id} className="session-item archived">
                <button
                  className="session-select"
                  onClick={() => onSelect(s.session_id)}
                  title={s.title || "New conversation"}
                >
                  <span
                    className="dot"
                    data-running={s.running}
                    title={s.running ? "Working" : "Idle"}
                  />
                  <span className="session-title">
                    {s.title?.replace(
                      /^Session [\w-]+$/,
                      "New conversation",
                    ) || "New conversation"}
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
        </div>
      )}
      <dialog
        ref={dialog}
        className="conversation-actions-dialog"
        aria-label="Conversation actions"
        onCancel={closeActions}
      >
        <header>
          <h2>
            {confirmDelete ? "Delete this conversation?" : selected?.title}
          </h2>
          <button className="icon" aria-label="Close" onClick={closeActions}>
            <Icon name="close" />
          </button>
        </header>
        {confirmDelete ? (
          <>
            <p>
              Its local history will be deleted. This cannot be undone.
            </p>
            <div className="dialog-buttons">
              <button autoFocus onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (selected) onKill(selected.session_id);
                  closeActions();
                }}
              >
                Delete conversation
              </button>
            </div>
          </>
        ) : (
          <div className="conversation-action-list">
            <form
              className="conversation-rename"
              onSubmit={(event) => {
                event.preventDefault();
                if (selected && rename.trim()) {
                  onRename(selected.session_id, rename);
                  closeActions();
                }
              }}
            >
              <label htmlFor="conversation-name">Conversation name</label>
              <div>
                <input
                  id="conversation-name"
                  maxLength={120}
                  autoFocus
                  value={rename}
                  onChange={(event) => setRename(event.target.value)}
                />
                <button type="submit" disabled={!rename.trim()}>
                  Rename
                </button>
              </div>
            </form>
            {selected?.running && (
              <button
                onClick={() => {
                  onCancel(selected.session_id);
                  closeActions();
                }}
              >
                Stop response
              </button>
            )}
            {selected && (
              <button
                onClick={() => {
                  onTogglePin(selected.session_id);
                  closeActions();
                }}
              >
                {selected.pinned === true ? "Unpin conversation" : "Pin conversation"}
              </button>
            )}
            {selected && !selected.archived && (
              <div className="conversation-order-actions" aria-label="Conversation order">
                <button
                  onClick={() => {
                    onMove(selected.session_id, -1);
                    closeActions();
                  }}
                >
                  Move up
                </button>
                <button
                  onClick={() => {
                    onMove(selected.session_id, 1);
                    closeActions();
                  }}
                >
                  Move down
                </button>
              </div>
            )}
            <button
              onClick={() => {
                if (selected) onArchive(selected.session_id);
                closeActions();
              }}
            >
              <Icon name="archive" />
              Archive conversation
            </button>
            <button className="danger" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          </div>
        )}
      </dialog>
    </div>
  );
}
