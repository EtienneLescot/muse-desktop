/**
 * w-settings (US-16 sandbox + US-31 providers): settings panel UI.
 *
 * - Workspace root display (read-only) + a path probe: an out-of-scope
 *   attempt routes to the existing scope-guard prompt path via
 *   `checkPathScope` instead of being applied silently.
 * - Sandbox mode select (workspace-confined default); network/elevated
 *   need their explicit permission toggle persisted alongside.
 * - Hidden web-search default note.
 * - Model picker over the live host catalog when reachable (US-31):
 *   `model/list` snapshot with host-flagged active/default rows; picking
 *   one calls `session/setModel` on the active session. Unreachable
 *   backend falls back to the local sample registry, labelled "configured
 *   providers" (never a live list). Provider selection persists per
 *   project either way.
 */
import { useState } from "react";
import { WorkspacePicker } from "./WorkspacePicker";
import type { ScopeVerdict } from "../lib/scope";
import {
  CONFIGURED_PROVIDERS,
  WEB_SEARCH_DEFAULT_NOTE,
  canSelectMode,
  effectiveSandboxMode,
  isOutsideWorkspace,
  type LiveModel,
  type SandboxMode,
  type SandboxSettings,
} from "../lib/settings";

interface Props {
  /** Absolute workspace root; null while none is picked. */
  workspace: string | null;
  /** Change the default folder for new threads. */
  onPickWorkspace: (path: string) => void;
  sandbox: SandboxSettings;
  onSandboxChange: (next: SandboxSettings) => void;
  /** Provider id selected for the current project. */
  providerId: string;
  onProviderChange: (id: string) => void;
  /** Live host catalog (`model/list` snapshot); null when unloaded. */
  liveModels: LiveModel[] | null;
  /** Last catalog load failure; the picker falls back silently otherwise. */
  modelsError: string | null;
  /** Active session id; null disables the live pick (needs a target). */
  activeSessionId: string | null;
  /** Reload the catalog (host-flagged active row follows the session). */
  onRefreshModels: () => void;
  /** Model-picker gesture on the active session (`session/setModel`). */
  onSelectModel: (modelId: string) => void;
  /**
   * Existing scope-guard prompt path: out-of-scope attempts go here.
   * Surfaces the backend verdict (and the error-banner prompt) for the path.
   */
  checkPathScope: (path: string) => Promise<ScopeVerdict>;
  onClose?: () => void;
}

