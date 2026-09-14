import type { ReactNode } from "react";
import { WorkspacePicker } from "./WorkspacePicker";
import { useState } from "react";
import { Icon } from "./Icon";

interface Props {
  /** Default folder for the new thread; null until the user picks one. */
  workspace: string | null;
  onPickWorkspace: (path: string) => void;
  onNewSession: () => void | Promise<void>;
  onDraft?: (text: string) => void;
  backendMissing?: boolean;
  /** US-33: explicit sidecar failure rendered instead of the blank screen. */
  sidecarError?: ReactNode | null;
}

/**
 * Empty session screen shown when no session is active. Codex-like: the
 * folder is chosen here, per thread, at creation time — there is no
 * global folder lock in the sidebar.
 */
export function EmptySessionScreen({
  workspace,
  onPickWorkspace,
  onNewSession,
  onDraft,
  backendMissing,
  sidecarError,
}: Props) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  async function start() {
    if (!workspace || backendMissing || starting) return;
    setStarting(true);
    try {
      onDraft?.(draft);
      await onNewSession();
    } finally {
      setStarting(false);
    }
  }
  if (sidecarError) {
    return <div className="empty-session wide">{sidecarError}</div>;
  }
  return (
    <div className="empty-session">
      <span className="muse-logo">
        <img src="muse-logo.png" alt="Muse logo" />
      </span>
      <h2>
        Vos idées.
        <br />
        Un peu plus loin.
      </h2>
      <p>Construisez, explorez et livrez avec Muse.</p>
      <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
      <div className="welcome-suggestions">
        {[
          [
            "Créer une interface",
            "Crée une page d’accueil avec les composants du projet.",
          ],
          [
            "Explorer le projet",
            "Explique la structure du projet et ses principaux composants.",
          ],
          [
            "Revoir le code",
            "Analyse les modifications et propose une revue de code.",
          ],
        ].map(([title, prompt]) => (
          <button key={title} onClick={() => setDraft(prompt)}>
            <Icon name="code" />
            {title}
            <small>Commencer avec Muse ↗</small>
          </button>
        ))}
      </div>
      <div className="welcome-draft">
        <textarea
          aria-label="Décrivez votre tâche"
          placeholder="Décrivez ce que vous voulez construire…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div>
          <small>
            {backendMissing
              ? "Disponible dans l’application desktop"
              : workspace
                ? "Votre demande sera prête à envoyer."
                : "Choisissez un dossier pour commencer."}
          </small>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={!workspace || backendMissing || starting}
          >
            {starting ? "Ouverture…" : "Créer la tâche"}
            <Icon name="plus" />
          </button>
        </div>
      </div>
    </div>
  );
}
