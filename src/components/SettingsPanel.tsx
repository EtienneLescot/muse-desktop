/**
 * w-settings (US-16 sandbox + US-31 providers): settings panel UI.
 *
 * - Workspace root display (read-only) + a path probe: an out-of-scope
 *   attempt routes to the existing scope-guard prompt path via
 *   `checkPathScope` instead of being applied silently.
 * - Isolation preference select (workspace-confined default); network/elevated
 *   need their explicit permission toggle persisted alongside.
 * - Hidden web-search default note.
 * - Model picker over the live host catalog when reachable (US-31):
 *   `model/list` snapshot with host-flagged active/default rows; picking
 *   one calls `session/setModel` on the active session. Unreachable
 *   backend falls back to the local sample registry, labelled "configured
 *   providers" (never a live list). Provider selection persists per
 *   project either way.
 */
import { useEffect, useRef, useState } from "react";
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
import {
  AUTHORIZATION_MODES,
  authorizationModeDescription,
  authorizationModeLabel,
  type AuthorizationMode,
} from "../lib/authorization";
import { userFacingError } from "../lib/errorCopy";
import {
  consumeStorageIssues,
  exportStorageSnapshot,
  inspectStorageSnapshot,
  importStorageSnapshot,
  migrateLegacyStorage,
  subscribeStorageIssues,
  type StorageIssue,
  type StorageSnapshotPreview,
} from "../lib/storage";

