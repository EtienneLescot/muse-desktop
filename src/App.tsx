import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { classifySidecarError, extractTriedPaths } from "./lib/sidecarError";
import { THEME_KEY, nextTheme, resolveTheme, type Theme } from "./lib/theme";
import { cycleThreadId, selectActiveThreads } from "./lib/threads";
import { SidecarErrorPanel } from "./components/SidecarErrorPanel";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  EmptySessionScreen,
  type NewConversationEnvironment,
} from "./components/EmptySessionScreen";
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
import { FilesPanel } from "./components/FilesPanel";
import type { ShareBundle } from "./lib/sharing";
import { formatReviewComment, type ReviewAnchor } from "./lib/reviewComments";
import { diagnosticsJson, type NativeDiagnosticsSnapshot } from "./lib/diagnostics";
import { userFacingError } from "./lib/errorCopy";
import { isTauriRuntime } from "./lib/env";
import { formatHandoffContext } from "./lib/handoff";
import type { Artifact, ArtifactVersion } from "./lib/artifacts";
import {
  parseWorkspaceRootObservation,
  projectWorkspaceOptions,
} from "./lib/projects";
// US-32: polite live-region announcements for stream/approval/input changes.
import {
  approvalAnnouncement,
  inputAnnouncement,
  primaryModifier,
  streamStatusMessage,
} from "./lib/a11y";
import { IndexPanel } from "./components/IndexPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { DesktopControlPanel } from "./components/DesktopControlPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { Icon } from "./components/Icon";
import { searchConversations } from "./lib/conversationSearch";
import { reasoningEffortLabel } from "./lib/reasoning";
import { WindowControls, dragWindow } from "./components/WindowControls";
import { readStorageString, writeStorageString } from "./lib/storage.ts";
import {
  NOTIFICATION_ACTION_EVENT,
  resolveNotificationRoute,
  subscribeNotificationActions,
  type NotificationActionPayload,
} from "./lib/notifications";
import "./App.css";
import "./Desktop.css";

function initialTheme(): Theme {
  let stored: string | null = null;
  let prefersDark = false;
  try {
    stored = readStorageString(THEME_KEY);
    prefersDark =
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    // private mode / non-DOM: fall back to light
  }
  return resolveTheme(stored, prefersDark);
}

