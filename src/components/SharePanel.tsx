import type { ShareBundle, ShareMode } from "../lib/sharing";

interface Props {
  sessionId: string;
  mode: ShareMode;
  bundles: ShareBundle[];
  onModeChange: (mode: ShareMode) => void;
  onShare: (format: "markdown" | "json") => void;
  onUnshare: (bundleId: string) => void;
  onCopy: (bundle: ShareBundle) => void;
  onDownload: (bundle: ShareBundle) => void;
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
}: Props) {
  return (
    <section className="collab-panel" aria-label="Thread sharing">
      <header className="collab-head">
        <strong>Partage</strong>
        <label className="collab-mode">
          Mode{" "}
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ShareMode)}
            aria-label="Share mode"
          >
            <option value="manual">manual</option>
            <option value="auto">auto</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </header>
      {mode === "disabled" ? (
        <p className="muted">Partage désactivé — le partage est refusé dans ce mode.</p>
      ) : (
        <div className="collab-actions">
          <button type="button" onClick={() => onShare("markdown")} title="Exporter ce thread en markdown">
            Partager (markdown)
          </button>
          <button type="button" onClick={() => onShare("json")} title="Exporter ce thread en JSON">
            Partager (JSON)
          </button>
        </div>
      )}
      {bundles.length === 0 ? (
        <p className="muted">Aucun lien pour ce thread.</p>
      ) : (
        <ul className="collab-list">
          {bundles.map((b) => (
            <li key={b.bundleId} className="collab-row">
              <code title={b.bundleId}>{b.bundleId}</code>
              <span className="muted">{b.format}</span>
              <button type="button" onClick={() => onCopy(b)} title="Copier l'id du bundle local">
                Copier le lien
              </button>
              <button type="button" onClick={() => onDownload(b)} title="Télécharger le bundle">
                Télécharger
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => onUnshare(b.bundleId)}
                title="Révoquer : ce lien ne résoudra plus (404 local)"
              >
                Un-share
              </button>
              <span className="muted" hidden={sessionId === b.sessionId}>
                autre thread
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
