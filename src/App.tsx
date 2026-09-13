import { useMemo } from "react";
import { BUILD_ID } from "./lib/env";
import { classifySidecarError, extractTriedPaths } from "./lib/sidecarError";
import { SidecarErrorPanel } from "./components/SidecarErrorPanel";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { EmptySessionScreen } from "./components/EmptySessionScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import { StreamView } from "./components/StreamView";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { InputPanel } from "./components/InputPanel";
import { Composer } from "./components/Composer";
import "./App.css";

export default function App() {
  const {
    sessions,
    activeId,
    activeLog,
    approvals,
    activeApprovals,
    inputRequests,
    activeInputRequests,
    workspace,
    setWorkspace,
    setActive,
    startSession,
    sendInput,
    approve,
    answerInput,
    cancelInput,
    cancelSession,
    killSession,
    error,
    backendMissing,
    evtCount,
  } = useMuseSessions();

  const active = sessions.find((s) => s.session_id === activeId) ?? null;

  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of approvals) counts[a.session_id] = (counts[a.session_id] ?? 0) + 1;
    for (const r of inputRequests) counts[r.session_id] = (counts[r.session_id] ?? 0) + 1;
    return counts;
  }, [approvals, inputRequests]);

  // US-33: sidecar startup failures surface explicitly (message + expected
  // paths + retry/re-pick actions), never as a blank screen.
  const sidecarKind = classifySidecarError(error);
  const sidecarPanel = sidecarKind !== null && error !== null && (
    <SidecarErrorPanel
      kind={sidecarKind}
      message={error}
      triedPaths={extractTriedPaths(error)}
      onRetry={() => void startSession()}
      onPickWorkspace={setWorkspace}
    />
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>muse-desktop</h1>
        <span className="muted build-id">{BUILD_ID}</span>
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
        {sidecarKind !== null
          ? (active !== null && sidecarPanel)
          : (error && <div className="error-banner">{error}</div>)}
        {active === null ? (
          <EmptySessionScreen
            hasWorkspace={workspace !== null}
            onNewSession={startSession}
            sidecarError={sidecarPanel}
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
              <span className="muted" title="backend events received (temporary)">
                ev:{evtCount}
              </span>
            </header>
            <ApprovalPanel approvals={activeApprovals} onDecision={approve} />
            <InputPanel
              requests={activeInputRequests}
              onAnswer={(sid, iid, answers) => void answerInput(sid, iid, answers)}
              onSkip={(sid, iid) => void cancelInput(sid, iid)}
            />
            <StreamView entries={activeLog} sessionId={active.session_id} />
            <Composer
              disabled={workspace === null || backendMissing}
              running={active.running}
              workspace={workspace}
              onSend={(text) => void sendInput(active.session_id, text)}
              onCancel={() => void cancelSession(active.session_id)}
            />
          </div>
        )}
      </main>
    </div>
  );
}
