import type { ReactNode } from "react";

interface Props {
  hasWorkspace: boolean;
  onNewSession: () => void;
  /** US-33: explicit sidecar failure rendered instead of the blank screen. */
  sidecarError?: ReactNode | null;
}

/** Empty session screen shown when no session is active. */
export function EmptySessionScreen({ hasWorkspace, onNewSession, sidecarError }: Props) {
  if (sidecarError) {
    return <div className="empty-session wide">{sidecarError}</div>;
  }
  return (
    <div className="empty-session">
      <span className="muse-logo">
        <img src="muse-logo.png" alt="Muse logo" />
      </span>
      <h2>No session yet</h2>
      <p>
        {hasWorkspace
          ? "Start your first Muse session in the selected workspace."
          : "Pick a workspace folder first, then start a session."}
      </p>
      <button className="primary" onClick={onNewSession} disabled={!hasWorkspace}>
        New session
      </button>
    </div>
  );
}
