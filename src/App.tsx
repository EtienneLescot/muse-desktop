import { useMemo } from "react";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { EmptySessionScreen } from "./components/EmptySessionScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import { StreamView } from "./components/StreamView";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { Composer } from "./components/Composer";
import "./App.css";

export default function App() {
  const {
    sessions,
    activeId,
    activeLog,
    approvals,
    activeApprovals,
    workspace,
    setWorkspace,
    setActive,
    startSession,
    sendInput,
    approve,
    cancelSession,
    killSession,
    error,
    backendMissing,
  } = useMuseSessions();

  const active = sessions.find((s) => s.session_id === activeId) ?? null;

  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of approvals) counts[a.session_id] = (counts[a.session_id] ?? 0) + 1;
    return counts;
  }, [approvals]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>muse-desktop</h1>
        <WorkspacePicker workspace={workspace} onPick={setWorkspace} />
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
          pendingCounts={pendingCounts}
          onSelect={setActive}
          onNew={startSession}
          onCancel={cancelSession}
          onKill={killSession}
          canStart={workspace !== null}
        />
      </aside>
      <main className="conversation">
        {backendMissing && (
          <div className="error-banner">
            Preview mode: no Tauri backend here. Run inside the desktop app for
            live sessions; local history still works.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        {active === null ? (
          <EmptySessionScreen
            hasWorkspace={workspace !== null}
            onNewSession={startSession}
          />
        ) : (
          <div className="session-view">
            <header className="session-header">
              <span className="dot" data-running={active.running} />
              <h2>{active.title || active.session_id.slice(0, 8)}</h2>
              <span className="muted session-path" title={active.workspace}>
                {active.workspace}
              </span>
              <span className="muted">{active.running ? "running" : "stopped"}</span>
            </header>
            <ApprovalPanel approvals={activeApprovals} onDecision={approve} />
            <StreamView entries={activeLog} sessionId={active.session_id} />
            <Composer
              disabled={workspace === null || backendMissing}
              running={active.running}
              onSend={(text) => void sendInput(active.session_id, text)}
              onCancel={() => void cancelSession(active.session_id)}
            />
          </div>
        )}
      </main>
    </div>
  );
}
