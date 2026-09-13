import { useEffect, useMemo, useRef, useState } from "react";
import { classifySidecarError, extractTriedPaths } from "./lib/sidecarError";
import { THEME_KEY, nextTheme, resolveTheme, type Theme } from "./lib/theme";
import { cycleThreadId, selectActiveThreads } from "./lib/threads";
import { SidecarErrorPanel } from "./components/SidecarErrorPanel";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { EmptySessionScreen } from "./components/EmptySessionScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import { StreamView } from "./components/StreamView";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { InputPanel } from "./components/InputPanel";
import { Composer } from "./components/Composer";
import { CompactBar } from "./components/CompactBar";
import { IndexPanel } from "./components/IndexPanel";
import "./App.css";

function initialTheme(): Theme {
  let stored: string | null = null;
  let prefersDark = false;
  try {
    stored = localStorage.getItem(THEME_KEY);
    prefersDark =
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    // private mode / non-DOM: fall back to light
  }
  return resolveTheme(stored, prefersDark);
}

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
    allowlist,
    allowDecisionFor,
    rememberApproval,
    revokeAllowRule,
    setAllowRuleDecision,
    answerInput,
    cancelInput,
    cancelSession,
    killSession,
    archiveSession,
    restoreSession,
    subagentInterrupt,
    subagentStop,
    subagentResume,
    subagentFollowup,
    subagentReadResult,
    subagentDrilldown,
    summaries,
    compactSession,
    newFromSummary,
    prefill,
    clearPrefill,
    index,
    error,
    backendMissing,
    evtCount,
  } = useMuseSessions();

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const pickButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.body.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // best-effort (private mode, quota): the class toggle above still applies
    }
  }, [theme]);

  const active = sessions.find((s) => s.session_id === activeId) ?? null;

  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of approvals) counts[a.session_id] = (counts[a.session_id] ?? 0) + 1;
    for (const r of inputRequests) counts[r.session_id] = (counts[r.session_id] ?? 0) + 1;
    return counts;
  }, [approvals, inputRequests]);

  const workspaceName = useMemo(() => {
    if (workspace === null) return null;
    const parts = workspace.split("/").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? workspace;
  }, [workspace]);

  // US-5: global ctrl-tab / ctrl-shift-tab cycles active threads in sidebar
  // order, wherever focus sits (sidebar list, stream, composer).
  const activeThreadIds = useMemo(
    () => selectActiveThreads(sessions).map((s) => s.session_id),
    [sessions],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.ctrlKey) {
        e.preventDefault();
        const next = cycleThreadId(activeThreadIds, activeId, e.shiftKey ? -1 : 1);
        if (next !== null) setActive(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeThreadIds, activeId, setActive]);

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
        <div className="brand">
          <span className="muse-logo">
            <img src="muse-logo.png" alt="Muse logo" />
          </span>
          <span className="brand-text">
            Muse<small>DESKTOP</small>
          </span>
          <button
            type="button"
            className="icon theme-toggle"
            aria-pressed={theme === "dark"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
            onClick={() => setTheme((t) => nextTheme(t))}
          >
            {theme === "dark" ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            )}
          </button>
        </div>
        <div className="sidebar-scroll">
          <WorkspacePicker
            workspace={workspace}
            onPick={setWorkspace}
            pickButtonRef={pickButtonRef}
          />
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            pendingCounts={pendingCounts}
            compactedIds={Object.keys(summaries)}
            onSelect={setActive}
            onNew={startSession}
            onCancel={cancelSession}
            onKill={killSession}
            onArchive={archiveSession}
            onRestore={restoreSession}
            canStart={workspace !== null}
          />
          <IndexPanel
            enabled={index.enabled}
            paused={index.paused}
            fileCount={index.fileCount}
            lineCount={index.lineCount}
            builtAt={index.builtAt}
            lastSummary={index.lastSummary}
            hasSource={index.hasSource}
            query={index.query}
            results={index.results}
            onToggle={index.setIndexEnabled}
            onPause={() => index.setIndexPaused(true)}
            onResume={() => index.setIndexPaused(false)}
            onFilesPicked={(files) => void index.indexPickedFiles(files)}
            onRescan={() => void index.rescanIndexFiles()}
            onRebuild={() => void index.rebuildIndex()}
            onDelete={index.deleteIndex}
            onQueryChange={index.setIndexQuery}
          />
        </div>
        <button
          type="button"
          className="account"
          title={workspace ?? "No workspace selected — choose a folder"}
          aria-label={
            workspace === null
              ? "Profile: no workspace selected, activate to choose a folder"
              : `Profile: workspace ${workspace}, activate to change folder`
          }
          onClick={() => pickButtonRef.current?.click()}
        >
          <span className="avatar" aria-hidden="true">
            {(workspaceName?.slice(0, 1).toUpperCase() ?? "M")}
          </span>
          <span className="account-text">
            <span className="account-name">{workspaceName ?? "No workspace"}</span>
            <small>Local profile</small>
          </span>
        </button>
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
            <header className="topbar">
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
            <ApprovalPanel
              approvals={activeApprovals}
              rules={allowlist}
              onDecision={approve}
              onRemember={(a, choiceId) => void rememberApproval(a, choiceId)}
              decisionFor={allowDecisionFor}
              onRevoke={revokeAllowRule}
              onRuleDecision={setAllowRuleDecision}
            />
            <InputPanel
              requests={activeInputRequests}
              onAnswer={(sid, iid, answers) => void answerInput(sid, iid, answers)}
              onSkip={(sid, iid) => void cancelInput(sid, iid)}
            />
            <StreamView
              entries={activeLog}
              sessionId={active.session_id}
              controls={{
                onInterrupt: (agentId) =>
                  void subagentInterrupt(active.session_id, agentId),
                onStop: (agentId) => void subagentStop(active.session_id, agentId),
                onResume: (agentId) =>
                  void subagentResume(active.session_id, agentId),
                onFollowup: (agentId, task) =>
                  void subagentFollowup(active.session_id, agentId, task),
                onReadResult: (agentId) =>
                  subagentReadResult(active.session_id, agentId),
                onDrilldown: (entry) =>
                  subagentDrilldown(active.session_id, entry.childSessionId),
              }}
            />
            <CompactBar
              entryCount={activeLog.length}
              summary={summaries[active.session_id] ?? null}
              onCompact={() => compactSession(active.session_id)}
              onNewFromSummary={() => void newFromSummary(active.session_id)}
            />
            <Composer
              disabled={workspace === null || backendMissing}
              running={active.running}
              workspace={workspace}
              onSend={(text) => void sendInput(active.session_id, text)}
              onCancel={() => void cancelSession(active.session_id)}
              prefill={prefill}
              onPrefillConsumed={clearPrefill}
            />
          </div>
        )}
      </main>
    </div>
  );
}
