import { useEffect } from "react";
import { userFacingError } from "../lib/errorCopy";
import type {
  FilesBrowserState,
  WorkspaceFileEntry,
} from "../hooks/useMuseSessions";

interface Props {
  sessionId: string;
  state: FilesBrowserState;
  onList: (sessionId: string, path?: string) => Promise<void>;
  onRead: (sessionId: string, path: string) => Promise<void>;
}

function formatSize(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function entryLabel(entry: WorkspaceFileEntry): string {
  if (entry.kind === "directory") return `${entry.name}/`;
  if (entry.kind === "symlink") return `${entry.name} ↗`;
  return entry.name;
}

function formatObservedAt(observedAt: number | null): string {
  if (observedAt === null) return "Not loaded";
  return `Updated ${new Date(observedAt).toLocaleTimeString()}`;
}

/** M1-07 real disk browser. Every row comes from the Rust Files service. */
export function FilesPanel({ sessionId, state, onList, onRead }: Props) {
  useEffect(() => {
    if (state.entries.length === 0 && !state.loading && state.observedAt === null) {
      void onList(sessionId, ".");
    }
  }, [onList, sessionId, state.entries.length, state.loading, state.observedAt]);

  useEffect(() => {
    if (state.observedAt === null || state.loading) return undefined;
    const refresh = window.setInterval(() => {
      void onList(sessionId, state.path || ".");
    }, 30_000);
    return () => window.clearInterval(refresh);
  }, [onList, sessionId, state.loading, state.observedAt, state.path]);

  const currentPath = state.path || ".";
  const preview = state.preview;

  return (
    <section className="files-panel" aria-label="Workspace files">
      <header className="files-toolbar">
        <div>
          <strong>Files</strong>
          <span className="files-meta" title={currentPath}>
            Disk · {currentPath}
          </span>
          <span className="files-meta-status" role="status" aria-live="polite">
            {formatObservedAt(state.observedAt)}
          </span>
        </div>
        <div className="files-actions">
          <button
            type="button"
            onClick={() => void onList(sessionId, parentPath(currentPath))}
            disabled={currentPath === "." || state.loading}
          >
            Up
          </button>
          <button type="button" onClick={() => void onList(sessionId, currentPath)} disabled={state.loading}>
            Refresh
          </button>
        </div>
      </header>
      {state.error && <p className="files-error" role="alert">{userFacingError(state.error)}</p>}
      {state.truncated && (
        <p className="files-note">Showing the first 200 entries. Open a subfolder to narrow the view.</p>
      )}
      <div className="files-layout">
        <div className="files-list" role="list" aria-label={`Files in ${currentPath}`}>
          {state.entries.length === 0 && !state.loading ? (
            <p className="muted">This folder is empty.</p>
          ) : (
            state.entries.map((entry) => {
              const disabled = !entry.accessible;
              const selected = state.selectedPath === entry.path;
              return (
                <button
                  type="button"
                  role="listitem"
                  key={entry.path}
                  className={`file-row${selected ? " file-row-selected" : ""}`}
                  disabled={disabled}
                  title={disabled ? "Symlink target is outside this workspace" : entry.path}
                  onClick={() => {
                    if (entry.kind === "directory") void onList(sessionId, entry.path);
                    else if (entry.kind === "file") void onRead(sessionId, entry.path);
                  }}
                >
                  <span className={`file-kind file-kind-${entry.kind}`} aria-hidden="true">
                    {entry.kind === "directory" ? "▰" : entry.kind === "symlink" ? "↗" : "•"}
                  </span>
                  <span className="file-name">{entryLabel(entry)}</span>
                  <span className="file-size">{formatSize(entry.size)}</span>
                </button>
              );
            })
          )}
          {state.loading && <p className="muted files-loading">Reading workspace…</p>}
        </div>
        <article className="file-preview" aria-live="polite">
          {!preview ? (
            <p className="muted">Select a file to preview its current contents from disk.</p>
          ) : preview.binary ? (
            <>
              <div className="file-preview-head">
                <strong>{preview.path}</strong>
                <span>Binary file · {formatSize(preview.size)}</span>
              </div>
              <p className="muted">Binary content is not rendered in the text preview.</p>
            </>
          ) : (
            <>
              <div className="file-preview-head">
                <strong title={preview.path}>{preview.path}</strong>
                <span>{formatSize(preview.size)}{preview.truncated ? " · preview clipped" : ""}</span>
              </div>
              <pre className="file-preview-code">{preview.content}</pre>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
