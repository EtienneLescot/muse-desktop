import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { classifySidecarError, extractTriedPaths } from "./lib/sidecarError";
import { THEME_KEY, nextTheme, resolveTheme, type Theme } from "./lib/theme";
import { cycleThreadId, selectActiveThreads } from "./lib/threads";
import { SidecarErrorPanel } from "./components/SidecarErrorPanel";
import { MuseSetupScreen } from "./components/MuseSetupScreen";
import { isMacPlatform } from "./lib/platform";
import { useMuseSessions } from "./hooks/useMuseSessions";
import { useDismissablePopovers, usePopoverExpandedState } from "./hooks/useDismissablePopovers";
import { SettingsPanel } from "./components/SettingsPanel";
import { MessageContent } from "./components/MessageContent";
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
import { SchedulesPanel } from "./components/SchedulesPanel";
import { ReviewQueuePanel } from "./components/ReviewQueuePanel";
import { ConnectorPanel } from "./components/ConnectorPanel";
import { SkillPanel } from "./components/SkillPanel";
import { ImportPanel } from "./components/ImportPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { FilesPanel } from "./components/FilesPanel";
import { formatReviewComment, type ReviewAnchor } from "./lib/reviewComments";
import { diagnosticsJson, type NativeDiagnosticsSnapshot } from "./lib/diagnostics";
import { userFacingError } from "./lib/errorCopy";
import { displayPath } from "./lib/paths";
import { signInCommand, type AuthStatusPayload } from "./lib/museAuth";
import { ModelControl } from "./components/ModelControl";
import { ContextMeter } from "./components/ContextMeter";
import { ComputerUsePanel } from "./components/ComputerUsePanel";
import { isTauriRuntime } from "./lib/env";
import { formatWorktreeContinuationNote } from "./lib/handoff";
import {
  folderName,
  parseWorkspaceRootObservation,
  projectWorkspaceOptions,
  projectWorkspaces,
} from "./lib/projects";
import { parseHarnessRules } from "./lib/harnessRules";
import { planConversationWorktree } from "./lib/worktrees";
// US-32: polite live-region announcements for stream/approval/input changes.
import {
  approvalAnnouncement,
  inputAnnouncement,
  primaryModifier,
  streamStatusMessage,
  zoomShortcutTitle,
} from "./lib/a11y";
import { IndexPanel } from "./components/IndexPanel";
import { BrowserPanel } from "./components/BrowserPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { Icon } from "./components/Icon";
import { searchConversations } from "./lib/conversationSearch";
import { WindowControls, dragWindow, usesNativeTrafficLights } from "./components/WindowControls";
import { readStorageJson, readStorageString, writeStorageJson, writeStorageString } from "./lib/storage.ts";
import {
  NOTIFICATION_ACTION_EVENT,
  resolveNotificationRoute,
  subscribeNotificationActions,
  type NotificationActionPayload,
} from "./lib/notifications";
import "./App.css";
import "./Desktop.css";

