import { useEffect } from "react";
import { userFacingError } from "../lib/errorCopy";
import { structuredPreviewForFile } from "../lib/filePreview";
import { officePreviewForFile, type OfficePreview } from "../lib/officePreview";
import type {
  FilesBrowserState,
  WorkspaceFileEntry,
} from "../hooks/useMuseSessions";

interface Props {
  sessionId: string;
  state: FilesBrowserState;
  onList: (sessionId: string, path?: string) => Promise<void>;
  onRead: (sessionId: string, path: string) => Promise<void>;
  onWatch: (sessionId: string) => Promise<void>;
  onUnwatch: (sessionId: string) => Promise<void>;
  onOpen: (sessionId: string, path: string) => Promise<void>;
  /** Insert the currently selected text preview into the composer draft. */
  onInsertContext: (sessionId: string) => boolean;
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

function mediaLabel(mediaType: string): string {
  if (mediaType === "application/pdf") return "PDF preview";
  if (mediaType === "image/svg+xml") return "SVG preview";
  if (mediaType.includes("wordprocessingml.document")) return "DOCX preview";
  if (mediaType.includes("spreadsheetml.sheet")) return "XLSX preview";
  if (mediaType.includes("presentationml.presentation")) return "PPTX preview";
  if (mediaType.includes("opendocument.text")) return "ODT preview";
  if (mediaType.includes("opendocument.spreadsheet")) return "ODS preview";
  if (mediaType.includes("opendocument.presentation")) return "ODP preview";
  if (mediaType.includes("rtf")) return "RTF preview";
  return "Image preview";
}

type TablePreview = Pick<OfficePreview, "columns" | "rows" | "truncated"> & { format: string };

function StructuredTable({ path, preview }: { path: string; preview: TablePreview }) {
  return (
    <div className="file-structured-preview" role="region" aria-label={`${preview.format.toUpperCase()} table preview`}>
      <div className="file-structured-meta">
        <span>{preview.format.toUpperCase()} · {preview.rows.length} rows</span>
        {preview.truncated && <span>Preview limited for safety</span>}
      </div>
      <div className="file-structured-scroll">
        <table>
          <caption className="sr-only">Structured preview of {path}</caption>
          <thead>
            <tr>
              {preview.columns.map((column, columnIndex) => <th scope="col" key={`${column}-${columnIndex}`}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {preview.columns.map((_, columnIndex) => (
                  <td key={`cell-${rowIndex}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** M1-07 real disk browser. Every row comes from the Rust Files service. */
export function FilesPanel({ sessionId, state, onList, onRead, onWatch, onUnwatch, onOpen, onInsertContext }: Props) {
  useEffect(() => {
    void onWatch(sessionId);
    return () => {
      void onUnwatch(sessionId);
    };
  }, [onUnwatch, onWatch, sessionId]);

  useEffect(() => {
    if (state.entries.length === 0 && !state.loading && state.observedAt === null) {
      void onList(sessionId, ".");
    }
  }, [onList, sessionId, state.entries.length, state.loading, state.observedAt]);

  useEffect(() => {
    if (state.observedAt === null || state.loading) return undefined;
    let disposed = false;
    let refresh: number | null = null;
    const schedule = () => {
      if (disposed) return;
      refresh = window.setTimeout(() => {
        if (disposed) return;
        void onList(sessionId, state.path || ".").catch(() => undefined).finally(schedule);
      }, 30_000);
    };
    schedule();
    return () => {
      disposed = true;
      if (refresh !== null) window.clearTimeout(refresh);
    };
  }, [onList, sessionId, state.loading, state.observedAt, state.path]);

  const currentPath = state.path || ".";
  const preview = state.preview;
  const structuredPreview = preview && !preview.mediaType && !preview.binary && preview.content !== null
    ? structuredPreviewForFile(preview.path, preview.content)
    : null;
  const officePreview = preview?.mediaType && preview.base64Data
    ? officePreviewForFile(preview.path, preview.base64Data)
    : null;
  const isOfficeContainer = preview?.mediaType
    ? preview.mediaType.startsWith("application/vnd.openxmlformats")
      || preview.mediaType.startsWith("application/vnd.oasis.opendocument")
      || preview.mediaType.includes("rtf")
    : false;

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
      {state.stale && (
        <p className="files-stale" role="status">
          Workspace changed on disk. Refresh to update this view
          {state.changedPaths.length > 0 ? ` · ${state.changedPaths.slice(0, 3).join(", ")}` : ""}.
        </p>
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
          ) : preview.mediaType && preview.base64Data ? (
            <>
              <div className="file-preview-head">
                <strong>{preview.path}</strong>
                <span className="file-preview-actions">
                  <span>{mediaLabel(preview.mediaType)} · {formatSize(preview.size)}</span>
                  <button
                    type="button"
                    onClick={() => void onOpen(sessionId, preview.path)}
                    title="Open this file with the system default application"
                  >
                    Open in app
                  </button>
                </span>
              </div>
              {isOfficeContainer ? (
                officePreview ? (
                  <StructuredTable path={preview.path} preview={officePreview} />
                ) : (
                  <p className="muted">This Office file could not be safely previewed. Use Open in app to view it.</p>
                )
              ) : preview.mediaType === "application/pdf" ? (
                <div className="file-document-preview">
                  <object
                    data={`data:${preview.mediaType};base64,${preview.base64Data}`}
                    type={preview.mediaType}
                    aria-label={`Preview of ${preview.path}`}
                  >
                    <p className="muted">This WebView cannot render the PDF. Use Open in app to view it.</p>
                  </object>
                  <span className="muted">PDF preview · {formatSize(preview.size)}</span>
                </div>
              ) : preview.mediaType.startsWith("image/") ? (
                <div className="file-image-preview">
                  <img
                    src={`data:${preview.mediaType};base64,${preview.base64Data}`}
                    alt={`Preview of ${preview.path}`}
                  />
                  <span className="muted">{mediaLabel(preview.mediaType)} · {preview.mediaType}</span>
                </div>
              ) : (
                <p className="muted">This file format has no inline preview. Use Open in app to view it.</p>
              )}
            </>
          ) : preview.binary ? (
            <>
              <div className="file-preview-head">
                <strong>{preview.path}</strong>
                <span className="file-preview-actions">
                  <span>Binary file · {formatSize(preview.size)}</span>
                  <button
                    type="button"
                    onClick={() => void onOpen(sessionId, preview.path)}
                    title="Open this file with the system default application"
                  >
                    Open in app
                  </button>
                </span>
              </div>
              <p className="muted">Binary content is not rendered in the text preview.</p>
            </>
          ) : (
            <>
              <div className="file-preview-head">
                <strong title={preview.path}>{preview.path}</strong>
                <span className="file-preview-actions">
                  <span>{formatSize(preview.size)}{preview.truncated ? " · preview clipped" : ""}</span>
                  <button
                    type="button"
                    onClick={() => void onOpen(sessionId, preview.path)}
                    title="Open this file with the system default application"
                  >
                    Open in app
                  </button>
                  <button
                    type="button"
                    onClick={() => void onInsertContext(sessionId)}
                    title="Add this text preview to the composer"
                  >
                    Add to prompt
                  </button>
                </span>
              </div>
              {structuredPreview ? (
                <StructuredTable path={preview.path} preview={structuredPreview} />
              ) : (
                <pre className="file-preview-code">{preview.content}</pre>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  );
}