export default function App() {
  const modifier = primaryModifier();
  const {
    sessions,
    activeId,
    logs,
    activeLog,
    approvals,
    activeApprovals,
    activeStreamActivity,
    activeResumePending,
    activeRetryScheduled,
    stoppingBySession,
    activeConnectionState,
    queuedTurns,
    dismissQueuedTurn,
    inputRequests,
    activeInputRequests,
    workspace,
    setWorkspace,
    sandbox,
    setSandbox,
    restartHost,
    authorizationMode,
    setAuthorizationMode,
    providerId,
    setProviderId,
    liveModels,
    modelsError,
    refreshModels,
    setSessionModel,
    setSessionReasoningEffort,
    checkPathScope,
    createWorktree,
    createWorktreeSession,
    worktrees,
    cleanupIntents,
    removeWorktree,
    inspectWorktree,
    checkWorktreeReadiness,
    runWorktreeSetup,
    cancelWorktreeSetup,
    setActive,
    startSession,
    startSessionInWorkspace,
    forkSession,
    reconnectSession,
    reconnectingId,
    reconcileSession,
    reconcilingId,
    connectedIds,
    userShellAvailableForSession,
    evtCount,
    sendInput,
    steerInput,
    unqueueTurn,
    pendingSends,
    retrySend,
    retryFailedTurn,
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
    togglePinned,
    moveConversation,
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
    projectForSession,
    schedules,
    scheduleRuns,
    schedulerStatus,
    schedulerWakeupStatus,
    notifications,
    notificationPermission,
    notificationsMuted,
    unreadNotificationCount,
    enableNotifications,
    setNotificationsMuted,
    markNotificationRead,
    reviewQueue,
    createSchedule,
    setScheduleEnabled,
    deleteSchedule,
    runScheduleNow,
    cancelScheduleRun,
    markScheduleRunRecoveryFailed,
    markScheduleRunRead,
    setScheduleRunArchived,
    retryScheduleRunNow,
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
    readItemOutput,
    connectors,
    connectorTools,
    probeLocalMcp,
    callLocalMcp,
    registerLocalConnector,
    installMcpPackage,
    refreshLocalMcp,
    rollbackLocalMcp,
    mcpRunningIds,
    startLocalMcp,
    stopLocalMcp,
    callRegisteredLocalMcp,
    remoteConnectedIds,
    probeRemoteMcp,
    callRemoteMcp,
    disconnectRemoteMcp,
    forgetRemoteMcpCredential,
    remoteNotice,
    installConnectorById,
    uninstallConnectorById,
    setConnectorEnabledById,
    setConnectorUseInMuseById,
    skills,
    hostSkillsBySession,
    skillInvocationsBySession,
    refreshHostSkills,
    setSkillEnabledByName,
    traceSkillSuggestions,
    invokeSkill,
    scanSkills,
    summaries,
    compactSession,
    usageBySession,
    serverCompactionBySession,
    serverCompact,
    newFromSummary,
    prefill,
    prefillComposer,
    clearPrefill,
    prefillAttachment,
    prefillAttachmentSessionId,
    clearPrefillAttachment,
    artifacts,
    restoreArtifact,
    commentArtifact,
    index,
    gitReview,
    refreshGitStatus,
    loadGitDiff,
    stageGitFiles,
    restoreGitFiles,
    applyGitHunk,
    commitGit,
    fetchGit,
    pullGit,
    pushGit,
    createGitPr,
    terminalForSession,
    openTerminal,
    readTerminal,
    writeTerminal,
    runUserShell,
    resizeTerminal,
    closeTerminal,
    prepareTerminalContext,
    filesForSession,
    prepareWorkspaceFileContext,
    listWorkspaceFiles,
    readWorkspaceFile,
    watchWorkspaceFiles,
    unwatchWorkspaceFiles,
    openWorkspacePath,
    browserAnnotations,
    addBrowserAnnotation,
    prepareBrowserContext,
    prepareBrowserCapture,
    prepareDesktopCapture,
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
    startupProbe,
    probeStartup,
    setError,
  } = useMuseSessions();

  // US-20: one `@mem/…` token the panel asked the composer to insert.
  const [memoryInsert, setMemoryInsert] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<
    "task" | "projects" | "automations" | "extensions" | "library" | "archives"
  >("task");
  const [collapsed, setCollapsed] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const scheduleRunsRef = useRef(scheduleRuns);
  scheduleRunsRef.current = scheduleRuns;
  const [pendingNotificationAction, setPendingNotificationAction] =
    useState<NotificationActionPayload | null>(null);
  const [workPanel, setWorkPanel] = useState<
    "artifacts" | "browser" | "desktop" | "memory" | "tools" | "review" | "terminal" | "files" | null
  >(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [shareExportError, setShareExportError] = useState<string | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchWasOpen = useRef(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsWasOpen = useRef(false);
  const searchResults = searchConversations(sessions, logs, search);
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
  const openPage = useCallback((next: typeof page) => {
    setSettingsOpen(false);
    setPage(next);
  }, []);

  const routeNotificationAction = useCallback((payload: NotificationActionPayload): boolean => {
    const route = resolveNotificationRoute(
      payload,
      sessionsRef.current.map((session) => session.session_id),
      scheduleRunsRef.current.map((run) => run.id),
    );
    if (route?.kind === "task") {
      openPage("task");
      setActive(route.sessionId);
      return true;
    }
    if (route?.kind === "automations") {
      openPage("automations");
      return true;
    }
    return false;
  }, [openPage, setActive]);

  // Native notification actions can be delivered while session/list and the
  // native run ledger are still hydrating. Keep the bounded action until the
  // existing SSOT contains its target instead of dropping the user's click.
  useEffect(() => {
    if (pendingNotificationAction === null) return;
    if (routeNotificationAction(pendingNotificationAction)) {
      setPendingNotificationAction(null);
    }
  }, [pendingNotificationAction, routeNotificationAction, sessions, scheduleRuns]);
  useEffect(() => {
    if (pendingNotificationAction === null) return;
    const timeout = window.setTimeout(() => setPendingNotificationAction(null), 30_000);
    return () => window.clearTimeout(timeout);
  }, [pendingNotificationAction]);

  // M3-09: a native/web notification click carries only a bounded session or
  // run id. Resolve it through the existing session SSOT and focus the task;
  // no notification payload is treated as transcript content.
  useEffect(() => {
    const openFromAction = (payload: NotificationActionPayload) => {
      if (!routeNotificationAction(payload)) setPendingNotificationAction(payload);
    };
    const onWebAction = (event: Event) => {
      const detail = (event as CustomEvent<NotificationActionPayload>).detail;
      if (detail && typeof detail === "object") openFromAction(detail);
    };
    window.addEventListener(NOTIFICATION_ACTION_EVENT, onWebAction);
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void subscribeNotificationActions(openFromAction).then((cleanup) => {
      if (cancelled) cleanup();
      else dispose = cleanup;
    });
    return () => {
      cancelled = true;
      window.removeEventListener(NOTIFICATION_ACTION_EVENT, onWebAction);
      dispose?.();
    };
  }, [routeNotificationAction]);
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
    writeStorageString(THEME_KEY, theme);
  }, [theme]);

  const active = sessions.find((s) => s.session_id === activeId) ?? null;
  const activeProject =
    active === null ? null : projectForSession(active.session_id);
  const activeProjectSettings =
    activeProject === null ? globalSettings : settingsFor(activeProject.id);
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
  const environmentOptions = useMemo(
    () => projectWorkspaceOptions(projects),
    [projects],
  );

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

  const orchestrationWriterPrompts = useMemo(() => {
    const prompts: Record<string, string> = {};
    for (const entry of activeLog) {
      if (entry.role !== "subagent" || typeof entry.agentId !== "string") continue;
      const objective =
        typeof entry.objective === "string" && entry.objective.trim() !== ""
          ? entry.objective
          : entry.text;
      if (objective.trim() !== "") prompts[entry.agentId] = objective.slice(0, 2_000);
    }
    return prompts;
  }, [activeLog]);
  const writerSessionRunning = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.session_id, session.running])),
    [sessions],
  );

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
      onRetry={() => {
        void probeStartup(workspace);
        void startSession();
      }}
      onPickWorkspace={setWorkspace}
      startupProbe={startupProbe}
    />
  );

  async function exportDiagnostics(): Promise<void> {
    let native: NativeDiagnosticsSnapshot | null = null;
    try {
      native = await invoke<NativeDiagnosticsSnapshot>("collect_diagnostics");
    } catch {
      // Web preview and older native builds use the renderer counters below.
    }
    const payload = diagnosticsJson({
      workspace,
      sessionCount: sessions.length,
      runningSessionCount: sessions.filter((session) => session.running).length,
      connectedSessionCount: connectedIds.length,
      pendingApprovalCount: activeApprovals.length,
      pendingInputCount: activeInputRequests.length,
      pendingSendCount: pendingSends.length,
      scheduleCount: schedules.length,
      scheduleRunCount: scheduleRuns.length,
      eventCount: evtCount,
      backendMissing,
      error,
      native,
    });
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `muse-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportArtifact(
    artifact: Artifact,
    version: ArtifactVersion,
  ): Promise<boolean> {
    const slug = artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "muse-artifact";
    const extension = artifact.kind === "doc"
      ? artifact.lang === "md" || artifact.lang === "markdown" ? "md" : "txt"
      : artifact.lang.replace(/[^a-z0-9]+/gi, "").slice(0, 8) || "txt";
    const filename = `${slug}-v${version.v}.${extension}`;
    if (isTauriRuntime()) {
      const target = await save({
        title: "Export artifact",
        defaultPath: filename,
        filters: [{ name: artifact.kind === "doc" ? "Document" : "Source", extensions: [extension] }],
      });
      if (typeof target !== "string" || target.trim() === "") return false;
      await invoke("artifact_export", { path: target, content: version.text });
      return true;
    }
    const blob = new Blob([version.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return true;
  }

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
            title={`New conversation · ${modifier}+N`}
          >
            <Icon name="plus" />
            <span>New conversation</span>
          </button>
          <button
            ref={searchTrigger}
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            title={`Search · ${modifier}+K`}
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
            onTogglePin={togglePinned}
            onMove={moveConversation}
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
            {active && page === "task" && !settingsOpen && !backendMissing && active.session_durability?.toLowerCase() === "ephemeral" && !connectedIds.includes(active.session_id) && (
              <span
                className="workspace-button workspace-durability-note"
                title="This host keeps sessions only while its process is running"
              >
                Local transcript · session ended
              </span>
            )}
            {active && page === "task" && !settingsOpen && !backendMissing && active.session_durability?.toLowerCase() !== "ephemeral" && !connectedIds.includes(active.session_id) && (
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
                onClick={() => void forkSession(active.session_id)}
                disabled={backendMissing || !connectedIds.includes(active.session_id)}
                aria-label="Fork conversation"
                title="Fork conversation from the latest completed turn"
              >
                <Icon name="branch" />
              </button>
            )}
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
              onRestartHost={backendMissing ? undefined : () => restartHost(workspace)}
              authorizationMode={authorizationMode}
              onAuthorizationModeChange={setAuthorizationMode}
              reasoningEffort={globalSettings.reasoningEffort}
              onReasoningEffortChange={(value) => setGlobalSettings({ reasoningEffort: value })}
              providerId={providerId}
              onProviderChange={setProviderId}
              liveModels={liveModels}
              modelsError={modelsError}
              activeSessionId={activeId}
              selectedModelId={active?.model_id ?? null}
              onRefreshModels={() => void refreshModels(activeId ?? undefined)}
              onSelectModel={(modelId) => {
                if (activeId !== null) void setSessionModel(activeId, modelId);
              }}
              onExportDiagnostics={exportDiagnostics}
              startupProbe={startupProbe}
              onProbeStartup={() => probeStartup(workspace)}
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
                  onCreate={(name, instructions, projectWorkspaces) =>
                    createProject(name, instructions, projectWorkspaces)
                  }
                  onDelete={deleteProject}
                  onUpdate={updateProject}
                  onAttach={attachThread}
                  onStartConversation={async (project, selectedWorkspace) => {
                    const workspacePath = selectedWorkspace ?? project.workspace;
                    if (!workspacePath) return;
                    await startSessionInWorkspace(
                      workspacePath,
                      settingsFor(project.id),
                      project.id,
                    );
                  }}
                  onSetGlobal={setGlobalSettings}
                  onSetOverride={setProjectOverride}
                  settingsFor={settingsFor}
                  onCheckWorkspace={async (path) => {
                    if (!isTauriRuntime()) return null;
                    try {
                      const raw = await invoke<unknown>("inspect_workspace_root", { path });
                      return parseWorkspaceRootObservation(raw);
                    } catch {
                      return null;
                    }
                  }}
                  hideGlobalSettings
                />
              </>
            )}
            {page === "automations" && (
              <>
                {" "}
                <SchedulesPanel
                  schedules={schedules}
                  runs={scheduleRuns}
                  schedulerStatus={schedulerStatus}
                  schedulerWakeupStatus={schedulerWakeupStatus}
                  notifications={notifications}
                  notificationPermission={notificationPermission}
                  notificationsMuted={notificationsMuted}
                  unreadNotifications={unreadNotificationCount}
                  sessions={sessions}
                  activeId={activeId}
                  workspace={workspace}
                  projectId={activeProject?.id ?? null}
                  model={activeProjectSettings.model}
                  authorizationMode={authorizationMode}
                  onCreate={(input) => {
                    createSchedule(input);
                  }}
                  onToggle={(id, enabled) => setScheduleEnabled(id, enabled)}
                  onDelete={(id) => deleteSchedule(id)}
                  onRunNow={(id) => runScheduleNow(id)}
                  onCancelRun={(id) => cancelScheduleRun(id)}
                  onMarkRunRecoveryFailed={(id) => markScheduleRunRecoveryFailed(id)}
                  onMarkRunRead={(id) => markScheduleRunRead(id)}
                  onSetRunArchived={(id, archived) => setScheduleRunArchived(id, archived)}
                  onRetryRunNow={(id) => retryScheduleRunNow(id)}
                  onEnableNotifications={enableNotifications}
                  onSetNotificationsMuted={setNotificationsMuted}
                  onMarkNotificationRead={markNotificationRead}
                  onOpenNotification={(notification) => {
                    const route = resolveNotificationRoute(
                      { sessionId: notification.sessionId, runId: notification.runId },
                      sessionsRef.current.map((session) => session.session_id),
                      scheduleRunsRef.current.map((run) => run.id),
                    );
                    if (route?.kind === "task") {
                      openPage("task");
                      setActive(route.sessionId);
                    } else if (route?.kind === "automations") {
                      openPage("automations");
                    }
                  }}
                  onOpenRun={(run) => {
                    const route = resolveNotificationRoute(
                      { sessionId: run.sessionId, runId: run.id },
                      sessionsRef.current.map((session) => session.session_id),
                      scheduleRunsRef.current.map((candidate) => candidate.id),
                    );
                    if (route?.kind === "task") {
                      openPage("task");
                      setActive(route.sessionId);
                    } else if (route?.kind === "automations") {
                      openPage("automations");
                    }
                  }}
                />
              </>
            )}
            {page === "extensions" && (
              <div className="destination-grid">
                {" "}
                <ConnectorPanel
                  installed={connectors}
                  toolNames={connectorTools.map((t) => t.name)}
                  workspace={workspace}
                  onProbeLocal={(command) => probeLocalMcp(command, workspace)}
                  onCallLocal={(command, toolName, argumentsText) =>
                    callLocalMcp(command, toolName, argumentsText, workspace)
                  }
                  onRegisterLocal={registerLocalConnector}
                  onInstallPackage={installMcpPackage}
                  onRefreshLocal={(id) => refreshLocalMcp(id, workspace)}
                  onRollbackLocal={rollbackLocalMcp}
                  mcpRunningIds={mcpRunningIds}
                  onStartLocal={(id) => startLocalMcp(id, workspace)}
                  onStopLocal={stopLocalMcp}
                  onCallRegisteredLocal={callRegisteredLocalMcp}
                  remoteConnectedIds={remoteConnectedIds}
                  onProbeRemote={probeRemoteMcp}
                  onCallRemote={callRemoteMcp}
                  onDisconnectRemote={disconnectRemoteMcp}
                  onForgetRemoteCredential={forgetRemoteMcpCredential}
                  authorizationMode={authorizationMode}
                  remoteNotice={remoteNotice}
                  activeSessionId={activeId}
                  canReconnectActive={
                    active !== null &&
                    !backendMissing &&
                    active.session_durability?.toLowerCase() !== "ephemeral"
                  }
                  onReconnectActive={(sessionId) => reconnectSession(sessionId)}
                  onInstall={(dirId) => installConnectorById(dirId)}
                  onUninstall={(id) => uninstallConnectorById(id)}
                  onToggle={(id, enabled) =>
                    setConnectorEnabledById(id, enabled)
                  }
                  onUseInMuse={(id, enabled) => setConnectorUseInMuseById(id, enabled)}
                />{" "}
                <SkillPanel
                  skills={skills}
                  hostSkills={activeId !== null ? (hostSkillsBySession[activeId] ?? []) : []}
                  skillProgress={activeId !== null ? skillInvocationsBySession[activeId] : undefined}
                  workspace={workspace}
                  onRefreshHost={() => activeId !== null ? refreshHostSkills(activeId) : Promise.resolve(null)}
                  onScan={() => scanSkills(workspace)}
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
              ? sidecarPanel
              : error && (
                <div className="error-banner" role="alert">
                  <span>{userFacingError(error)}</span>
                  {error.toLowerCase().includes("restart the workspace host") && !backendMissing && (
                    <button
                      type="button"
                      className="error-banner-action"
                      onClick={() => {
                        if (!window.confirm("Restart the workspace host? Active conversations will disconnect and can reconnect when the host supports durable sessions.")) return;
                        void restartHost(workspace);
                      }}
                    >
                      Restart workspace host
                    </button>
                  )}
                </div>
              )}
            {active === null ? (
              <EmptySessionScreen
                workspace={workspace}
                onPickWorkspace={setWorkspace}
                environmentOptions={environmentOptions}
                onStart={async (draft, inputParts, environment?: NewConversationEnvironment) => {
                  const project = environment?.projectId
                    ? projects.find((candidate) => candidate.id === environment.projectId) ?? null
                    : null;
                  const id = project !== null && environment?.workspace
                    ? await startSessionInWorkspace(environment.workspace, settingsFor(project.id), project.id)
                    : await startSession();
                  if (id === null || (draft.trim() === "" && (inputParts?.length ?? 0) === 0)) return id !== null;
                  // M0-03: honest result — when the first send fails the
                  // welcome draft must not be reported as sent; the text
                  // stays recoverable via the retryable pending-send notice.
                  const res = await sendInput(id, draft, undefined, inputParts);
                  return res.ok;
                }}
                backendMissing={backendMissing}
                sidecarError={sidecarPanel}
                authorizationMode={authorizationMode}
                onAuthorizationModeChange={setAuthorizationMode}
                reasoningEffort={globalSettings.reasoningEffort}
                onReasoningEffortChange={(value) => setGlobalSettings({ reasoningEffort: value })}
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
                      {active.branch !== undefined && (
                        <>
                          <span>·</span>
                          <span title="Host-reported Git branch">{active.branch}</span>
                        </>
                      )}
                      <span className={`connection-state connection-${activeConnectionState}`}>
                        <span className="connection-state-dot" aria-hidden="true" />
                        {activeConnectionState === "connected"
                          ? "Connected"
                          : activeConnectionState === "connecting"
                            ? "Connecting"
                            : activeConnectionState === "error"
                              ? "Connection error"
                              : "Disconnected"}
                      </span>
                    </div>
                    {activeProject !== null && (
                      <div
                        className="task-project-context"
                        title="Project settings: the model and project isolation overrides are sent to a new workspace host; the global permission gate still applies and an existing host keeps its posture until restart."
                      >
                        <span>Project: {activeProject.name}</span>
                        <span>
                          Model: {activeProjectSettings.model === "default"
                            ? "Host default"
                            : activeProjectSettings.model}
                        </span>
                        <span title="Projected to host startup with the global permission gate; an existing host keeps its posture until restart">
                          Sandbox preference: {activeProjectSettings.sandbox}
                        </span>
                        <span title="Project network preference remains the approval policy; host network posture is selected at workspace startup">
                          Network preference: {activeProjectSettings.networkDefault}
                        </span>
                        <span>
                          Reasoning: {reasoningEffortLabel(activeProjectSettings.reasoningEffort)}
                        </span>
                      </div>
                    )}
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
                    running={active.running}
                    stopping={stoppingBySession[active.session_id] === true}
                    lastEventAt={activeStreamActivity?.lastEventAt ?? null}
                    lastEventKind={activeStreamActivity?.lastEventKind ?? null}
                    resumePendingAt={activeResumePending?.requestedAt ?? null}
                    retryScheduled={activeRetryScheduled}
                    pendingApprovals={activeApprovals.length}
                    pendingInputs={activeInputRequests.length}
                    reconnecting={reconnectingId === active.session_id}
                    onReconnect={active.session_durability?.toLowerCase() === "ephemeral" ? undefined : () => void reconnectSession(active.session_id)}
                    reconciling={reconcilingId === active.session_id}
                    onReconcile={() => void reconcileSession(active.session_id)}
                    onCancel={() => void cancelSession(active.session_id)}
                    onForceStop={() => void killSession(active.session_id)}
                    onRetryFailedTurn={(entry) => retryFailedTurn(active.session_id, entry.id)}
                    onForkFromEntry={(turnId) => void forkSession(active.session_id, turnId)}
                    onOpenWorkspacePath={(path) => openWorkspacePath(active.session_id, path)}
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
                      onReadOutput: (entry, offsetBytes) =>
                        readItemOutput(active.session_id, entry, offsetBytes),
                    }}
                  />

                  {queuedTurns.length > 0 && (
                    <section className="queued-turns" aria-label="Queued messages">
                      <div className="queued-turns-head">
                        <strong>Queued messages</strong>
                        <span className="muted">They will run in order</span>
                      </div>
                      {queuedTurns.map((turn) => (
                        <div className={`queued-turn${turn.recovered ? " queued-turn-recovered" : ""}`} key={turn.turn_id}>
                          <span className="queued-turn-text" title={turn.text}>
                            {turn.text.length > 120 ? `${turn.text.slice(0, 120)}…` : turn.text}
                          </span>
                          {turn.recovered && (
                            <span className="queued-turn-note">
                              Saved before restart — verify the host queue
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (turn.recovered) dismissQueuedTurn(active.session_id, turn.turn_id);
                              else void unqueueTurn(active.session_id, turn.turn_id);
                            }}
                            title={turn.recovered ? "Dismiss this local queue reminder" : "Remove this message from the host queue"}
                          >
                            {turn.recovered ? "Dismiss" : "Remove from queue"}
                          </button>
                        </div>
                      ))}
                    </section>
                  )}
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
                          {liveModels?.find((model) => model.isActive)?.displayLabel ||
                            active.model_id ||
                            "Model"}
                        </button>
                        <span>Local</span>
                      </>
                    }
                    running={active.running}
                    stopping={stoppingBySession[active.session_id] === true}
                    workspace={active.workspace}
                    onSend={(text, inputParts) => sendInput(active.session_id, text, undefined, inputParts)}
                    onSteer={(text, inputParts) => steerInput(active.session_id, text, inputParts)}
                    onCancel={() => void cancelSession(active.session_id)}
                    prefill={prefill}
                    onPrefillConsumed={clearPrefill}
                    prefillAttachment={
                      prefillAttachmentSessionId === active.session_id
                        ? prefillAttachment
                        : null
                    }
                    onPrefillAttachmentConsumed={clearPrefillAttachment}
                    memories={memories}
                    memoryInsert={memoryInsert}
                    onMemoryInsertConsumed={() => setMemoryInsert(null)}
                    authorizationMode={authorizationMode}
                    onAuthorizationModeChange={setAuthorizationMode}
                    reasoningEffort={activeProjectSettings.reasoningEffort}
                    onReasoningEffortChange={(value) => {
                      if (activeProject !== null) {
                        setProjectOverride(activeProject.id, "reasoningEffort", value);
                      } else {
                        setGlobalSettings({ reasoningEffort: value });
                      }
                      void setSessionReasoningEffort(active.session_id, value);
                    }}
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
                          ["files", "Files"],
                          ["browser", "Browser"],
                          ["desktop", "Desktop"],
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
                            onExport={exportArtifact}
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
                          onApplyHunk={applyGitHunk}
                          onCommit={commitGit}
                          onFetch={fetchGit}
                          onPull={pullGit}
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
                          canRunThroughMuse={userShellAvailableForSession(active.session_id)}
                          onRunThroughMuse={runUserShell}
                          onInsertContext={prepareTerminalContext}
                        />
                      )}
                      {workPanel === "files" && (
                        <FilesPanel
                          sessionId={active.session_id}
                          state={filesForSession(active.session_id)}
                          onList={listWorkspaceFiles}
                          onRead={readWorkspaceFile}
                          onWatch={watchWorkspaceFiles}
                          onUnwatch={unwatchWorkspaceFiles}
                          onOpen={openWorkspacePath}
                          onInsertContext={prepareWorkspaceFileContext}
                        />
                      )}
                      {workPanel === "browser" && (
                        <>
                          {" "}
                          <BrowserPanel
                            key={active.session_id}
                            sessionId={active.session_id}
                            annotations={browserAnnotations}
                            permissions={browserPermissions}
                            hostSkills={hostSkillsBySession[active.session_id] ?? []}
                            skillProgress={skillInvocationsBySession[active.session_id]}
                            onInvokeBrowserSkill={(selector, args) =>
                              invokeSkill(active.session_id, selector, args)
                            }
                            onCancelBrowserSkill={() => cancelSession(active.session_id)}
                            onAddAnnotation={addBrowserAnnotation}
                            onInsertContext={(context) => {
                              void prepareBrowserContext(active.session_id, context);
                            }}
                            onInsertCapture={(capture) =>
                              prepareBrowserCapture(active.session_id, capture)
                            }
                            onRemoveAnnotation={removeBrowserAnnotation}
                            onSetPermission={setBrowserAppPermission}
                          />
                        </>
                      )}
                      {workPanel === "desktop" && (
                        <DesktopControlPanel
                          permissions={browserPermissions}
                          onSetPermission={setBrowserAppPermission}
                          onInsertCapture={(capture) =>
                            prepareDesktopCapture(active.session_id, capture)
                          }
                          onInsertContext={(context) =>
                            prepareBrowserContext(active.session_id, context)
                          }
                          hostSkills={hostSkillsBySession[active.session_id] ?? []}
                          skillProgress={skillInvocationsBySession[active.session_id]}
                          onInvokeDesktopSkill={(selector, args) =>
                            invokeSkill(active.session_id, selector, args)
                          }
                          onCancelDesktopSkill={() => cancelSession(active.session_id)}
                        />
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
                            serverCompaction={
                              serverCompactionBySession[active.session_id] ?? { status: "idle" }
                            }
                            onServerCompact={() =>
                              void serverCompact(active.session_id)
                            }
                          />{" "}
                          <OrchestrationPanel
                            agents={orchestrationAgents}
                            sessionId={active.session_id}
                            workspace={active.workspace}
                            onCreateWorktree={createWorktree}
                            onCreateConversationWorktree={(plan) =>
                              createWorktreeSession(
                                active.session_id,
                                plan,
                                activeProject !== null ? activeProjectSettings : undefined,
                              )
                            }
                            onCreateSetupConversationWorktree={async (plan, command, envAllowlist, onCreated) => {
                              const projectSettings = activeProject !== null ? activeProjectSettings : undefined;
                              const created = await createWorktree(active.session_id, plan);
                              if (created === null) return null;
                              onCreated?.(created);
                              const setup = await runWorktreeSetup(
                                active.session_id,
                                created,
                                command,
                                envAllowlist,
                              );
                              if (setup === null || setup.status !== "ready") {
                                const status = setup?.status ?? "failed";
                                const removed = await removeWorktree(active.session_id, created);
                                setError(
                                  `Worktree setup ${status}; the new checkout was ${removed ? "removed" : "kept for cleanup retry"}.`,
                                );
                                return null;
                              }
                              const opened = await startSessionInWorkspace(
                                created.path,
                                projectSettings,
                              );
                              if (opened === null) {
                                const removed = await removeWorktree(active.session_id, created);
                                setError(
                                  `Conversation admission failed; the new checkout was ${removed ? "removed" : "kept for cleanup retry"}.`,
                                );
                                return null;
                              }
                              return created;
                            }}
                            worktrees={worktrees}
                            cleanupIntents={cleanupIntents}
                            onRemoveWorktree={removeWorktree}
                            onOpenWorktree={async (record) =>
                              startSessionInWorkspace(
                                record.path,
                                activeProject !== null ? activeProjectSettings : undefined,
                              )
                            }
                            onOpenHandoffWorktree={async (record, plan) => {
                              const opened = await startSessionInWorkspace(
                                record.path,
                                activeProject !== null ? activeProjectSettings : undefined,
                              );
                              if (opened !== null) prefillComposer(formatHandoffContext(plan));
                              return opened;
                            }}
                            writerPrompts={orchestrationWriterPrompts}
                            writerLogs={logs}
                            writerSessionRunning={writerSessionRunning}
                            onDispatchWriter={async (record, prompt) => {
                              const sourceId = activeId;
                              try {
                                const existing = sessions.find(
                                  (session) =>
                                    session.workspace.toLowerCase() === record.path.toLowerCase() &&
                                    session.archived !== true &&
                                    connectedIds.includes(session.session_id),
                                );
                                const writerId =
                                  existing?.session_id ??
                                  (await startSessionInWorkspace(
                                    record.path,
                                    activeProject !== null ? activeProjectSettings : undefined,
                                  ));
                                if (writerId === null) return null;
                                const result = await sendInput(writerId, prompt);
                                return result.ok ? { sessionId: writerId } : null;
                              } finally {
                                if (sourceId !== null) setActive(sourceId);
                              }
                            }}
                            onStopWriter={async (writerId) => {
                              await cancelSession(writerId);
                            }}
                            onOpenWriterConversation={(writerId) => setActive(writerId)}
                            onInspectWorktree={inspectWorktree}
                            onCheckReadiness={checkWorktreeReadiness}
                            onRunSetup={runWorktreeSetup}
                            onCancelSetup={cancelWorktreeSetup}
                            sourceStatus={gitReview(active.session_id).status}
                          />{" "}
                          <SharePanel
                            sessionId={active.session_id}
                            mode={shareMode}
                            bundles={sessionBundles(active.session_id)}
                            exportError={shareExportError}
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
                            onDownload={async (b: ShareBundle) => {
                              const ext = b.format === "json" ? "json" : "md";
                              const filename = `${b.bundleId}.${ext}`;
                              try {
                                setShareExportError(null);
                                if (isTauriRuntime()) {
                                  const target = await save({
                                    title: "Save conversation export",
                                    defaultPath: filename,
                                    filters: [{
                                      name: b.format === "json" ? "JSON" : "Markdown",
                                      extensions: [ext],
                                    }],
                                  });
                                  if (typeof target !== "string" || target.trim() === "") return;
                                  await invoke("artifact_export", { path: target, content: b.body });
                                  return;
                                }
                                const blob = new Blob([b.body], {
                                  type: b.format === "json" ? "application/json" : "text/markdown",
                                });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = filename;
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                                URL.revokeObjectURL(url);
                              } catch (error) {
                                setShareExportError(`Export failed: ${userFacingError(error instanceof Error ? error.message : String(error))}`);
                              }
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
                  .session.session_id,
              );
              openPage("task");
              setSearchOpen(false);
            }
          }}
        />
        <div className="search-results">
          {searchResults.map((hit, index) => (
            <button
              key={hit.session.session_id}
              className={index === searchIndex ? "search-highlight" : undefined}
              onClick={() => {
                setActive(hit.session.session_id);
                openPage("task");
                setSearchOpen(false);
              }}
            >
              <Icon name="code" />
              <span>
                {hit.session.title || hit.session.session_id.slice(0, 8)}
                {hit.excerpt !== null && <small className="search-excerpt">{hit.excerpt}</small>}
              </span>
              <small>{hit.session.archived ? "Archived" : ""}</small>
            </button>
          ))}
          {searchResults.length === 0 && <p className="muted">No conversations found.</p>}
        </div>
      </dialog>
    </div>
  );
}
