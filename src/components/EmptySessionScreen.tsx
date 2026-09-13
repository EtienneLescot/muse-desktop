import type { ReactNode } from "react";
import { WorkspacePicker } from "./WorkspacePicker";

interface Props {
  /** Default folder for the new thread; null until the user picks one. */
  workspace: string | null;
  onPickWorkspace: (path: string) => void;
  onNewSession: () => void;
  /** US-33: explicit sidecar failure rendered instead of the blank screen. */
  sidecarError?: ReactNode | null;
}

/**
 * Empty session screen shown when no session is active. Codex-like: the
 * folder is chosen here, per thread, at creation time — there is no
 * global folder lock in the sidebar.
 */
export function EmptySessionScreen({ workspace, onPickWorkspace, onNewSession, sidecarError }: Props) {
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
        {workspace !== null
          ? "Start your first Muse session in this folder."
          : "Pick a folder for this thread, then start a session."}
      </p>
      <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
      <button className="primary" onClick={onNewSession} disabled={workspace === null}>
        New session
      </button>
    </div>
  );
}
