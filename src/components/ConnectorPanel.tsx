import { useState } from "react";
import { CURATED_CONNECTORS, type ConnectorEntry } from "../lib/connectors";

interface Props {
  installed: ConnectorEntry[];
  /** Hot-listed tool names (re-read from the registry, no restart). */
  toolNames: string[];
  /** Last remote-guard message (single-remote / VPN failure), if any. */
  remoteNotice: string | null;
  onInstall: (dirId: string) => void;
  onUninstall: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  /** Returns false when the guard refused (message lands in remoteNotice). */
  onAddRemote: (name: string, url: string) => boolean;
}

/**
 * US-24 connector directory + US-26 remote guard.
 *
 * - Curated local connectors install in 1 click (no manual JSON).
 * - Installed entries list their tools live (hot-list, no restart).
 * - Remote endpoints go through the single-remote + public-internet
 *   guard; refusals explain themselves (incl. the VPN failure message).
 */
export function ConnectorPanel({
  installed,
  toolNames,
  remoteNotice,
  onInstall,
  onUninstall,
  onToggle,
  onAddRemote,
}: Props) {
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const installedIds = new Set(installed.map((e) => e.id));

  return (
    <section className="integration-panel" aria-label="Connecteurs">
      <h3>Connecteurs</h3>
      <p className="muted">
        Catalogue de configuration. L’exécution des outils MCP n’est pas encore
        connectée.
      </p>
      <ul className="integration-list">
        {CURATED_CONNECTORS.map((c) => {
          const done = installedIds.has(c.id);
          return (
            <li key={c.id} className="integration-row">
              <span className="integration-main">
                <strong>{c.name}</strong>
                <small>{c.description}</small>
                <small className="muted">
                  {c.tools.map((t) => t.name).join(" · ")}
                </small>
              </span>
              {done ? (
                <span className="integration-flag">configuré</span>
              ) : (
                <button type="button" onClick={() => onInstall(c.id)}>
                  Ajouter
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {installed.length > 0 && (
        <>
          <h4>
            Configurés
            {toolNames.length > 0 && ` — ${toolNames.length} outil(s)`}
          </h4>
          <ul className="integration-list">
            {installed.map((e) => (
              <li key={e.id} className="integration-row">
                <span className="integration-main">
                  <strong>
                    {e.name}
                    {e.kind === "remote" && <small> (distant)</small>}
                  </strong>
                  <small className="muted">
                    {e.status === "disabled"
                      ? "désactivé"
                      : e.tools.length > 0
                        ? e.tools.map((t) => t.name).join(" · ")
                        : (e.guardMessage ?? "aucun outil listé")}
                  </small>
                </span>
                <label
                  className="integration-toggle"
                  title={e.status === "disabled" ? "Activer" : "Désactiver"}
                >
                  <input
                    type="checkbox"
                    checked={e.status !== "disabled"}
                    onChange={(ev) => onToggle(e.id, ev.target.checked)}
                  />
                </label>
                <button type="button" onClick={() => onUninstall(e.id)}>
                  Retirer
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Connecteur distant (1 seul)</h4>
      <form
        className="integration-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (remoteName.trim().length === 0 || remoteUrl.trim().length === 0)
            return;
          if (onAddRemote(remoteName.trim(), remoteUrl.trim())) {
            setRemoteName("");
            setRemoteUrl("");
          }
        }}
      >
        <input
          type="text"
          placeholder="Nom"
          aria-label="Nom du connecteur distant"
          value={remoteName}
          onChange={(ev) => setRemoteName(ev.target.value)}
        />
        <input
          type="url"
          placeholder="https://…"
          aria-label="URL publique HTTPS du connecteur distant"
          value={remoteUrl}
          onChange={(ev) => setRemoteUrl(ev.target.value)}
        />
        <button type="submit">Ajouter</button>
      </form>
      {remoteNotice !== null && (
        <p className="integration-notice" role="status">
          {remoteNotice}
        </p>
      )}
    </section>
  );
}
