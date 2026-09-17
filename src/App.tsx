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
import { ReviewPanel } from "./components/ReviewPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import type { ShareBundle } from "./lib/sharing";
import { formatReviewComment, type ReviewAnchor } from "./lib/reviewComments";
// US-32: polite live-region announcements for stream/approval/input changes.
import {
  approvalAnnouncement,
  inputAnnouncement,
  streamStatusMessage,
} from "./lib/a11y";
import { IndexPanel } from "./components/IndexPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { Icon } from "./components/Icon";
import { WindowControls, dragWindow } from "./components/WindowControls";
import "./App.css";
import "./Desktop.css";

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
    authorizationMode,
    setAuthorizationMode,
    providerId,
    setProviderId,
    liveModels,
    modelsError,
    refreshModels,
    setSessionModel,
    checkPathScope,
    setActive,
    startSession,
    reconnectSession,
    reconnectingId,
    connectedIds,
    sendInput,
    pendingSends,
    retrySend,
    discardSend,
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
    renameSession,
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
    gitReview,
    refreshGitStatus,
    loadGitDiff,
    stageGitFiles,
    restoreGitFiles,
    commitGit,
    pushGit,
    createGitPr,
    terminalForSession,
    openTerminal,
    readTerminal,
    writeTerminal,
    resizeTerminal,
    closeTerminal,
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
  } = useMuseSessions();

  // US-20: one `@mem/…` token the panel asked the composer to insert.
  const [memoryInsert, setMemoryInsert] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<
    "task" | "projects" | "automations" | "extensions" | "library" | "archives"
  >("task");
  const [collapsed, setCollapsed] = useState(false);
  const [workPanel, setWorkPanel] = useState<
    "artifacts" | "browser" | "memory" | "tools" | "review" | "terminal" | null
  >(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchWasOpen = useRef(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsWasOpen = useRef(false);
  const searchResults = sessions.filter((session) =>
    (session.title + " " + session.workspace)
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  useEffect(() => setSearchIndex(0), [search, searchOpen]);
  const searchDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (searchOpen)
      searchDialog.current
        ?.querySelector(".search-highlight")
        ?.scrollIntoView({ block: "nearest" });
  }, [searchIndex, searchOpen]);
  useEffect(() => {
    if (searchOpen) {
      searchWasOpen.current = true;
      searchDialog.current?.showModal();
    } else {
      searchDialog.current?.close();
      if (searchWasOpen.current) {
        searchWasOpen.current = false;
        searchTrigger.current?.focus();
      }
    }
  }, [searchOpen]);
  useEffect(() => {
    if (settingsOpen) {
      settingsWasOpen.current = true;
    } else if (settingsWasOpen.current) {
      settingsWasOpen.current = false;
      settingsTrigger.current?.focus();
    }
  }, [settingsOpen]);
  const openPage = (next: typeof page) => {
    setSettingsOpen(false);
    setPage(next);
  };
  const newTask = () => {
    openPage("task");
    setActive(null);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === ",") {
          event.preventDefault();
          setSettingsOpen((value) => !value);
        }
        if (event.key.toLowerCase() === "b") {
          event.preventDefault();
          setCollapsed((value) => !value);
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setPage("task");
        setSettingsOpen(false);
        setActive(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActive]);

  useEffect(() => {
    document.body.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // best-effort (private mode, quota): the class toggle above still applies
    }
  }, [theme]);

  const active = sessions.find((s) => s.session_id === activeId) ?? null;
  // M0-03: retryable sends of the viewed conversation only — a retry never
  // routes by this view, it goes to the entry's own sessionId.
  const activePendingSends =
    active !== null
      ? pendingSends.filter((entry) => entry.sessionId === active.session_id)
      : [];

  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of approvals)
      counts[a.session_id] = (counts[a.session_id] ?? 0) + 1;
    for (const r of inputRequests)
      counts[r.session_id] = (counts[r.session_id] ?? 0) + 1;
    return counts;
  }, [approvals, inputRequests]);

  const workspaceName = useMemo(() => {
    if (workspace === null) return null;
    const parts = workspace.split(/[\\/]/).filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? workspace;
  }, [workspace]);

  // US-7/US-8: agent ids seen as `subagent` entries in the active thread
  // drive the worktree plan panel (null panel until the first child).
  const orchestrationAgents = useMemo(() => {
    const seen: string[] = [];
    for (const e of activeLog) {
      if (
        e.role === "subagent" &&
        typeof e.agentId === "string" &&
        !seen.includes(e.agentId)
      ) {
        seen.push(e.agentId);
      }
    }
    return seen;
  }, [activeLog]);

  // US-32: one polite live region announces stream running/stopped
  // transitions plus approval/input arrivals (not every render).
  const [liveMessage, setLiveMessage] = useState("");
  const prevLive = useRef<{
    running: boolean | null;
    approvals: number;
    inputs: number;
  }>({
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
      msg = approvalAnnouncement(
        activeApprovals.length - prev.approvals,
        last?.toolName,
      );
    } else if (activeInputRequests.length > prev.inputs) {
      const last = activeInputRequests[activeInputRequests.length - 1];
      msg = inputAnnouncement(
        activeInputRequests.length - prev.inputs,
        last?.tool_name,
      );
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
        const next = cycleThreadId(
          activeThreadIds,
          activeId,
          e.shiftKey ? -1 : 1,
        );
        if (next !== null) {
          setActive(next);
          setPage("task");
          setSettingsOpen(false);
        }
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
    <div className={`app desktop-app ${collapsed ? "nav-collapsed" : ""}`}>
      <a className="skip-link" href="#composer">
        Skip to message input
      </a>
      <div className="sr-only" aria-live="polite" role="status">
        {liveMessage}
      </div>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="brand" onMouseDown={dragWindow}>
          <span className="muse-logo">
            <img src="muse-logo.png" alt="" />
          </span>
          <span className="brand-text">Muse-Desktop</span>
          <button
            className="icon"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={
              collapsed ? "Expand sidebar" : "Collapse sidebar"
            }
          >
            <Icon name="panel" />
          </button>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button
            onClick={newTask}
            aria-label="New conversation"
            title="New conversation · Ctrl+N"
          >
            <Icon name="plus" />
            <span>New conversation</span>
          </button>
          <button
            ref={searchTrigger}
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            title="Search · Ctrl+K"
          >
            <Icon name="search" />
            <span>Search</span>
          </button>
          <button
            aria-label="Automations"
            aria-current={page === "automations" ? "page" : undefined}
            onClick={() => openPage("automations")}
          >
            <Icon name="clock" />
            <span>Automations</span>
          </button>
          <button
            aria-label="Extensions"
            aria-current={page === "extensions" ? "page" : undefined}
            onClick={() => openPage("extensions")}
          >
            <Icon name="grid" />
            <span>Extensions</span>
          </button>
          <button
            aria-label="Library"
            aria-current={page === "library" ? "page" : undefined}
            onClick={() => openPage("library")}
          >
            <Icon name="folder" />
            <span>Library</span>
          </button>
        </nav>
        <div className="sidebar-scroll">
          <SessionSidebar
            sessions={sessions}
            showArchived={false}
            activeId={page === "task" && !settingsOpen ? activeId : null}
            pendingCounts={pendingCounts}
            compactedIds={Object.keys(summaries)}
            onSelect={(id) => {
              openPage("task");
              setActive(id);
            }}
            onNew={newTask}
            onCancel={cancelSession}
            onKill={killSession}
            onRename={renameSession}
            onArchive={archiveSession}
            onRestore={restoreSession}
            canStart
            projects={projects}
            threadProjects={threadProjects}
          />
          <button
            className="sidebar-manage"
            onClick={() => openPage("projects")}
          >
            <Icon name="folder" />
            Manage projects
            <Icon name="plus" />
          </button>
          <button
            className="sidebar-manage"
            onClick={() => openPage("archives")}
          >
            <Icon name="archive" />
            Archived conversations
          </button>
        </div>
        <div className="sidebar-footer">
          <button
            type="button"
            ref={settingsTrigger}
            className="account"
            aria-label="Profile — Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="avatar" aria-hidden="true">
              M
            </span>
            <span className="account-name">My profile</span>
          </button>
        </div>
      </aside>
      <main className="conversation" aria-label="Conversation">
        <header className="desktop-topbar" onMouseDown={dragWindow}>
          <div className="breadcrumb">
            <Icon name="folder" />
            <span>
              {(active && page === "task"
                ? active.workspace.split(/[\\/]/).pop()
                : workspaceName) || "Muse-Desktop"}
            </span>
            <span className="separator">/</span>
            <span>
              {settingsOpen
                ? "Settings"
                : page === "task"
                  ? active?.title || "New conversation"
                  : {
                      projects: "Projects",
                      automations: "Automations",
                      extensions: "Extensions",
                      library: "Library",
                      archives: "Archives",
                    }[page]}
            </span>
          </div>
          <div className="top-actions">
            {active && page === "task" && !settingsOpen && !backendMissing && !connectedIds.includes(active.session_id) && (
              <button className="workspace-button"
                disabled={reconnectingId !== null || active.running}
                onClick={() => void reconnectSession(active.session_id)}
                title="Reconnect this saved conversation to its workspace engine">
                {reconnectingId === active.session_id ? "Reconnecting…" : "Reconnect"}
              </button>
            )}
            <span className="pill">
              <span className="dot" />
              {backendMissing ? "Web preview" : "Local"}
            </span>
            <button
              className="icon"
              onClick={() => setTheme(nextTheme(theme))}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            {active && page === "task" && !settingsOpen && (
              <button
                className="icon"
                onClick={() => setWorkPanel(workPanel ? null : "artifacts")}
                aria-label={
                  workPanel
                    ? "Hide work panel"
                    : "Show work panel"
                }
                aria-expanded={workPanel !== null}
              >
                <Icon name="panel" />
              </button>
            )}
            <WindowControls />
          </div>
        </header>
        {settingsOpen ? (
          <section className="destination-page">
            <div className="eyebrow">MAKE IT YOURS</div>
            <h1>Settings</h1>{" "}
            <SettingsPanel
              workspace={workspace}
              onPickWorkspace={setWorkspace}
              sandbox={sandbox}
              onSandboxChange={setSandbox}
              authorizationMode={authorizationMode}
              onAuthorizationModeChange={setAuthorizationMode}
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
          </section>
        ) : page !== "task" ? (
          <section className="destination-page">
            <div className="eyebrow">YOUR WORKSPACE</div>
            <h1>
              {
                {
                  projects: "Projects",
                  automations: "Automations",
                  extensions: "Extensions",
                  library: "Library",
                  archives: "Archives",
                }[page]
              }
            </h1>
            <p className="page-description">
              {
                {
                  projects: "Organize your projects and instructions.",
                  automations:
                    "Schedule requests to review before they run.",
                  extensions: "Your tools and skills, all in one place.",
                  library:
                    "Find your files and import your history.",
                  archives:
                    "Archived conversations remain available here.",
                }[page]
              }
            </p>
            {page === "projects" && (
              <>
                {" "}
                <ProjectsPanel
                  projects={projects}
                  threadProjects={threadProjects}
                  projectError={projectError}
                  activeSessionId={activeId}
                  globalSettings={globalSettings}
                  onCreate={(name, instructions) =>
                    createProject(name, instructions)
                  }
                  onDelete={deleteProject}
                  onUpdate={updateProject}
                  onAttach={attachThread}
                  onSetGlobal={setGlobalSettings}
                  onSetOverride={setProjectOverride}
                  settingsFor={settingsFor}
                  hideGlobalSettings
                />
              </>
            )}
            {page === "automations" && (
              <>
                {" "}
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
              </>
            )}
            {page === "extensions" && (
              <div className="destination-grid">
                {" "}
                <ConnectorPanel
                  installed={connectors}
                  toolNames={connectorTools.map((t) => t.name)}
                  remoteNotice={remoteNotice}
                  onInstall={(dirId) => installConnectorById(dirId)}
                  onUninstall={(id) => uninstallConnectorById(id)}
                  onToggle={(id, enabled) =>
                    setConnectorEnabledById(id, enabled)
                  }
                  onAddRemote={(name, url) => addRemoteConnector(name, url)}
                />{" "}
                <SkillPanel
                  skills={skills}
                  onToggle={(name, enabled) =>
                    setSkillEnabledByName(name, enabled)
                  }
                  onInvoke={(name) => {
                    if (activeId !== null) invokeSkill(activeId, name, "");
                  }}
                  onTraceSuggest={(text) =>
                    activeId !== null
                      ? traceSkillSuggestions(activeId, text)
                      : []
                  }
                />
              </div>
            )}
            {page === "library" && (
              <div className="destination-grid">
                {" "}
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
                />{" "}
                <ImportPanel
                  imported={importedSessions}
                  notes={importNotes}
                  onImportText={(source, content) =>
                    importConfigText(source, content)
                  }
                  onDismiss={dismissImport}
                />
              </div>
            )}
            {page === "archives" && (
              <div className="archive-list">
                {sessions
                  .filter((session) => session.archived)
                  .map((session) => (
                    <div className="archive-row" key={session.session_id}>
                      <button
                        onClick={() => {
                          openPage("task");
                          setActive(session.session_id);
                        }}
                      >
                        {session.title || session.session_id.slice(0, 8)}
                      </button>
                      <button
                        onClick={() => restoreSession(session.session_id)}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                {!sessions.some((session) => session.archived) && (
                  <p className="muted">No archived conversations.</p>
                )}
              </div>
            )}
          </section>
        ) : (
          <>
            {backendMissing && (
              <div className="preview-notice">
                Web preview · Open the desktop app to work with
                Muse. Your local history is still available.
              </div>
            )}
            {sidecarKind !== null
              ? active !== null && sidecarPanel
              : error && <div className="error-banner">{error}</div>}
            {active === null ? (
              <EmptySessionScreen
                workspace={workspace}
                onPickWorkspace={setWorkspace}
                onStart={async (draft) => {
                  const id = await startSession();
                  if (id === null || draft.trim() === "") return id !== null;
                  // M0-03: honest result — when the first send fails the
                  // welcome draft must not be reported as sent; the text
                  // stays recoverable via the retryable pending-send notice.
                  const res = await sendInput(id, draft);
                  return res.ok;
                }}
                backendMissing={backendMissing}
                sidecarError={sidecarPanel}
                authorizationMode={authorizationMode}
                onAuthorizationModeChange={setAuthorizationMode}
              />
            ) : (
              <div className="session-view">
                <div className="session-center">
                  <header className="task-heading">
                    <div className="eyebrow">
                      {active.workspace.split(/[\\/]/).pop()} / CONVERSATION
                    </div>
                    <h1>{active.title || "New conversation"}</h1>
                    <div className="task-metadata">
                      <span className="dot" data-running={active.running} />
                      {active.running ? "Working" : "Ready"}
                      <span>·</span>
                      <span title={active.workspace}>{active.workspace}</span>
                    </div>
                  </header>
                  {active.archived && (
                    <div className="preview-notice">
                      Archived conversation{" "}
                      <button onClick={() => restoreSession(active.session_id)}>
                        Restore to continue
                      </button>
                    </div>
                  )}
                  <ApprovalPanel
                    approvals={activeApprovals}
                    authorizationMode={authorizationMode}
                    onAuthorizationModeChange={setAuthorizationMode}
                    rules={allowlist}
                    onDecision={approve}
                    onRemember={(a, choiceId) =>
                      void rememberApproval(a, choiceId)
                    }
                    decisionFor={allowDecisionFor}
                    onRevoke={revokeAllowRule}
                    onRuleDecision={setAllowRuleDecision}
                  />
                  <InputPanel
                    requests={activeInputRequests}
                    onAnswer={(sid, iid, answers) =>
                      void answerInput(sid, iid, answers)
                    }
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
                      onStop: (agentId) =>
                        void subagentStop(active.session_id, agentId),
                      onResume: (agentId) =>
                        void subagentResume(active.session_id, agentId),
                      onFollowup: (agentId, task) =>
                        void subagentFollowup(active.session_id, agentId, task),
                      onReadResult: (agentId) =>
                        subagentReadResult(active.session_id, agentId),
                      onDrilldown: (entry) =>
                        subagentDrilldown(
                          active.session_id,
                          entry.childSessionId,
                        ),
                    }}
                  />

                  {activePendingSends.map((entry) => (
                    <div
                      className="pending-send"
                      role="status"
                      key={entry.clientMessageId}
                    >
                      <span
                        className="pending-send-text"
                        title={entry.text}
                      >
                        Unsent message:{" "}
                        {entry.text.length > 80
                          ? `${entry.text.slice(0, 80)}…`
                          : entry.text}
                      </span>
                      {entry.error !== null && (
                        <span className="pending-send-error">{entry.error}</span>
                      )}
                      <button
                        onClick={() => void retrySend(entry.clientMessageId)}
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => discardSend(entry.clientMessageId)}
                      >
                        Discard
                      </button>
                    </div>
                  ))}
                  <Composer
                    key={active.session_id}
                    draftKey={active.session_id}
                    sessionId={active.session_id}
                    disabled={backendMissing || active.archived === true || !connectedIds.includes(active.session_id)}
                    modelControl={
                      <>
                        <button
                          onClick={() => setSettingsOpen(true)}
                          aria-label="Model settings"
                        >
                          {liveModels?.find((model) => model.isActive)
                            ?.displayLabel || "Model"}
                        </button>
                        <span>Local</span>
                      </>
                    }
                    running={active.running}
                    workspace={active.workspace}
                    onSend={(text) => sendInput(active.session_id, text)}
                    onCancel={() => void cancelSession(active.session_id)}
                    prefill={prefill}
                    onPrefillConsumed={clearPrefill}
                    memories={memories}
                    memoryInsert={memoryInsert}
                    onMemoryInsertConsumed={() => setMemoryInsert(null)}
                    authorizationMode={authorizationMode}
                    onAuthorizationModeChange={setAuthorizationMode}
                  />
                </div>
                {workPanel && (
                  <aside className="work-panel">
                    <nav className="work-tabs" aria-label="Work panel">
                      {(
                        [
                          ["artifacts", "Content"],
                          ["review", "Review"],
                          ["terminal", "Terminal"],
                          ["browser", "Browser"],
                          ["memory", "Memory"],
                          ["tools", "Activity"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={workPanel === id}
                          onClick={() => setWorkPanel(id)}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        className="icon"
                        aria-label="Close panel"
                        onClick={() => setWorkPanel(null)}
                      >
                        <Icon name="close" />
                      </button>
                    </nav>
                    <div className="work-panel-body">
                      {workPanel === "artifacts" && (
                        <>
                          {" "}
                          <ArtifactsPane
                            sessionId={active.session_id}
                            log={activeLog}
                            artifacts={artifacts[active.session_id] ?? []}
                            onRestore={restoreArtifact}
                            onComment={commentArtifact}
                          />
                        </>
                      )}
                      {workPanel === "review" && (
                        <ReviewPanel
                          sessionId={active.session_id}
                          review={gitReview(active.session_id)}
                          onRefreshStatus={refreshGitStatus}
                          onLoadDiff={loadGitDiff}
                          onStageFiles={stageGitFiles}
                          onRestoreFiles={restoreGitFiles}
                          onCommit={commitGit}
                          onPush={pushGit}
                          onCreatePr={createGitPr}
                          onSendComment={async (anchor: ReviewAnchor, body: string) => {
                            const result = await sendInput(
                              active.session_id,
                              formatReviewComment(anchor, body),
                            );
                            return result.ok;
                          }}
                        />
                      )}
                      {workPanel === "terminal" && (
                        <TerminalPanel
                          sessionId={active.session_id}
                          terminal={terminalForSession(active.session_id)}
                          onOpen={openTerminal}
                          onRead={readTerminal}
                          onWrite={writeTerminal}
                          onResize={resizeTerminal}
                          onClose={closeTerminal}
                        />
                      )}
                      {workPanel === "browser" && (
                        <>
                          {" "}
                          <BrowserPanel
                            annotations={browserAnnotations}
                            permissions={browserPermissions}
                            onAddAnnotation={addBrowserAnnotation}
                            onRemoveAnnotation={removeBrowserAnnotation}
                            onSetPermission={setBrowserAppPermission}
                          />
                        </>
                      )}
                      {workPanel === "memory" && (
                        <>
                          {" "}
                          <MemoryPanel
                            memories={memories}
                            now={Date.now()}
                            scanNudge={scanNudge}
                            onAdd={(text, source) =>
                              addMemoryEntry(text, source)
                            }
                            onRemove={removeMemoryEntry}
                            onAckScan={ackScanNudge}
                            onMention={(query) => setMemoryInsert(query)}
                          />
                        </>
                      )}
                      {workPanel === "tools" && (
                        <>
                          {" "}
                          <CompactBar
                            entryCount={activeLog.length}
                            summary={summaries[active.session_id] ?? null}
                            onCompact={() => compactSession(active.session_id)}
                            onNewFromSummary={() =>
                              void newFromSummary(active.session_id)
                            }
                            usage={usageBySession[active.session_id] ?? null}
                            onServerCompact={() =>
                              void serverCompact(active.session_id)
                            }
                          />{" "}
                          <OrchestrationPanel agents={orchestrationAgents} />{" "}
                          <SharePanel
                            sessionId={active.session_id}
                            mode={shareMode}
                            bundles={sessionBundles(active.session_id)}
                            onModeChange={setShareMode}
                            onShare={(format) =>
                              void shareSession(active.session_id, format)
                            }
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
                                type:
                                  b.format === "json"
                                    ? "application/json"
                                    : "text/markdown",
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
                          />{" "}
                          {channelsExperimental && (
                            <ChannelPanel experimental={channelsExperimental} />
                          )}
                        </>
                      )}
                    </div>
                  </aside>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <footer className="desktop-status">
        <span className="dot" />
        {backendMissing ? "Web preview" : "Local execution"}
        <span className="status-workspace">
          {workspaceName || "No folder selected"}
        </span>
        <span className="status-brand">Muse-Desktop</span>
      </footer>
      <dialog
        ref={searchDialog}
        className="task-search"
        aria-label="Search conversations"
        onCancel={() => setSearchOpen(false)}
        onClose={() => setSearchOpen(false)}
      >
        <header>
          <h2>Search conversations</h2>
          <button
            aria-label="Close search"
            onClick={() => setSearchOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <input
          autoFocus
          aria-label="Search conversations"
          placeholder="Conversation title or folder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(event) => {
            if (!searchResults.length || event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSearchIndex(
                (i) =>
                  (i +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    searchResults.length) %
                  searchResults.length,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              setActive(
                searchResults[Math.min(searchIndex, searchResults.length - 1)]
                  .session_id,
              );
              openPage("task");
              setSearchOpen(false);
            }
          }}
        />
        <div className="search-results">
          {searchResults.map((session, index) => (
            <button
              key={session.session_id}
              className={index === searchIndex ? "search-highlight" : undefined}
              onClick={() => {
                setActive(session.session_id);
                openPage("task");
                setSearchOpen(false);
              }}
            >
              <Icon name="code" />
              {session.title || session.session_id.slice(0, 8)}
              <small>{session.archived ? "Archived" : ""}</small>
            </button>
          ))}
          {!sessions.some((session) =>
            (session.title + " " + session.workspace)
              .toLowerCase()
              .includes(search.toLowerCase()),
          ) && <p className="muted">No conversations found.</p>}
        </div>
      </dialog>
    </div>
  );
}
