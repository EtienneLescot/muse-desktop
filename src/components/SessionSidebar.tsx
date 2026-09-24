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
  /** Drag and drop: `movedId` takes `targetId`'s slot in the manual order. */
  onReorder: (movedId: string, targetId: string) => void;
  /** Alt+arrow on a focused row: the keyboard path to the same reordering. */
  onMove: (id: string, direction: -1 | 1) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  /** Branch this conversation: a new thread from its latest completed turn. */
  onFork?: (id: string) => void;
  /** Branch the folder too: a new thread in a git worktree of the workspace. */
  onMoveToWorktree?: (id: string) => void;
  /** The step a worktree start is on, or null. Disables the action while set. */
  movingToWorktree?: string | null;
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
  onReorder,
  onMove,
  onArchive,
  onRestore,
  onFork,
  onMoveToWorktree,
  movingToWorktree = null,
  canStart,
  projects,
  threadProjects,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<MuseSession | null>(null);
  const [rename, setRename] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /**
   * Session awaiting a delete confirmation launched from an archived row.
   *
   * The actions menu confirms through `confirmDelete`, but an archived row has
   * no menu: its Delete button has to be able to reach the same dialog. Keeping
   * the id here means one dialog serves both entry points.
   */
  const [pendingKill, setPendingKill] = useState<string | null>(null);
  const deleting = confirmDelete || pendingKill !== null;
  function closeActions() {
    dialog.current?.close();
    setSelected(null);
    setConfirmDelete(false);
    setPendingKill(null);
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
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  function onListKeyDown(e: React.KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(".session-select"),
    ).filter((row) => !row.closest("details:not([open])"));
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    // Reordering is a drag, which a keyboard cannot perform: Alt+arrow is the
    // same move without a pointer, and keeps focus on the row it moved.
    if (e.altKey) {
      const id = rows[i].closest("li")?.dataset.sessionId;
      if (id !== undefined) {
        onMove(id, e.key === "ArrowDown" ? 1 : -1);
        requestAnimationFrame(() => rows[i].focus());
      }
      return;
    }
    rows[
      (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
    ]?.focus();
  }

  // One active-thread row (shared by the flat list and project groups).
  // Reordering is a drag, the gesture the list already suggests; the row is the
  // drop target, and the dragged thread takes its slot.
  function renderThread(s: MuseSession) {
    const pending = pendingCounts[s.session_id] ?? 0;
    const isActive = s.session_id === activeId;
    return (
      <li
        key={s.session_id}
        className={isActive ? "session-item active" : "session-item"}
        data-session-id={s.session_id}
        draggable
        data-drop={dropTarget === s.session_id ? "true" : undefined}
        onDragStart={(event) => {
          dragged.current = s.session_id;
          event.dataTransfer.effectAllowed = "move";
          // Some targets refuse a drag with an empty payload.
          event.dataTransfer.setData("text/plain", s.session_id);
        }}
        onDragEnd={() => {
          dragged.current = null;
          setDropTarget(null);
        }}
        onDragOver={(event) => {
          if (dragged.current === null || dragged.current === s.session_id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(s.session_id);
        }}
        onDragLeave={() => setDropTarget((cur) => (cur === s.session_id ? null : cur))}
        onDrop={(event) => {
          event.preventDefault();
          const moved = dragged.current ?? event.dataTransfer.getData("text/plain");
          dragged.current = null;
          setDropTarget(null);
          if (moved) onReorder(moved, s.session_id);
        }}
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
          Conversations
          <span aria-live="polite" title={`${runningCount} working`}>
            {runningCount > 0 ? ` · ${runningCount} working` : ""}
          </span>
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
                {g.project.name}
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
                Ungrouped
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
                    {/* Same confirmation as the actions menu. This used to delete
                        a conversation outright on a single click, with no undo
                        and no warning, which is the worse half of the same
                        defect: the action was invisible until hover, and then it
                        was irreversible without asking. */}
                    <button
                      data-danger="true"
                      onClick={() => {
                        setPendingKill(s.session_id);
                        dialog.current?.showModal();
                      }}
                      title="Delete this conversation permanently"
                    >
                      Delete…
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
            {deleting ? "Delete this conversation?" : selected?.title}
          </h2>
          <button className="icon" aria-label="Close" onClick={closeActions}>
            <Icon name="close" />
          </button>
        </header>
        {deleting ? (
          <>
            <p>
              It will disappear from Muse and will not come back. The
              conversation files themselves stay on disk, under the Muse data
              folder, until they are removed there.
            </p>
            <div className="dialog-buttons">
              <button
                autoFocus
                onClick={() => {
                  setConfirmDelete(false);
                  setPendingKill(null);
                  // The archived row and "Delete all…" open this dialog with no
                  // selected session, so there is no action list to fall back to.
                  // Without this the dialog stays open with a rename field bound
                  // to nothing.
                  if (selected === null) closeActions();
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  const target = pendingKill ?? selected?.session_id ?? null;
                  if (target !== null) onKill(target);
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
              <label htmlFor="conversation-name">Name</label>
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
                <Icon name="stop" />
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
                <Icon name="pin" />
                {selected.pinned === true ? "Unpin conversation" : "Pin conversation"}
              </button>
            )}
            {/* Branching belongs with the conversation's own actions, not in a
                floating icon in the top bar: both answer "start again from
                here", one keeping the folder, one copying it. */}
            {selected && !selected.archived && onFork && (
              <button
                onClick={() => {
                  onFork(selected.session_id);
                  closeActions();
                }}
              >
                <Icon name="branch" />
                Fork conversation
              </button>
            )}
            {selected && !selected.archived && onMoveToWorktree && (
              <button
                disabled={movingToWorktree !== null || selected.running}
                onClick={() => {
                  onMoveToWorktree(selected.session_id);
                  closeActions();
                }}
              >
                <Icon name="branch" />
                {movingToWorktree ?? "Continue in a worktree"}
              </button>
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
              <Icon name="trash" />
              Delete…
            </button>
          </div>
        )}
      </dialog>
    </div>
  );
}
