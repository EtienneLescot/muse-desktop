import { useEffect, useMemo, useRef, useState } from "react";
import { classifySidecarError, extractTriedPaths } from "./lib/sidecarError";
import { THEME_KEY, nextTheme, resolveTheme, type Theme } from "./lib/theme";
import { cycleThreadId, selectActiveThreads } from "./lib/threads";
import { SidecarErrorPanel } from "./components/SidecarErrorPanel";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { SettingsPanel } from "./components/SettingsPanel";
import { EmptySessionScreen } from "./components/EmptySessionScreen";
import { SessionSidebar } from "./components/SessionSidebar";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { StreamView } from "./components/StreamView";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { InputPanel } from "./components/InputPanel";
import { Composer } from "./components/Composer";
import { CompactBar } from "./components/CompactBar";
import { OrchestrationPanel } from "./components/OrchestrationPanel";
import { SchedulesPanel } from "./components/SchedulesPanel";
import { ReviewQueuePanel } from "./components/ReviewQueuePanel";
import { ArtifactsPane } from "./components/ArtifactsPane";
import { ConnectorPanel } from "./components/ConnectorPanel";
import { SkillPanel } from "./components/SkillPanel";
import { SharePanel } from "./components/SharePanel";
import { ChannelPanel } from "./components/ChannelPanel";
import { ImportPanel } from "./components/ImportPanel";
import type { ShareBundle } from "./lib/sharing";
// US-32: polite live-region announcements for stream/approval/input changes.
import {
  approvalAnnouncement,
  inputAnnouncement,
  streamStatusMessage,
} from "./lib/a11y";
import { IndexPanel } from "./components/IndexPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { MemoryPanel } from "./components/MemoryPanel";
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
    sandbox,
    setSandbox,
    providerId,
    setProviderId,
    liveModels,
    modelsError,
    refreshModels,
    setSessionModel,
    checkPathScope,
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
    projects,
    threadProjects,
    projectError,
    createProject,
    deleteProject,
    updateProject,
    attachThread,
    globalSettings,
    setGlobalSettings,
    setProjectOverride,
    settingsFor,
    schedules,
    reviewQueue,
    createSchedule,
    setScheduleEnabled,
    deleteSchedule,
    runScheduleNow,
    approveReview,
    discardReview,
    shareMode,
    setShareMode,
    sessionBundles,
    shareSession,
    unshareBundle,
    channelsExperimental,
    importedSessions,
    importNotes,
    importConfigText,
    dismissImport,
    subagentInterrupt,
    subagentStop,
    subagentResume,
    subagentFollowup,
    subagentReadResult,
    subagentDrilldown,
    connectors,
    connectorTools,
    remoteNotice,
    installConnectorById,
    uninstallConnectorById,
    setConnectorEnabledById,
    addRemoteConnector,
    skills,
    setSkillEnabledByName,
    traceSkillSuggestions,
    invokeSkill,
    summaries,
    compactSession,
    usageBySession,
    serverCompact,
    newFromSummary,
    prefill,
    clearPrefill,
    artifacts,
    restoreArtifact,
    commentArtifact,
    index,
    browserAnnotations,
    addBrowserAnnotation,
    removeBrowserAnnotation,
    browserPermissions,
    setBrowserAppPermission,
    memories,
    scanNudge,
    addMemoryEntry,
    removeMemoryEntry,
    ackScanNudge,
    error,
    backendMissing,
    evtCount,
  } = useMuseSessions();

  // US-20: one `@mem/…` token the panel asked the composer to insert.
  const [memoryInsert, setMemoryInsert] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // US-7/US-8: agent ids seen as `subagent` entries in the active thread
  // drive the worktree plan panel (null panel until the first child).
  const orchestrationAgents = useMemo(() => {
    const seen: string[] = [];
    for (const e of activeLog) {
      if (e.role === "subagent" && typeof e.agentId === "string" && !seen.includes(e.agentId)) {
        seen.push(e.agentId);
      }
    }
    return seen;
  }, [activeLog]);

  // US-32: one polite live region announces stream running/stopped
  // transitions plus approval/input arrivals (not every render).
  const [liveMessage, setLiveMessage] = useState("");
  const prevLive = useRef<{ running: boolean | null; approvals: number; inputs: number }>({
    running: null,
    approvals: 0,
    inputs: 0,
  });
  const liveRunning = active?.running ?? false;
  useEffect(() => {
    const prev = prevLive.current;
    let msg = "";
    if (
      prev.running !== null &&
      prev.running !== liveRunning &&
      activeApprovals.length === prev.approvals &&
      activeInputRequests.length === prev.inputs
    ) {
      msg = streamStatusMessage(liveRunning);
    } else if (activeApprovals.length > prev.approvals) {
      const last = activeApprovals[activeApprovals.length - 1];
      msg = approvalAnnouncement(activeApprovals.length - prev.approvals, last?.toolName);
    } else if (activeInputRequests.length > prev.inputs) {
      const last = activeInputRequests[activeInputRequests.length - 1];
      msg = inputAnnouncement(activeInputRequests.length - prev.inputs, last?.tool_name);
    } else if (prev.running !== null && prev.running !== liveRunning) {
      msg = streamStatusMessage(liveRunning);
    }
    prevLive.current = {
      running: liveRunning,
      approvals: activeApprovals.length,
      inputs: activeInputRequests.length,
    };
    if (msg !== "") setLiveMessage(msg);
  }, [liveRunning, activeApprovals, activeInputRequests]);

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
      <a className="skip-link" href="#composer">
        Skip to composer
      </a>
      <div className="sr-only" aria-live="polite" role="status">
        {liveMessage}
      </div>
      <aside className="sidebar" aria-label="Sidebar">
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
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            pendingCounts={pendingCounts}
            compactedIds={Object.keys(summaries)}
            onSelect={setActive}
            onNew={() => {
              // No default folder yet: show the empty screen, where the
              // folder is picked per thread at creation time.
              if (workspace === null) setActive(null);
              else void startSession();
            }}
            onCancel={cancelSession}
            onKill={killSession}
            onArchive={archiveSession}
            onRestore={restoreSession}
            canStart
            projects={projects}
            threadProjects={threadProjects}
          />
          <div className="section-label">Projets</div>
          <div className="side-section">
            <ProjectsPanel
              projects={projects}
              threadProjects={threadProjects}
              projectError={projectError}
              activeSessionId={activeId}
              globalSettings={globalSettings}
              onCreate={(name, instructions) => createProject(name, instructions)}
              onDelete={deleteProject}
              onUpdate={updateProject}
              onAttach={attachThread}
              onSetGlobal={setGlobalSettings}
              onSetOverride={setProjectOverride}
              settingsFor={settingsFor}
              hideGlobalSettings
            />
          </div>
          <div className="section-label">Automatisations</div>
          <div className="side-section">
            <SchedulesPanel
              schedules={schedules}
              sessions={sessions}
              activeId={activeId}
              onCreate={(input) => {
                createSchedule(input);
              }}
              onToggle={(id, enabled) => setScheduleEnabled(id, enabled)}
              onDelete={(id) => deleteSchedule(id)}
              onRunNow={(id) => runScheduleNow(id)}
            />
          </div>
          <div className="section-label">Intégrations</div>
          <div className="side-section">
            <ConnectorPanel
              installed={connectors}
              toolNames={connectorTools.map((t) => t.name)}
              remoteNotice={remoteNotice}
              onInstall={(dirId) => installConnectorById(dirId)}
              onUninstall={(id) => uninstallConnectorById(id)}
              onToggle={(id, enabled) => setConnectorEnabledById(id, enabled)}
              onAddRemote={(name, url) => addRemoteConnector(name, url)}
            />
            <SkillPanel
              skills={skills}
              onToggle={(name, enabled) => setSkillEnabledByName(name, enabled)}
              onInvoke={(name) => {
                if (activeId !== null) invokeSkill(activeId, name, "");
              }}
              onTraceSuggest={(text) =>
                activeId !== null ? traceSkillSuggestions(activeId, text) : []
              }
            />
          </div>
          <div className="section-label">Bibliothèque</div>
          <div className="side-section">
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
            <ImportPanel
              imported={importedSessions}
              notes={importNotes}
              onImportText={(source, content) => importConfigText(source, content)}
              onDismiss={dismissImport}
            />
          </div>
          {settingsOpen && (
            <SettingsPanel
              workspace={workspace}
              onPickWorkspace={setWorkspace}
              sandbox={sandbox}
              onSandboxChange={setSandbox}
              providerId={providerId}
              onProviderChange={setProviderId}
              liveModels={liveModels}
              modelsError={modelsError}
              activeSessionId={activeId}
              onRefreshModels={() => void refreshModels(activeId ?? undefined)}
              onSelectModel={(modelId) => {
                if (activeId !== null) void setSessionModel(activeId, modelId);
              }}
              checkPathScope={checkPathScope}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
        <div className="sidebar-footer">
          <button
            type="button"
            className="account"
            title={workspace ?? "No workspace selected"}
            aria-label={
              workspace === null
                ? "Profile: no default folder, activate to open settings"
                : `Profile: default folder ${workspace}, activate to open settings`
            }
            onClick={() => setSettingsOpen(true)}
          >
            <span className="avatar" aria-hidden="true">
              {(workspaceName?.slice(0, 1).toUpperCase() ?? "M")}
            </span>
            <span className="account-text">
              <span className="account-name">{workspaceName ?? "No workspace"}</span>
              <small>Local profile</small>
            </span>
          </button>
          <button
            type="button"
            className="gear"
            aria-expanded={settingsOpen}
            aria-label={settingsOpen ? "Close settings" : "Open settings"}
            title="Settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
          </button>
        </div>
      </aside>
      <main className="conversation" aria-label="Conversation">
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
            workspace={workspace}
            onPickWorkspace={setWorkspace}
            onNewSession={startSession}
            sidecarError={sidecarPanel}
          />
        ) : (
          <div className="session-view">
            <div className="session-center">
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
            <ReviewQueuePanel
              items={reviewQueue}
              sessionTitle={(sid) =>
                sessions.find((s) => s.session_id === sid)?.title ??
                sid.slice(0, 8)
              }
              onApprove={(id) => void approveReview(id)}
              onDiscard={(id) => discardReview(id)}
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
              usage={usageBySession[active.session_id] ?? null}
              onServerCompact={() => void serverCompact(active.session_id)}
            />
            <OrchestrationPanel agents={orchestrationAgents} />
            <SharePanel
              sessionId={active.session_id}
              mode={shareMode}
              bundles={sessionBundles(active.session_id)}
              onModeChange={setShareMode}
              onShare={(format) => void shareSession(active.session_id, format)}
              onUnshare={unshareBundle}
              onCopy={(b: ShareBundle) => {
                try {
                  void navigator.clipboard?.writeText(b.bundleId);
                } catch {
                  // clipboard unavailable: the id stays visible for manual copy
                }
              }}
              onDownload={(b: ShareBundle) => {
                const ext = b.format === "json" ? "json" : "md";
                const blob = new Blob([b.body], {
                  type: b.format === "json" ? "application/json" : "text/markdown",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${b.bundleId}.${ext}`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }}
            />
            <ChannelPanel experimental={channelsExperimental} />
            <BrowserPanel
              annotations={browserAnnotations}
              permissions={browserPermissions}
              onAddAnnotation={addBrowserAnnotation}
              onRemoveAnnotation={removeBrowserAnnotation}
              onSetPermission={setBrowserAppPermission}
            />
            <MemoryPanel
              memories={memories}
              now={Date.now()}
              scanNudge={scanNudge}
              onAdd={(text, source) => addMemoryEntry(text, source)}
              onRemove={removeMemoryEntry}
              onAckScan={ackScanNudge}
              onMention={(query) => setMemoryInsert(query)}
            />
            <Composer
              disabled={workspace === null || backendMissing}
              running={active.running}
              workspace={workspace}
              onSend={(text) => void sendInput(active.session_id, text)}
              onCancel={() => void cancelSession(active.session_id)}
              prefill={prefill}
              onPrefillConsumed={clearPrefill}
              memories={memories}
              memoryInsert={memoryInsert}
              onMemoryInsertConsumed={() => setMemoryInsert(null)}
            />
            </div>
            <ArtifactsPane
              sessionId={active.session_id}
              log={activeLog}
              artifacts={artifacts[active.session_id] ?? []}
              onRestore={restoreArtifact}
              onComment={commentArtifact}
            />
          </div>
        )}
      </main>
    </div>
  );
}
