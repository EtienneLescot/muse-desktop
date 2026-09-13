/**
 * w-settings (US-16 sandbox + US-31 providers): settings panel UI.
 *
 * - Workspace root display (read-only) + a path probe: an out-of-scope
 *   attempt routes to the existing scope-guard prompt path via
 *   `checkPathScope` instead of being applied silently.
 * - Sandbox mode select (workspace-confined default); network/elevated
 *   need their explicit permission toggle persisted alongside.
 * - Hidden web-search default note.
 * - Provider/model picker over the local sample registry, labelled
 *   "configured providers" (the backend model list is unsourced, so this
 *   is never presented as a live list). Selection persists per project.
 */
import { useState } from "react";
import type { ScopeVerdict } from "../lib/scope";
import {
  CONFIGURED_PROVIDERS,
  WEB_SEARCH_DEFAULT_NOTE,
  canSelectMode,
  effectiveSandboxMode,
  isOutsideWorkspace,
  type SandboxMode,
  type SandboxSettings,
} from "../lib/settings";

interface Props {
  /** Absolute workspace root; null while none is picked. */
  workspace: string | null;
  sandbox: SandboxSettings;
  onSandboxChange: (next: SandboxSettings) => void;
  /** Provider id selected for the current project. */
  providerId: string;
  onProviderChange: (id: string) => void;
  /**
   * Existing scope-guard prompt path: out-of-scope attempts go here.
   * Surfaces the backend verdict (and the error-banner prompt) for the path.
   */
  checkPathScope: (path: string) => Promise<ScopeVerdict>;
  onClose?: () => void;
}

export function SettingsPanel({
  workspace,
  sandbox,
  onSandboxChange,
  providerId,
  onProviderChange,
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
        <h2>Settings</h2>
        {onClose && (
          <button type="button" className="icon" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        )}
      </header>

      <div className="settings-group">
        <h3>Workspace</h3>
        <p className="settings-root" title={workspace ?? ""}>
          {workspace ?? "No workspace selected"}
        </p>
        <label className="settings-label" htmlFor="settings-path-probe">
          Check a path against the workspace
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
            {probing ? "…" : "Check"}
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
          Sandbox mode (default: workspace-confined)
        </label>
        <select
          id="settings-sandbox-mode"
          value={sandbox.mode}
          onChange={(e) => pickMode(e.target.value as SandboxMode)}
          aria-label="Sandbox mode"
        >
          <option value="workspace">Workspace-confined</option>
          <option value="network" disabled={!sandbox.networkAllowed}>
            Network{!sandbox.networkAllowed ? " (needs permission below)" : ""}
          </option>
          <option value="elevated" disabled={!sandbox.elevatedAllowed}>
            Elevated{!sandbox.elevatedAllowed ? " (needs permission below)" : ""}
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
          Allow network sandbox (explicit permission, persisted)
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={sandbox.elevatedAllowed}
            onChange={(e) =>
              onSandboxChange({ ...sandbox, elevatedAllowed: e.target.checked })
            }
          />
          Allow elevated sandbox (explicit permission, persisted)
        </label>
        <p className="settings-note">
          Effective mode: <strong>{effective}</strong>
          {!canSelectMode(sandbox, sandbox.mode) &&
            " — the selected mode stays workspace-confined until its permission is granted."}
        </p>
      </div>

      <div className="settings-group">
        <h3>Web search</h3>
        <p className="settings-note">{WEB_SEARCH_DEFAULT_NOTE}</p>
      </div>

      <div className="settings-group">
        <h3>Configured providers</h3>
        <p className="settings-note">
          Sample registry in the app — not a live backend list.
        </p>
        <label className="settings-label" htmlFor="settings-provider">
          Provider / model (saved per project)
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
          Project: {workspace ?? "none selected yet"}
        </p>
      </div>
    </section>
  );
}
