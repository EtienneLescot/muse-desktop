import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PRIVACY_STEPS, type MacPermissions, type PrivacyPane } from "../lib/computerUse";

interface Props {
  permissions: MacPermissions | null;
  busy: boolean;
  onRefresh: () => Promise<unknown>;
  /** Restart the driver at its current level (macOS applies some grants only then). */
  onRestart: () => Promise<void>;
}

const POLL_MS = 3_000;

/**
 * macOS computer-use onboarding. Accessibility and Screen Recording are
 * granted to CuaDriver (not to Muse-Desktop), in System Settings, by the user.
 * The app cannot grant them; it can say exactly which one is missing, open the
 * right pane, and notice on its own when the user is done.
 */
export function MacPermissionsGuide({ permissions, busy, onRefresh, onRestart }: Props) {
  const [error, setError] = useState<string | null>(null);

  // The user is in System Settings, not here: re-check on a timer and when
  // they come back, so the panel turns green without a click.
  useEffect(() => {
    const timer = window.setInterval(() => void onRefresh(), POLL_MS);
    const onFocus = () => void onRefresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [onRefresh]);

  const open = async (pane: PrivacyPane) => {
    try {
      setError(null);
      await invoke("computer_open_privacy_pane", { pane });
    } catch (e) {
      setError(String(e));
    }
  };

  const allGranted = permissions !== null && permissions.accessibility && permissions.screenRecording;

  return (
    <div className="mac-permissions" role="region" aria-label="Allow CuaDriver in macOS">
      <ol className="mac-permissions-steps">
        {PRIVACY_STEPS.map(({ pane, label, detail }, index) => {
          const granted = permissions?.[pane] === true;
          return (
            <li key={pane} data-granted={granted}>
              <span className="mac-permissions-mark" aria-hidden="true">{granted ? "✓" : index + 1}</span>
              <div>
                <strong>{label}</strong>
                <span>{granted ? "Allowed" : detail}</span>
              </div>
              {!granted && (
                <button type="button" className="primary" onClick={() => void open(pane)}>
                  Open System Settings
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mac-permissions-help">
        In the list that opens, turn on <strong>CuaDriver</strong>. If it is not listed, click{" "}
        <strong>+</strong> and choose Applications › CuaDriver. If macOS offers to quit and reopen
        CuaDriver, accept. Muse-Desktop itself needs neither permission.
      </p>
      {allGranted ? (
        <div className="mac-permissions-restart">
          <span>Both are allowed. macOS applies them once CuaDriver restarts.</span>
          <button type="button" className="primary" disabled={busy} onClick={() => void onRestart()}>
            Restart CuaDriver
          </button>
        </div>
      ) : (
        <p className="mac-permissions-waiting" aria-live="polite">
          Waiting for macOS… this updates on its own.
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