export function SettingsPanel({
  workspace,
  onPickWorkspace,
  sandbox,
  onSandboxChange,
  providerId,
  onProviderChange,
  liveModels,
  modelsError,
  activeSessionId,
  onRefreshModels,
  onSelectModel,
  checkPathScope,
  onClose,
}: Props) {
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const effective = effectiveSandboxMode(sandbox);

  async function runProbe(): Promise<void> {
    const path = probe.trim();
    if (path.length === 0 || probing) return;
    if (!isOutsideWorkspace(workspace, path)) {
      setProbeResult(`In scope: ${path} is inside the workspace.`);
      return;
    }
    // Out-of-scope attempt: route to the existing scope-guard prompt path.
    setProbing(true);
    try {
      const verdict = await checkPathScope(path);
      setProbeResult(
        verdict.in_scope
          ? `Scope guard allowed ${path}: ${verdict.reason}`
          : `Scope guard prompt: ${verdict.reason}`,
      );
    } finally {
      setProbing(false);
    }
  }

  function pickMode(mode: SandboxMode): void {
    onSandboxChange({ ...sandbox, mode });
  }

  return (
    <section className="settings-panel" aria-label="Settings">
      <header className="settings-head">
        <h2>Paramètres</h2>
        {onClose && (
          <button
            type="button"
            className="icon"
            aria-label="Fermer les paramètres"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </header>

      <div className="settings-group">
        <h3>Dossier par défaut</h3>
        <p className="settings-note">
          Each thread keeps its own folder (shown in its topbar); this only
          pre-fills creation.
        </p>
        <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
      </div>
      <div className="settings-group">
        <h3>Vérifier un chemin</h3>
        <label className="settings-label" htmlFor="settings-path-probe">
          Vérifier l’accès à un chemin dans le projet
        </label>
        <div className="settings-row">
          <input
            id="settings-path-probe"
            type="text"
            value={probe}
            onChange={(e) => {
              setProbe(e.target.value);
              setProbeResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runProbe();
            }}
            placeholder="/absolute/path/to/check"
            aria-label="Path to check against the workspace"
          />
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={probe.trim().length === 0 || probing}
          >
            {probing ? "…" : "Vérifier"}
          </button>
        </div>
        {probeResult !== null && (
          <p className="settings-note" role="status">
            {probeResult}
          </p>
        )}
      </div>

      <div className="settings-group">
        <h3>Sandbox</h3>
        <label className="settings-label" htmlFor="settings-sandbox-mode">
          Isolation (limitée au projet par défaut)
        </label>
        <select
          id="settings-sandbox-mode"
          value={sandbox.mode}
          onChange={(e) => pickMode(e.target.value as SandboxMode)}
          aria-label="Sandbox mode"
        >
          <option value="workspace">Limité au projet</option>
          <option value="network" disabled={!sandbox.networkAllowed}>
            Réseau
            {!sandbox.networkAllowed
              ? " (autorisation requise ci-dessous)"
              : ""}
          </option>
          <option value="elevated" disabled={!sandbox.elevatedAllowed}>
            Droits étendus
            {!sandbox.elevatedAllowed
              ? " (autorisation requise ci-dessous)"
              : ""}
          </option>
        </select>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={sandbox.networkAllowed}
            onChange={(e) =>
              onSandboxChange({ ...sandbox, networkAllowed: e.target.checked })
            }
          />
          Autoriser le réseau (autorisation enregistrée)
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={sandbox.elevatedAllowed}
            onChange={(e) =>
              onSandboxChange({ ...sandbox, elevatedAllowed: e.target.checked })
            }
          />
          Autoriser les droits étendus (autorisation enregistrée)
        </label>
        <p className="settings-note">
          Mode effectif : <strong>{effective}</strong>
          {!canSelectMode(sandbox, sandbox.mode) &&
            " — the selected mode stays workspace-confined until its permission is granted."}
        </p>
      </div>

      <div className="settings-group">
        <h3>Web search</h3>
        <p className="settings-note">{WEB_SEARCH_DEFAULT_NOTE}</p>
      </div>

      <div className="settings-group">
        <h3>
          {liveModels === null
            ? "Fournisseurs configurés"
            : "Modèles disponibles"}
        </h3>
        {liveModels === null ? (
          <>
            <p className="settings-note">
              Sample registry in the app — not a live backend list.
              {modelsError !== null && ` (${modelsError})`}
            </p>
            <label className="settings-label" htmlFor="settings-provider">
              Fournisseur / modèle (enregistré par projet)
            </label>
            <select
              id="settings-provider"
              value={providerId}
              onChange={(e) => onProviderChange(e.target.value)}
              aria-label="Provider and model"
            >
              {CONFIGURED_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.model}
                </option>
              ))}
            </select>
            <p className="settings-note">
              Project: {workspace ?? "aucun dossier sélectionné"}
            </p>
          </>
        ) : (
          <>
            <p className="settings-note">
              Live host catalog snapshot ({liveModels.length} model
              {liveModels.length === 1 ? "" : "s"}).
              <button
                type="button"
                className="settings-link"
                onClick={onRefreshModels}
              >
                Actualiser
              </button>
            </p>
            <label className="settings-label" htmlFor="settings-model">
              Modèle de la tâche active
            </label>
            <select
              id="settings-model"
              value={liveModels.find((m) => m.isActive)?.modelId ?? ""}
              onChange={(e) => {
                if (e.target.value.length > 0) onSelectModel(e.target.value);
              }}
              disabled={activeSessionId === null}
              aria-label="Live model for the active session"
            >
              {liveModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.displayLabel}
                  {m.isDefault ? " (default)" : ""}
                  {m.isActive ? " (active)" : ""}
                </option>
              ))}
            </select>
            {activeSessionId === null && (
              <p className="settings-note">
                Start or select a session to change its model.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
