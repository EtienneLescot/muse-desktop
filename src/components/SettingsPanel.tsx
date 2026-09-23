/**
 * w-settings (US-16 sandbox + US-31 providers): settings panel UI.
 *
 * Settings: environment check, default folder, authorization, reasoning
 * effort, isolation, Muse authentication and local data. The model is chosen
 * in the composer, not here.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WorkspacePicker } from "./WorkspacePicker";
import { describeAuth, canOfferSignIn, type AuthStatusPayload } from "../lib/museAuth";
import { isTauriRuntime } from "../lib/env";
import {
  startupCheckStatusLabel,
  startupProbeRows,
  sanitizeStartupText,
  type StartupProbe,
} from "../lib/startupProbe";
import {
  canSelectMode,
  effectiveSandboxMode,
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
  reasoningEffortChoices,
  reasoningEffortDescription,
  reasoningEffortLabel,
  type ReasoningEffort,
} from "../lib/reasoning";
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
  /** M2-02: apply a changed host posture by restarting the workspace host. */
  onRestartHost?: () => Promise<boolean>;
  authorizationMode: AuthorizationMode;
  onAuthorizationModeChange: (mode: AuthorizationMode) => void;
  /** Global host reasoning effort used by new conversations. */
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  /** Export bounded local diagnostics without transcript contents. */
  onExportDiagnostics: () => void;
  /** Latest read-only native prerequisite probe, when available. */
  startupProbe?: StartupProbe | null;
  /** Re-run the read-only native prerequisite probe. */
  onProbeStartup?: () => void | Promise<unknown>;
  /**
   * Run the CLI's sign-in inside the built-in terminal.
   *
   * The desktop never sees the credential: `muse login` prints a device code,
   * the user approves it in a browser, and the CLI stores the result itself.
   * That is why this drives a terminal instead of implementing OAuth — MSP is a
   * stdio protocol with no authentication concept, so there is no endpoint the
   * desktop could authenticate against on its own.
   */
  onSignIn: () => void | Promise<unknown>;
}