const SIDEBAR_WIDTH_KEY = "muse-desktop.sidebar-width.v1";
const DEFAULT_SIDEBAR_WIDTH = 246;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 460;

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
    activeRecoveryNotice,
    activeResumePending,
    activeRetryScheduled,
    stoppingBySession,
    activeConnectionState,
    connectionNoticeBySession,
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
    liveModels,
    liveModelsSessionId,
    setSessionModel,
    setSessionReasoningEffort,
    usageBySession,
    serverCompactionBySession,
    serverCompact,
    createWorktreeForWorkspace,
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
    sessionLoadedForSession,
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
    reorderConversation,
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
    markAllNotificationsRead,
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
    importedSessions,
    importNotes,
    importConfigText,
    dismissImport,
    subagentInterrupt,
    subagentStop,
    subagentClose,
    subagentReopen,
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
    prefill,
    prefillComposer,
    clearPrefill,
    prefillAttachment,
    prefillAttachmentSessionId,
    clearPrefillAttachment,
    index,
    gitReview,
    gitTurnSnapshot,
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
    prepareBrowserContext,
    computerUse,
    computerBusy,
    refreshComputerUse,
    setComputerLevel,
    disableComputerUse,
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
  // M2-05: the step a move to a worktree is on, or null. The button carries it
  // because the conversation screen has no preparation banner of its own.
  const [movingToWorktree, setMovingToWorktree] = useState<string | null>(null);
  // The conversation being started, before the host has given it a session id:
  // the first message as typed, and what the app is waiting for in plain words.
  // Null when idle.
  const [preparation, setPreparation] = useState<{ step: string; draft: string } | null>(null);
  const [page, setPage] = useState<
    "task" | "projects" | "automations" | "extensions" | "library" | "archives"
  >("task");
  const [collapsed, setCollapsed] = useState(false);
  // The sidebar's width belongs to the user: dragged on its edge, kept across
  // runs. Bounded so it can never swallow the conversation or vanish.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStorageJson(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH),
  );
  const [museInstalledSignal, setMuseInstalledSignal] = useState(0);
  // A turn failed with `authRequired`: sign in, then replay that turn.
  const [signInFor, setSignInFor] = useState<{ sessionId: string; entryId: string } | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const scheduleRunsRef = useRef(scheduleRuns);
  scheduleRunsRef.current = scheduleRuns;
  const [pendingNotificationAction, setPendingNotificationAction] =
    useState<NotificationActionPayload | null>(null);
  const [workPanel, setWorkPanel] = useState<
    "browser" | "review" | "terminal" | "files" | null
  >(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchWasOpen = useRef(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsWasOpen = useRef(false);
  // Mounted once for the whole app. Every `<details data-popover>` then gets
  // dismissal on an outside click and on Escape, and an honest `aria-expanded`
  // on its trigger, so a new picker cannot ship without the behaviour by
  // forgetting a per-control effect. Content disclosures carry no marker and are
  // never closed: see src/lib/popovers.ts for why that split matters.
  useDismissablePopovers();
  usePopoverExpandedState();
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
    // Navigating from the sidebar must dismiss whatever overlay is up, or the
    // destination renders behind it. Settings was already closed here; search was
    // not, so opening Search and then clicking Automations/Extensions/Library left
    // the dialog on top of the new view — measured with `dialog.task-search`
    // covering the view's own `h1`, the navigation having already happened.
    setSettingsOpen(false);
    setSearchOpen(false);
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
  // macOS does not bundle the engine: a missing sidecar there means the Muse
  // CLI is simply not installed yet — a first-run step, not an error.
  const needsMuseSetup = sidecarKind === "missing" && isMacPlatform() && isTauriRuntime();
  const sidecarPanel = needsMuseSetup ? (
    <MuseSetupScreen
      onReady={() => {
        // Back to the welcome screen; it replays the start the user asked for
        // (draft, project, worktree) instead of an empty session here.
        setError(null);
        void probeStartup(workspace);
        setMuseInstalledSignal((value) => value + 1);
      }}
    />
  ) : sidecarKind !== null && error !== null && (
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

  /**
   * Drive the Muse CLI's device-code sign-in inside the built-in terminal.
   *
   * Why a terminal and not an OAuth client: MSP is a stdio protocol with no
   * authentication concept, so there is no Meta/Muse endpoint the desktop could
   * authenticate against on its own. `muse login` already implements the flow —
   * it prints a URL and a code, the user approves in a browser, and the CLI
   * stores the credential itself. The desktop therefore never handles the
   * secret, which is strictly safer than storing one.
   *
   * The command text comes from `signInCommand`, which returns null unless the
   * payload carries the exact reviewed command, so a compromised or future
   * native payload cannot inject a shell line here.
   */
  async function signInWithMuseCli(): Promise<void> {
    if (!isTauriRuntime()) return;
    const status = await invoke<AuthStatusPayload>("muse_auth_status").catch(() => null);
    const command = signInCommand(status);
    if (command === null) return;

    const sessionId = activeId;
    if (sessionId === null) return;
    // The terminal panel only exists while it is the selected work panel, so
    // showing it is part of preparing the action rather than a side effect.
    setWorkPanel("terminal");
    setSettingsOpen(false);

    // `terminalForSession` reports the panel's view state; `openTerminal`
    // answers the native `TerminalInfo`, which is what carries the id to write
    // to. Mixing the two was a type error, so both are handled separately.
    let terminalId = terminalForSession(sessionId)?.info.terminalId ?? null;
    for (let attempt = 0; attempt < 20 && terminalId === null; attempt += 1) {
      // Opening a PTY is not instant; the command must not be written into a
      // shell that does not exist yet.
      const opened = await openTerminal(sessionId);
      terminalId = opened?.terminalId ?? null;
      if (terminalId === null) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    if (terminalId === null) return;
    await writeTerminal(terminalId, command);
  }

  async function exportDiagnostics(): Promise<void> {    let native: NativeDiagnosticsSnapshot | null = null;
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

  /**
   * Continue this conversation in a worktree.
   *
   * This is not a transfer, and it does not pretend to be one: MSP has no
   * multi-workspace contract, so a session cannot move between hosts. What
   * happens is a copy of the folder, a new conversation in it, and a bounded
   * context note in the composer — while this conversation stays exactly where
   * it is, transcript included.
   */
  async function moveToWorktree(sessionId: string): Promise<void> {
    const session = sessions.find((candidate) => candidate.session_id === sessionId);
    if (session === undefined || movingToWorktree !== null) return;
    const source = session.workspace;
    try {
      setError(null);
      setMovingToWorktree("Creating a worktree…");
      const plan = planConversationWorktree(
        folderName(source),
        undefined,
        Date.now().toString(36).slice(-5),
      );
      const record = await createWorktreeForWorkspace(source, plan);
      if (record === null) return;
      setMovingToWorktree("Starting Muse in the copy…");
      const project = projectForSession(sessionId);
      const opened = await startSessionInWorkspace(
        record.path,
        project !== null ? settingsFor(project.id) : undefined,
        project?.id,
      );
      if (opened === null) {
        setError(
          "The worktree was created but no conversation could start in it; it is kept, and you can open it from the worktrees panel.",
        );
        return;
      }
      prefillComposer(
        formatWorktreeContinuationNote(source, record.path, record.branch),
      );
    } catch (error) {
      setError(userFacingError(error, "The worktree action could not be completed."));
    } finally {
      setMovingToWorktree(null);
    }
  }

  return (
    <div
      className={`app desktop-app ${collapsed ? "nav-collapsed" : ""} ${usesNativeTrafficLights() ? "platform-macos" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      {signInFor !== null && (
        <div className="muse-setup-overlay" role="dialog" aria-modal="true" aria-label="Sign in to Muse">
          <MuseSetupScreen
            initialStep="login"
            onClose={() => setSignInFor(null)}
            onReady={async () => {
              const target = signInFor;
              setSignInFor(null);
              // A running Muse host read its credentials at start: restart it
              // so it sees the new sign-in, reconnect, then replay the turn.
              const session = sessions.find((candidate) => candidate.session_id === target.sessionId);
              if (session !== undefined && await restartHost(session.workspace)) {
                await reconnectSession(target.sessionId);
              }
              await retryFailedTurn(target.sessionId, target.entryId);
            }}
          />
        </div>
      )}
      <a className="skip-link" href="#composer">
        Skip to message input
      </a>
      <div className="sr-only" aria-live="polite" role="status">
        {liveMessage}
      </div>
      <aside className="sidebar" aria-label="Sidebar">
        {usesNativeTrafficLights() && (
          <div className="mac-titlebar" aria-hidden="true" onMouseDown={dragWindow} />
        )}
        <div className="brand" onMouseDown={dragWindow}>
          <span className="muse-logo">
            <img src="muse-logo.png" alt="" />
          </span>
          <span className="brand-text" title={zoomShortcutTitle()}>Muse-Desktop</span>
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
            pendingSendCount={pendingSends.length}
            onOpenPendingSends={() => {
              const first = pendingSends[0];
              if (first === undefined) return;
              openPage("task");
              setActive(first.sessionId);
            }}
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
            onReorder={reorderConversation}
            onMove={moveConversation}
            onArchive={archiveSession}
            onRestore={restoreSession}
            onFork={(id) => void forkSession(id)}
            onMoveToWorktree={(id) => void moveToWorktree(id)}
            movingToWorktree={movingToWorktree}
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
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="avatar" aria-hidden="true">
              M
            </span>
            <span className="account-name">Settings</span>
          </button>
        </div>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.dataset.dragging = "true";
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.dataset.dragging !== "true") return;
            const bounded = Math.min(
              MAX_SIDEBAR_WIDTH,
              Math.max(MIN_SIDEBAR_WIDTH, Math.round(event.clientX)),
            );
            setSidebarWidth(bounded);
          }}
          onPointerUp={(event) => {
            delete event.currentTarget.dataset.dragging;
            event.currentTarget.releasePointerCapture(event.pointerId);
            writeStorageJson(SIDEBAR_WIDTH_KEY, sidebarWidth);
          }}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            writeStorageJson(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH);
          }}
        />
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
            {backendMissing && (
              <span className="pill">
                <span className="dot" />
                Web preview
              </span>
            )}
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
                onClick={() => setWorkPanel(workPanel ? null : "review")}
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
              onExportDiagnostics={exportDiagnostics}
              startupProbe={startupProbe}
              onProbeStartup={() => probeStartup(workspace)}
              onSignIn={signInWithMuseCli}
            />
            {/* Global capabilities, not work on the current conversation: they
                used to be side-panel tabs next to Changes and Terminal. */}
            <div className="settings-extra">
              <ComputerUsePanel
                status={computerUse}
                busy={computerBusy}
                onRefresh={refreshComputerUse}
                onSetLevel={setComputerLevel}
                onDisable={disableComputerUse}
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
            </div>
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
                  projects:
                    "Group conversations, give them a folder and preferences.",
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
                  onCreate={(projectName, projectWorkspaces) =>
                    createProject(projectName, projectWorkspaces)
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
                  onReadRules={async (path) => {
                    if (!isTauriRuntime()) return null;
                    try {
                      const raw = await invoke<unknown>("rules_scan", { workspace: path });
                      return parseHarnessRules(raw);
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
                  onMarkAllNotificationsRead={markAllNotificationsRead}
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
                    if (activeId === null) return;
                    invokeSkill(activeId, name, "");
                    openPage("task");
                  }}
                  canInvoke={activeId !== null}
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
                      {/*
                        Permanent delete, the action this page was missing: an
                        archived conversation could only be restored, which left
                        no way to get rid of one. `killSession` is the same path
                        the conversation-actions menu uses — it stops the session
                        and records a persisted tombstone, so the entry does not
                        come back on the next `session/list`.
                      */}
                      <button
                        className="danger"
                        data-danger="true"
                        onClick={() => {
                          const title = session.title || session.session_id.slice(0, 8);
                          if (
                            !window.confirm(
                              `Delete "${title}" permanently?\n\nIt will disappear from Muse and will not come back. The conversation file itself stays on disk, under the Muse data folder, until it is removed there.`,
                            )
                          ) {
                            return;
                          }
                          void killSession(session.session_id);
                        }}
                      >
                        Delete…
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
            {computerUse?.grantState === "permissions" && (
              <div className="app-banner" role="status">
                <span>
                  Computer use is on, but macOS has not allowed CuaDriver yet: Muse cannot see or
                  control this Mac.
                </span>
                <button type="button" onClick={() => setSettingsOpen(true)}>
                  Finish setup
                </button>
              </div>
            )}
            {backendMissing && (
              <div className="preview-notice">
                Web preview · Open the desktop app to work with
                Muse. Your local history is still available.
              </div>
            )}
            {needsMuseSetup
              ? null
              : sidecarKind !== null
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
            {active === null && preparation !== null ? (
              /* The conversation opens on the first message, not on a spinner in
                 the middle of the welcome screen: the host has no session id yet,
                 so this stands in until it does — same shape, same bubble. */
              <div className="stream pending-start" role="status" aria-live="polite">
                <div className="msg user">
                  <MessageContent text={preparation.draft} />
                </div>
                <p className="pending-start-step">
                  <span className="welcome-spinner" aria-hidden="true" />
                  <span>{preparation.step}</span>
                </p>
              </div>
            ) : active === null ? (
              <EmptySessionScreen
                workspace={workspace}
                onCreateProjectFromFolder={async (path) => {
                  // A project *is* its folder, as the CLI has it: the name comes
                  // from the folder, and the folder is the only thing asked for.
                  const created = createProject(folderName(path), [path]);
                  if (created === null) return null;
                  const roots = projectWorkspaces(created);
                  const index = roots.indexOf(path);
                  return `${created.id}:${index >= 0 ? index : 0}`;
                }}
                environmentOptions={environmentOptions}
                onStart={async (draft, inputParts, environment?: NewConversationEnvironment) => {
                  const project = environment?.projectId
                    ? projects.find((candidate) => candidate.id === environment.projectId) ?? null
                    : null;
                  // A worktree is created before the conversation exists: the
                  // folder is the one the user chose, and the session then starts
                  // inside the copy. Nothing is moved afterwards.
                  //
                  // Each step is announced. Starting a conversation in a worktree
                  // can take several seconds — a copy of the repository, then a
                  // Muse host for that folder — and the screen used to say only
                  // "Starting…", which is indistinguishable from a hang.
                  let startFolder = environment?.workspace ?? null;
                  try {
                    if (environment?.worktree === true && startFolder !== null) {
                      setPreparation({ draft, step: `Creating a worktree of ${folderName(startFolder)}…` });
                      // A short, unique tail: two conversations in the same project must not ask for the same folder and branch.
                      const plan = planConversationWorktree(folderName(startFolder), undefined, Date.now().toString(36).slice(-5));
                      const record = await createWorktreeForWorkspace(startFolder, plan);
                      if (record === null) return false;
                      startFolder = record.path;
                    }
                    setPreparation({
                      draft,
                      step: startFolder === null
                        ? "Starting a Muse host…"
                        : `Starting Muse in ${folderName(startFolder)}…`,
                    });
                    // M2-03 "Create & open": once a worktree exists the session
                    // must start in it, project or not — falling back to
                    // startSession() here launched the conversation in the main
                    // repository while the copy sat unused in .muse/worktrees.
                    const id = startFolder !== null
                      ? await startSessionInWorkspace(
                          startFolder,
                          project !== null ? settingsFor(project.id) : undefined,
                          project?.id,
                        )
                      : await startSession();
                    if (id === null || (draft.trim() === "" && (inputParts?.length ?? 0) === 0)) return id !== null;
                    setPreparation({ draft, step: "Sending your first message…" });
                    // M0-03: honest result — when the first send fails the
                    // welcome draft must not be reported as sent; the text
                    // stays recoverable via the retryable pending-send notice.
                    const res = await sendInput(id, draft, undefined, inputParts);
                    return res.ok;
                  } finally {
                    setPreparation(null);
                  }
                }}
                backendMissing={backendMissing}
                sidecarError={sidecarPanel}
                resumeStartSignal={museInstalledSignal}
                authorizationMode={authorizationMode}
                onAuthorizationModeChange={setAuthorizationMode}
                reasoningEffort={globalSettings.reasoningEffort}
                onReasoningEffortChange={(value) => setGlobalSettings({ reasoningEffort: value })}
                modelControl={
                  liveModels !== null && liveModels.length > 0 ? (
                    <ModelControl
                      // The catalog's isActive row is the last conversation's
                      // model; here the choice for the next one must win.
                      models={liveModels.map((model) => ({ ...model, isActive: false }))}
                      value={globalSettings.model === "default" ? null : globalSettings.model}
                      onSelect={(modelId) => setGlobalSettings({ model: modelId })}
                      compact
                    />
                  ) : null
                }
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
                      <span title={displayPath(active.workspace)}>{displayPath(active.workspace)}</span>
                      {active.branch !== undefined && (
                        <>
                          <span>·</span>
                          <span title="Host-reported Git branch">{active.branch}</span>
                        </>
                      )}
                      <span
                        className={`connection-state connection-${activeConnectionState}`}
                        /* M0-08: the supervisor's actionable failure reason
                           (incompatible engine, spawn failure, immediate exit)
                           was previously dropped to the console on the silent
                           boot resume; the pill now explains itself. */
                        title={connectionNoticeBySession[active.session_id]}
                      >
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
                  </header>
                  {activeConnectionState !== "connected" &&
                    connectionNoticeBySession[active.session_id] !== undefined && (
                    /* M0-08: the pill's `title` is hover-only — keyboard and
                       screen-reader users never reach the reason. It is also
                       rendered here as persistent, accessible text. */
                    <p className="connection-notice" role="status">
                      {connectionNoticeBySession[active.session_id]}
                    </p>
                  )}
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
                    recoveryNotice={activeRecoveryNotice}
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
                    onSignInForFailedTurn={
                      isMacPlatform() && isTauriRuntime()
                        ? (entry) => setSignInFor({ sessionId: active.session_id, entryId: entry.id })
                        : undefined
                    }
                    onForkFromEntry={(turnId) => void forkSession(active.session_id, turnId)}
                    onOpenWorkspacePath={(path) => openWorkspacePath(active.session_id, path)}
                    controls={{
                      onClose: (agentId, reason) =>
                        void subagentClose(active.session_id, agentId, reason),
                      onReopen: (agentId) =>
                        void subagentReopen(active.session_id, agentId),
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
                    /* Host skills first: when both sides expose one name, the
                       host entry is the one the engine actually runs. */
                    slashCommands={[
                      ...(hostSkillsBySession[active.session_id] ?? []).map((skill) => ({
                        name: skill.selector,
                        description: skill.description || skill.displayName,
                        origin: "host",
                      })),
                      ...skills
                        .filter((skill) => skill.enabled)
                        .map((skill) => ({
                          name: skill.name,
                          description: skill.description,
                          origin: "workspace",
                        })),
                    ]}
                    disabled={backendMissing || active.archived === true || !connectedIds.includes(active.session_id)}
                    modelControl={
                      <>
                        <ModelControl
                          /* M1-11: the catalog's `isActive` row describes the
                             conversation it was read for. On a stale catalog
                             (an unloaded conversation refuses the per-session
                             refresh) only the per-conversation choices keep
                             meaning, so the active flag is dropped and the
                             picker falls back to this session's own model. */
                          models={
                            liveModelsSessionId === active.session_id || liveModelsSessionId === null
                              ? liveModels
                              : liveModels?.map((model) => ({ ...model, isActive: false })) ?? null
                          }
                          value={active.model_id ?? null}
                          onSelect={(modelId) => void setSessionModel(active.session_id, modelId)}
                          /* The composer sits at the bottom of the window, so the
                             popover must open upward. Without this the list rendered
                             downwards, off the viewport, and was clipped by the
                             conversation's own overflow: hidden. */
                          compact
                        />
                          <ContextMeter
                          usage={usageBySession[active.session_id] ?? null}
                          serverCompaction={serverCompactionBySession[active.session_id] ?? { status: "idle" }}
                          onCompact={() => void serverCompact(active.session_id)}
                        />
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
                          ["review", "Changes"],
                          ["terminal", "Terminal"],
                          ["files", "Files"],
                          ["browser", "Browser"],
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
                      {workPanel === "review" && (
                        <ReviewPanel
                          sessionId={active.session_id}
                          review={gitReview(active.session_id)}
                          lastTurnSnapshot={gitTurnSnapshot(active.session_id)}
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
                          sessionLoaded={sessionLoadedForSession(active.session_id)}
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
                            onInsertContext={(context) => {
                              void prepareBrowserContext(active.session_id, context);
                            }}
                          />
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
