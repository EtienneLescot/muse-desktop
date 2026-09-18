import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  startupRecoverySteps,
  type SidecarErrorKind,
} from "../lib/sidecarError";
import { userFacingError } from "../lib/errorCopy";
import {
  startupCheckStatusLabel,
  type StartupProbe,
  type StartupCheck,
} from "../lib/startupProbe";

interface Props {
  kind: SidecarErrorKind;
  message: string;
  triedPaths: string[];
  onRetry: () => void;
  onPickWorkspace: (path: string) => void;
  startupProbe?: StartupProbe | null;
}

/**
 * US-33: explicit sidecar startup failure instead of a blank screen.
 * Names the expected triple-suffixed binary, lists the probed locations,
 * and offers retry + workspace re-pick. Flat error-banner styling, no
 * decoration.
 */
export function SidecarErrorPanel({
  kind,
  message,
  triedPaths,
  onRetry,
  onPickWorkspace,
  startupProbe,
}: Props) {
  const [pickerError, setPickerError] = useState<string | null>(null);
  const recoverySteps = startupRecoverySteps(kind, message);

  async function pickWorkspace() {
    try {
      setPickerError(null);
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string" && dir.length > 0) onPickWorkspace(dir);
    } catch (e) {
      setPickerError(userFacingError(`folder picker failed: ${String(e)}`));
    }
  }

  const checks: Array<[string, StartupCheck]> = startupProbe === null || startupProbe === undefined
    ? []
    : [
        ["Sidecar", startupProbe.sidecar],
        ...(startupProbe.wsl ? [["WSL", startupProbe.wsl] as [string, StartupCheck]] : []),
        ...(startupProbe.museCli ? [["Muse CLI", startupProbe.museCli] as [string, StartupCheck]] : []),
        ...(startupProbe.workspace ? [["Workspace", startupProbe.workspace] as [string, StartupCheck]] : []),
      ];

  return (
    <div className="sidecar-error" role="alert">
      <h2>
        {kind === "missing"
          ? "Sidecar binary not found"
          : "Could not start the Muse sidecar"}
      </h2>
      <p className="sidecar-error-message">{message}</p>
      {checks.length > 0 && (
        <section className="startup-probe" aria-label="Environment check">
          <header>
            <h3>Environment check</h3>
            <span className="muted">{startupProbe?.platform}</span>
          </header>
          <ul>
            {checks.map(([label, check]) => (
              <li key={label} data-status={check.status}>
                <span className="startup-probe-dot" aria-hidden="true" />
                <span className="startup-probe-label">{label}</span>
                <span className="startup-probe-status">{startupCheckStatusLabel(check.status)}</span>
                <span className="startup-probe-detail">{check.detail || check.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="sidecar-error-help">
        <h3>Next steps</h3>
        <ol>
          {recoverySteps.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </li>
          ))}
        </ol>
      </div>
      {kind === "missing" && (
        <div>
          <p>
            Place <code>binaries/muse-&lt;target-triple&gt;</code> (plus{" "}
            <code>.exe</code> on Windows) at one of these locations:
          </p>
          <ul>
            <li>
              Next to the app executable — <code>&lt;exe-dir&gt;/binaries/</code>{" "}
              (bundled layout)
            </li>
            <li>
              Dev tree — <code>src-tauri/binaries/</code> (see{" "}
              <code>src-tauri/binaries/README.md</code>)
            </li>
          </ul>
          {triedPaths.length > 0 && (
            <div>
              <p className="muted">Paths already probed:</p>
              <ul className="sidecar-error-paths">
                {triedPaths.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="sidecar-error-actions">
        <button onClick={onRetry}>Try again</button>
        <button onClick={pickWorkspace}>Choose workspace folder</button>
      </div>
      {pickerError && <span className="error">{pickerError}</span>}
    </div>
  );
}