export function SettingsPanel({
  workspace,
  onPickWorkspace,
  sandbox,
  onSandboxChange,
  onRestartHost,
  authorizationMode,
  onAuthorizationModeChange,
  reasoningEffort,
  onReasoningEffortChange,
  onExportDiagnostics,
  startupProbe = null,
  onProbeStartup,
  onSignIn,
}: Props) {
  const [restartingHost, setRestartingHost] = useState(false);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [storageIssues, setStorageIssues] = useState<StorageIssue[]>(() =>
    consumeStorageIssues(),
  );
  /**
   * Which Muse credential is in effect. `null` means "not read yet or not
   * readable" and is rendered as such rather than as "no credential", which
   * would be a wrong and alarming claim.
   */
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);

  const refreshAuthStatus = () => {
    if (!isTauriRuntime()) return;
    void invoke<AuthStatusPayload>("muse_auth_status")
      .then((next) => setAuthStatus(next))
      .catch(() => setAuthStatus(null));
  };

  useEffect(() => {
    refreshAuthStatus();
  }, []);

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

  const effective = effectiveSandboxMode(sandbox);

  function pickMode(mode: SandboxMode): void {
    onSandboxChange({ ...sandbox, mode });
    setRestartStatus(null);
  }

  async function restartWorkspaceHost(): Promise<void> {
    if (onRestartHost === undefined || restartingHost) return;
    if (!window.confirm(
      "Restart the workspace host now? Active conversations will disconnect and keep their local transcript; reconnect them after the new host starts.",
    )) return;
    setRestartingHost(true);
    setRestartStatus(null);
    try {
      const ok = await onRestartHost();
      setRestartStatus(ok
        ? "Host restarted. Reconnect any durable conversations to continue."
        : "The host could not be restarted.");
    } finally {
      setRestartingHost(false);
    }
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
      setSelectedRecoveryKeys(
        snapshot.entries
          .filter((entry) => !entry.existing && entry.kind === "durable")
          .map((entry) => entry.key),
      );
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

  // Pure derivation: every warning/neutral case is decided and tested in
  // `src/lib/museAuth.ts`, so this component only renders the verdict.
  const authNotice = describeAuth(authStatus);

  return (
    <section className="settings-panel" aria-label="Settings">
      <div className="settings-group">
        <div className="settings-runtime-head">
          <div>
            <h3>Environment</h3>
            <p className="settings-note">
              Read-only checks for the desktop runtime, WSL, Muse CLI, and the selected workspace.
            </p>
          </div>
          {onProbeStartup && (
            <button
              type="button"
              className="settings-secondary-action"
              onClick={() => void onProbeStartup()}
            >
              Run check
            </button>
          )}
        </div>
        {startupProbe === null ? (
          <p className="settings-note settings-runtime-empty">
            No environment check has run in this window yet.
          </p>
        ) : (
          <div className="startup-probe settings-runtime-probe">
            <header>
              <h3>Environment check</h3>
              <span className="muted">
                {sanitizeStartupText(startupProbe.platform, 40)} · {new Date(startupProbe.checkedAt).toLocaleTimeString()}
              </span>
            </header>
            <ul>
              {startupProbeRows(startupProbe).map(({ label, check }) => (
                <li key={label} data-status={check.status}>
                  <span className="startup-probe-dot" aria-hidden="true" />
                  <span className="startup-probe-label">{label}</span>
                  <span className="startup-probe-status">{startupCheckStatusLabel(check.status)}</span>
                  <span className="startup-probe-detail" title={check.detail}>
                    {check.detail || check.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="settings-group">
        <h3>Default folder</h3>
        <p className="settings-note">
          This folder is suggested for new conversations. Existing
          conversations keep their own folder.
        </p>
        <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
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
        <h3>Reasoning effort</h3>
        <p className="settings-note">
          Sets how much time Muse spends reasoning before responding. This is
          applied to new conversations and can be overridden per project.
        </p>
        <label className="settings-label" htmlFor="settings-reasoning-effort">
          Default effort
        </label>
        <select
          id="settings-reasoning-effort"
          value={reasoningEffort}
          onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
          aria-label="Default reasoning effort"
        >
          {reasoningEffortChoices(reasoningEffort).map((effort) => (
            <option key={effort} value={effort}>
              {reasoningEffortLabel(effort)} — {reasoningEffortDescription(effort)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-group">
        <h3>Isolation preferences</h3>
        <p className="settings-note">
          Applied when a new Muse host starts for a workspace. Project
          overrides can tighten this posture; an existing host keeps its
          current posture until it is restarted.
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
        {onRestartHost !== undefined && workspace !== null && (
          <div className="settings-host-restart">
            <button
              type="button"
              className="settings-secondary-action"
              onClick={() => void restartWorkspaceHost()}
              disabled={restartingHost}
            >
              {restartingHost ? "Restarting host…" : "Restart workspace host"}
            </button>
            <span className="settings-note">
              Apply the selected posture to the running host. Conversations
              remain in Muse and can be reconnected explicitly.
            </span>
            {restartStatus !== null && (
              <span className="settings-note" role="status">{restartStatus}</span>
            )}
          </div>
        )}
      </div>

      <div className="settings-group">
        <h3>Muse authentication</h3>
        <p className="settings-note">
          The desktop does not hold your credentials. The Muse CLI owns the
          sign-in and stores the result itself, so nothing here can read or leak
          it.
        </p>
        <p className={authNotice.tone === "warning" ? "settings-note settings-note-warning" : "settings-note"}>
          <strong>{authNotice.headline}</strong>
        </p>
        {authNotice.detail !== null && (
          <p className="settings-note">{authNotice.detail}</p>
        )}
        <div className="settings-row">
          <button type="button" onClick={refreshAuthStatus}>
            Check again
          </button>
          {canOfferSignIn(authStatus) && (
            <button type="button" onClick={() => void onSignIn()}>
              Sign in with Meta
            </button>
          )}
        </div>
        {authStatus !== null && authStatus.cliAvailable !== true && (
          <p className="settings-note">
            The Muse CLI was not found on PATH, so the desktop cannot run the
            sign-in for you. Install Muse Code, or run <code>muse login</code>{" "}
            yourself.
          </p>
        )}
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
              New durable data is selected by default. UI state and existing entries stay unchecked until you explicitly choose to restore or replace them.
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
                      {entry.kind === "ui" ? "UI state" : "Durable data"} · {entry.existing ? "Replace existing" : "Add new"}
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

    </section>
  );
}
