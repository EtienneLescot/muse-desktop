interface Props {
  hasWorkspace: boolean;
  onNewSession: () => void;
}

/** Empty session screen shown when no session is active. */
export function EmptySessionScreen({ hasWorkspace, onNewSession }: Props) {
  return (
    <div className="empty-session">
      <h2>No session yet</h2>
      <p>
        {hasWorkspace
          ? "Start your first Muse session in the selected workspace."
          : "Pick a workspace folder first, then start a session."}
      </p>
      <button onClick={onNewSession} disabled={!hasWorkspace}>
        New session
      </button>
    </div>
  );
}
