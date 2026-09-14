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
    <section className="collab-panel" aria-label="Exports de conversation">
      <header className="collab-head">
        <strong>Exporter la conversation</strong>
        <label className="collab-mode">
          Mode{" "}
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ShareMode)}
            aria-label="Mode d’export"
          >
            <option value="manual">Manuel</option>
            <option value="auto">Automatique</option>
            <option value="disabled">Désactivé</option>
          </select>
        </label>
      </header>
      {mode === "disabled" ? (
        <p className="muted">
          Partage désactivé — le partage est refusé dans ce mode.
        </p>
      ) : (
        <div className="collab-actions">
          <button
            type="button"
            onClick={() => onShare("markdown")}
            title="Exporter cette conversation en markdown"
          >
            Préparer un export Markdown
          </button>
          <button
            type="button"
            onClick={() => onShare("json")}
            title="Exporter cette conversation en JSON"
          >
            Préparer un export JSON
          </button>
        </div>
      )}
      {bundles.length === 0 ? (
        <p className="muted">
          Les exports sont enregistrés localement, puis téléchargeables.
        </p>
      ) : (
        <ul className="collab-list">
          {bundles.map((b) => (
            <li key={b.bundleId} className="collab-row">
              <code title={b.bundleId}>{b.bundleId}</code>
              <span className="muted">{b.format}</span>
              <button
                type="button"
                onClick={() => onCopy(b)}
                title="Copier l'id du bundle local"
              >
                Copier l’identifiant
              </button>
              <button
                type="button"
                onClick={() => onDownload(b)}
                title="Télécharger le bundle"
              >
                Télécharger
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => onUnshare(b.bundleId)}
                title="Supprimer cet export local"
              >
                Supprimer l’export
              </button>
              <span className="muted" hidden={sessionId === b.sessionId}>
                autre conversation
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
