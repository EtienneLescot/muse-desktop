import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  startupRecoverySteps,
  type SidecarErrorKind,
} from "../lib/sidecarError";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  kind: SidecarErrorKind;
  message: string;
  triedPaths: string[];
  onRetry: () => void;
  onPickWorkspace: (path: string) => void;
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

  return (
    <div className="sidecar-error" role="alert">
      <h2>
        {kind === "missing"
          ? "Sidecar binary not found"
          : "Could not start the Muse sidecar"}
      </h2>
      <p className="sidecar-error-message">{message}</p>
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
