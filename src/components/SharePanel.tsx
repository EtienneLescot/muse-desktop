import type { ShareBundle, ShareMode } from "../lib/sharing";
import { CapabilityBadge } from "./CapabilityBadge";

interface Props {
  sessionId: string;
  mode: ShareMode;
  bundles: ShareBundle[];
  onModeChange: (mode: ShareMode) => void;
  onShare: (format: "markdown" | "json") => void;
  onUnshare: (bundleId: string) => void;
  onCopy: (bundle: ShareBundle) => void;
  onDownload: (bundle: ShareBundle) => void | Promise<void>;
  exportError?: string | null;
}

/**
 * US-27 share panel: share-mode toggle (manual/auto/disabled), explicit
 * share buttons (markdown/JSON download + copy-link of the local bundle
 * id), bundle list with un-share (revokes locally → link 404s).
 */
export function SharePanel({
  sessionId,
  mode,
  bundles,
  onModeChange,
  onShare,
  onUnshare,
  onCopy,
  onDownload,
  exportError = null,
}: Props) {
  return (
    <section className="collab-panel" aria-label="Conversation exports">
      <header className="collab-head">
        <strong>Export conversation</strong>
        <label className="collab-mode">
          Mode{" "}
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ShareMode)}
            aria-label="Export mode"
          >
            <option value="manual">Manual</option>
            <option value="auto">Automatic</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </header>
      <p className="muted capability-line">
        <CapabilityBadge
          status="local"
          reason="Exports are generated and stored locally; no remote share link is created."
        />
        Local export only
      </p>
      {exportError && <p className="error" role="alert">{exportError}</p>}
      {mode === "disabled" ? (
        <p className="muted">
          Exports are disabled in this mode.
        </p>
      ) : (
        <div className="collab-actions">
          <button
            type="button"
            onClick={() => onShare("markdown")}
            title="Export this conversation as markdown"
          >
            Prepare Markdown export
          </button>
          <button
            type="button"
            onClick={() => onShare("json")}
            title="Export this conversation as JSON"
          >
            Prepare JSON export
          </button>
        </div>
      )}
      {bundles.length === 0 ? (
        <p className="muted">
          Exports are saved locally and can be downloaded.
        </p>
      ) : (
        <ul className="collab-list">
          {bundles.map((b) => (
            <li key={b.bundleId} className="collab-row">
              <code title={b.bundleId}>{b.bundleId}</code>
              <span className="muted">{b.format}</span>
              {(b.redacted || b.truncated) && (
                <span
                  className="muted share-safeguard"
                  title="The export was bounded or had credential-shaped values removed."
                >
                  {b.redacted ? "sanitized" : "bounded"}
                  {b.omittedEntries ? ` · ${b.omittedEntries} omitted` : ""}
                </span>
              )}
              <button
                type="button"
                onClick={() => onCopy(b)}
                title="Copy local export ID"
              >
                Copy ID
              </button>
              <button
                type="button"
                onClick={() => void onDownload(b)}
                title="Save this export"
              >
                Save export
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => onUnshare(b.bundleId)}
                title="Delete this local export"
              >
                Delete export
              </button>
              <span className="muted" hidden={sessionId === b.sessionId}>
                other conversation
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
