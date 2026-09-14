import { useRef } from "react";
import { SUPPORTED_EXTENSIONS, type LineHit } from "../lib/indexer";

interface Props {
  enabled: boolean;
  paused: boolean;
  fileCount: number;
  lineCount: number;
  builtAt: number | null;
  lastSummary: string | null;
  /** True once a folder was picked, so Rescan/Rebuild have a source. */
  hasSource: boolean;
  query: string;
  results: LineHit[];
  onToggle: (enabled: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onFilesPicked: (files: FileList | File[]) => void;
  onRescan: () => void;
  onRebuild: () => void;
  onDelete: () => void;
  onQueryChange: (q: string) => void;
}

function formatBuiltAt(builtAt: number | null): string {
  if (builtAt === null) return "not built yet";
  try {
    return new Date(builtAt).toLocaleString();
  } catch {
    return "unknown";
  }
}

/**
 * US-23 opt-in local index panel. Presentational: all state lives in
 * useMuseSessions (`index*`); folder picking uses a directory input (no
 * native watcher — refresh is the on-demand mtime Rescan button).
 */
export function IndexPanel({
  enabled,
  paused,
  fileCount,
  lineCount,
  builtAt,
  lastSummary,
  hasSource,
  query,
  results,
  onToggle,
  onPause,
  onResume,
  onFilesPicked,
  onRescan,
  onRebuild,
  onDelete,
  onQueryChange,
}: Props) {
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="index-panel" aria-label="Local file index">
      <div className="session-list-header">
        <span>Index</span>
        <label className="index-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {enabled ? "On" : "Off"}
        </label>
      </div>
      <p className="muted index-note">
        Opt-in local search over the workspace. Formats:{" "}
        {SUPPORTED_EXTENSIONS.join(", ")}. Skips build dirs + .gitignore.
      </p>
      {enabled && (
        <>
          <div className="muted index-status">
            {fileCount === 0
              ? "Empty — pick a folder to build."
              : `${fileCount} file(s), ${lineCount} line(s) · built ${formatBuiltAt(builtAt)}${paused ? " · paused" : ""}`}
          </div>
          {lastSummary !== null && (
            <div className="muted index-status" title="Last build or rescan">
              {lastSummary}
            </div>
          )}
          <div className="index-actions">
            <input
              ref={(el) => {
                dirInputRef.current = el;
                // Non-standard folder-pick attribute (no React typing):
                // no native watcher involved, files are read on demand.
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files !== null) onFilesPicked(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              title="Pick the workspace folder (contents are read on demand, never watched)"
              onClick={() => dirInputRef.current?.click()}
            >
              Choose folder
            </button>
            <button
              type="button"
              title="Re-read the picked folder; unchanged files (same mtime) are reused"
              disabled={!hasSource || paused}
              onClick={onRescan}
            >
              Rescan
            </button>
            <button
              type="button"
              title="Re-parse every picked file from scratch"
              disabled={!hasSource}
              onClick={onRebuild}
            >
              Rebuild
            </button>
            {paused ? (
              <button type="button" onClick={onResume}>
                Reprendre
              </button>
            ) : (
              <button
                type="button"
                title="Suspend indexing updates (search keeps working)"
                onClick={onPause}
              >
                Pause
              </button>
            )}
            <button
              type="button"
              className="index-delete"
              title="Delete the stored index"
              disabled={fileCount === 0 && builtAt === null}
              onClick={onDelete}
            >
              Delete Index
            </button>
          </div>
          <input
            className="index-search"
            type="search"
            placeholder="Search indexed files…"
            aria-label="Search indexed files"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {query.trim().length > 0 && (
            <ul className="index-results">
              {results.length === 0 ? (
                <li className="muted">No hits.</li>
              ) : (
                results.map((h, i) => (
                  <li
                    key={`${h.path}:${h.line}:${i}`}
                    className="index-hit"
                    title={h.path}
                  >
                    <code className="index-hit-path">
                      {h.path}:{h.line}
                    </code>
                    <span className="index-hit-text">{h.text}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