interface Props {
  /** Absolute workspace root; null while none is picked. */
  workspace: string | null;
  /** Change the default folder for new threads. */
  onPickWorkspace: (path: string) => void;
  sandbox: SandboxSettings;
  onSandboxChange: (next: SandboxSettings) => void;
  authorizationMode: AuthorizationMode;
  onAuthorizationModeChange: (mode: AuthorizationMode) => void;
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
  /** Export bounded local diagnostics without transcript contents. */
  onExportDiagnostics: () => void;
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
  authorizationMode,
  onAuthorizationModeChange,
  providerId,
  onProviderChange,
  liveModels,
  modelsError,
  activeSessionId,
  onRefreshModels,
  onSelectModel,
  onExportDiagnostics,
  checkPathScope,
  onClose,
}: Props) {
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [storageIssues, setStorageIssues] = useState<StorageIssue[]>(() =>
    consumeStorageIssues(),
  );

  useEffect(() => {
    const unsubscribe = subscribeStorageIssues(() => {
      const next = consumeStorageIssues();
      if (next.length === 0) return;
      setStorageIssues((previous) => {
        const merged = [...previous, ...next];
        return merged.filter(
          (issue, index) =>
            merged.findIndex(
              (candidate) => candidate.key === issue.key && candidate.kind === issue.kind,
            ) === index,
        );
      });
    });
    return unsubscribe;
  }, []);
  const [recoveryPreview, setRecoveryPreview] = useState<{
    serialized: string;
    snapshot: StorageSnapshotPreview;
  } | null>(null);
  const [selectedRecoveryKeys, setSelectedRecoveryKeys] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeStorageIssues(() => {
      const next = consumeStorageIssues();
      if (next.length === 0) return;
      setStorageIssues((previous) => {
        const merged = [...previous, ...next];
        return merged.filter(
          (issue, index) =>
            merged.findIndex(
              (candidate) => candidate.key === issue.key && candidate.kind === issue.kind,
            ) === index,
        );
      });
    });
    return unsubscribe;
  }, []);

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

  function exportLocalData(): void {
    try {
      const blob = new Blob([exportStorageSnapshot()], { type: "application/json" });
      const issues = consumeStorageIssues();
      if (issues.length > 0) {
        setStorageIssues((previous) => {
          const merged = [...previous, ...issues];
          return merged.filter(
            (issue, index) =>
              merged.findIndex(
                (candidate) =>
                  candidate.key === issue.key && candidate.kind === issue.kind,
              ) === index,
          );
        });
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `muse-desktop-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportStatus(
        issues.length > 0
          ? "Recovery snapshot downloaded with storage warnings."
          : "Recovery snapshot downloaded.",
      );
    } catch (error) {
      setExportStatus(userFacingError(`Recovery export failed: ${String(error)}`));
    }
  }

  async function inspectLocalData(file: File): Promise<void> {
    try {
      const serialized = await file.text();
      const snapshot = inspectStorageSnapshot(serialized);
      if (snapshot.entries.length === 0) {
        setRecoveryPreview(null);
        setSelectedRecoveryKeys([]);
        setExportStatus(snapshot.errors.join(" ") || "No recoverable Muse entries found.");
        return;
      }
      setRecoveryPreview({ serialized, snapshot });
      setSelectedRecoveryKeys(snapshot.entries.filter((entry) => !entry.existing).map((entry) => entry.key));
      setExportStatus(
        snapshot.errors.length > 0
          ? `Recovery snapshot ready with ${snapshot.errors.length} warnings. Choose entries to restore.`
          : "Recovery snapshot ready. Choose entries to restore.",
      );
    } catch (error) {
      setExportStatus(userFacingError(`Recovery import failed: ${String(error)}`));
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  }

  function restoreSelectedData(): void {
    if (recoveryPreview === null) return;
    if (selectedRecoveryKeys.length === 0) {
      setExportStatus("Choose at least one entry to restore.");
      return;
    }
    const imported = importStorageSnapshot(
      recoveryPreview.serialized,
      "muse-desktop.",
      true,
      selectedRecoveryKeys,
    );
    const issues = consumeStorageIssues();
    if (issues.length > 0) setStorageIssues((previous) => [...previous, ...issues]);
    setExportStatus(
      imported.errors.length > 0
        ? `Recovery restored ${imported.imported} entries with ${imported.errors.length} warnings.`
        : `Recovery restored ${imported.imported} entries. Reloading Muse…`,
    );
    if (imported.imported > 0) {
      setRecoveryPreview(null);
      setSelectedRecoveryKeys([]);
      window.setTimeout(() => window.location.reload(), 500);
    }
  }

  function cancelRecovery(): void {
    setRecoveryPreview(null);
    setSelectedRecoveryKeys([]);
    setExportStatus("Recovery restore cancelled.");
  }

  function migrateLocalData(): void {
    const result = migrateLegacyStorage();
    const issues = consumeStorageIssues();
    if (issues.length > 0) setStorageIssues((previous) => [...previous, ...issues]);
    setExportStatus(
      result.migrated > 0
        ? `Migrated ${result.migrated} legacy entr${result.migrated === 1 ? "y" : "ies"}. Reloading Muse…`
        : result.errors.length > 0
          ? `Legacy migration skipped with ${result.errors.length} warnings.`
          : "No legacy Muse data found to migrate.",
    );
    if (result.migrated > 0) window.setTimeout(() => window.location.reload(), 500);
  }

  return (
    <section className="settings-panel" aria-label="Settings">
      <header className="settings-head">
        <h2>Settings</h2>
        {onClose && (
          <button
            type="button"
            className="icon"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </header>

      <div className="settings-group">
        <h3>Default folder</h3>
        <p className="settings-note">
          This folder is suggested for new conversations. Existing
          conversations keep their own folder.
        </p>
        <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
      </div>
      <div className="settings-group">
        <h3>Check a path</h3>
        <label className="settings-label" htmlFor="settings-path-probe">
          Check access to a path in the project
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
            aria-label="Path to check"
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
        <h3>Authorization</h3>
        <p className="settings-note">
          Choose how Muse handles tool actions across your conversations.
        </p>
        <div
          className="authorization-mode-list"
          role="radiogroup"
          aria-label="Global authorization mode"
        >
          {AUTHORIZATION_MODES.map((mode) => (
            <label
              key={mode}
              className={`authorization-mode ${
                authorizationMode === mode ? "selected" : ""
              } authorization-${mode}`}
            >
              <input
                type="radio"
                name="authorization-mode"
                value={mode}
                checked={authorizationMode === mode}
                onChange={() => onAuthorizationModeChange(mode)}
              />
              <span className="authorization-mode-copy">
                <strong>{authorizationModeLabel(mode)}</strong>
                <span>{authorizationModeDescription(mode)}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="settings-note authorization-status" role="status">
          Current posture: <strong>{authorizationModeLabel(authorizationMode)}</strong>
        </p>
      </div>

      <div className="settings-group">
        <h3>Isolation preferences</h3>
        <p className="settings-note">
          These preferences do not yet change the isolation of the running
          engine.
        </p>
        <label className="settings-label" htmlFor="settings-sandbox-mode">
          Isolation (workspace by default)
        </label>
        <select
          id="settings-sandbox-mode"
          value={sandbox.mode}
          onChange={(e) => pickMode(e.target.value as SandboxMode)}
          aria-label="Isolation preference"
        >
          <option value="workspace">Workspace only</option>
          <option value="network" disabled={!sandbox.networkAllowed}>
            Network
            {!sandbox.networkAllowed
              ? " (permission required below)"
              : ""}
          </option>
          <option value="elevated" disabled={!sandbox.elevatedAllowed}>
            Elevated access
            {!sandbox.elevatedAllowed
              ? " (permission required below)"
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
          Allow network access (saved permission)
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={sandbox.elevatedAllowed}
            onChange={(e) =>
              onSandboxChange({ ...sandbox, elevatedAllowed: e.target.checked })
            }
          />
          Allow elevated access (saved permission)
        </label>
        <p className="settings-note">
          Saved preference : <strong>{effective}</strong>
          {!canSelectMode(sandbox, sandbox.mode) &&
            " — permission required for this preference."}
        </p>
      </div>

      <div className="settings-group">
        <h3>Web search</h3>
        <p className="settings-note">{WEB_SEARCH_DEFAULT_NOTE}</p>
      </div>

      <div className="settings-group">
        <h3>Local data</h3>
        <p className="settings-note">
          Export conversations and local settings for recovery or support. The
          snapshot stays on this device until you choose where to share it.
        </p>
        <div className="settings-row">
          <button type="button" onClick={exportLocalData}>
            Export recovery snapshot
          </button>
          <button type="button" onClick={onExportDiagnostics}>
            Export diagnostics
          </button>
          <button type="button" onClick={() => importInput.current?.click()}>
            Import recovery snapshot
          </button>
          <button type="button" onClick={migrateLocalData}>
            Migrate legacy data
          </button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void inspectLocalData(file);
            }}
          />
        </div>
        {exportStatus !== null && (
          <p className="settings-note" role="status">{exportStatus}</p>
        )}
        {recoveryPreview !== null && (
          <div className="settings-recovery" role="group" aria-labelledby="settings-recovery-title">
            <div className="settings-recovery-head">
              <strong id="settings-recovery-title">Choose data to restore</strong>
              <span className="muted">{recoveryPreview.snapshot.entries.length} entries</span>
            </div>
            <p className="settings-note">
              New entries are selected by default. Existing entries stay unchecked until you explicitly choose to replace them.
            </p>
            <div className="settings-recovery-list">
              {recoveryPreview.snapshot.entries.map((entry) => (
                <label key={entry.key} className="settings-recovery-item">
                  <input
                    type="checkbox"
                    checked={selectedRecoveryKeys.includes(entry.key)}
                    onChange={() => setSelectedRecoveryKeys((current) =>
                      current.includes(entry.key)
                        ? current.filter((key) => key !== entry.key)
                        : [...current, entry.key])}
                  />
                  <span>
                    <code>{entry.key}</code>
                    <small>
                      {entry.existing ? "Replace existing" : "Add new"}
                      {entry.parseError ? " · raw value" : ""}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <div className="settings-recovery-actions">
              <button type="button" className="primary" onClick={restoreSelectedData}>
                Restore selected
              </button>
              <button type="button" onClick={cancelRecovery}>Cancel</button>
            </div>
            {recoveryPreview.snapshot.errors.length > 0 && (
              <small className="muted">{recoveryPreview.snapshot.errors.join(" · ")}</small>
            )}
          </div>
        )}
        {storageIssues.length > 0 && (
          <div className="settings-storage-warning" role="status">
            <strong>Local data needs attention</strong>
            <p>
              Muse kept the active session in memory, but some local data could
              not be read or saved. Export a recovery snapshot before clearing
              browser data.
            </p>
            <ul>
              {storageIssues.map((issue) => (
                <li key={`${issue.kind}:${issue.key}`}>
                  {issue.kind === "corrupt"
                    ? "Corrupted data"
                    : issue.kind === "quota"
                      ? "Storage quota reached"
                      : "Storage unavailable"}{" "}
                  (<code>{issue.key}</code>)
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="settings-group">
        <h3>
          {liveModels === null
            ? "Configured providers"
            : "Available models"}
        </h3>
        {liveModels === null ? (
          <>
            <p className="settings-note">
              Example configurations. Connect the engine to see the
              available models.
              {modelsError !== null && ` (${userFacingError(modelsError)})`}
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
              Project: {workspace ?? "no folder selected"}
            </p>
          </>
        ) : (
          <>
            <p className="settings-note">
              Engine catalog ({liveModels.length} model
              {liveModels.length === 1 ? "" : "s"}).
              <button
                type="button"
                className="settings-link"
                onClick={onRefreshModels}
              >
                Refresh
              </button>
            </p>
            <label className="settings-label" htmlFor="settings-model">
              Model for the active conversation
            </label>
            <select
              id="settings-model"
              value={liveModels.find((m) => m.isActive)?.modelId ?? ""}
              onChange={(e) => {
                if (e.target.value.length > 0) onSelectModel(e.target.value);
              }}
              disabled={activeSessionId === null}
              aria-label="Model for the active conversation"
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
                Open a conversation to choose its model.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
