import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/env";
import { displayPath } from "../lib/paths";
import type { StartupProbe } from "../lib/startupProbe";
export type { StartupCheck, StartupProbe } from "../lib/startupProbe";
import { loadQueuedTurns, reconcileQueuedTurns, saveQueuedTurns } from "../lib/queuedTurns";
import {
  appendLog,
  dropLog,
  dropOutbox,
  loadActiveId,
  loadGlobalSettings,
  loadGitTurnSnapshot,
  loadLog,
  loadOutbox,
  loadProjects,
  loadSessions,
  loadThreadProjects,
  loadTombstones,
  loadWorktrees,
  loadWorkspace,
  newId,
  saveActiveId,
  saveGlobalSettings,
  saveGitTurnSnapshot,
  saveLog,
  saveOutbox,
  saveProjects,
  saveSessions,
  saveThreadProjects,
  saveTombstones,
  saveWorktrees,
  saveWorkspace,
  dropGitTurnSnapshot,
  type LogEntry,
  type LogRole,
  type RichContent,
  type StoredSession,
} from "../lib/persist";
// M0-03 lossless send: outbox state machine + explicit SendResult (pure,
// unit-tested); durable per-session storage extends ../lib/persist.
import {
  createOutboxEntry,
  commandIdFromClientMessageId,
  failedOutbox,
  findOutbox,
  markFailed,
  markSending,
  recoverInterrupted,
  removeOutbox,
  sendAccepted,
  sendFailed,
  upsertOutbox,
  type OutboxEntry,
  type OutboxInputPart,
  type SendResult,
} from "../lib/outbox";
export type { OutboxEntry, SendResult } from "../lib/outbox";
import {
  createOutboxWriteQueue,
  loadNativeOutbox,
  mergeOutboxStores,
  saveNativeOutbox,
  type OutboxStore,
} from "../lib/outboxLedger";
import type { ComposerAttachment, TurnInputPart } from "../lib/attachments";
export type { TurnInputPart } from "../lib/attachments";
// Input-prompt helpers live in ../lib/input (dependency-free, unit-tested).
// Only parseInputRequest + the locally used types are imported; the rest is
// re-exported below for consumers (InputPanel).
import {
  parseInputRequest,
  type InputAnswer,
  type InputRequest,
} from "../lib/input";
// US-15 persistent approval allowlist: matching + most-restrictive-wins
// resolution live in ../lib/allowlist (dependency-free, unit-tested);
// storage + rule types extend ../lib/persist.
import {
  addAllowRule,
  defaultPatternFor,
  loadAllowlist,
  removeAllowRule,
  resolveApproval,
  saveAllowlist,
  setAllowRuleDecision,
  type AllowDecision,
  type AllowRule,
  type ResolvedApproval,
} from "../lib/allowlist";
export type { AllowDecision, AllowRule, ResolvedApproval } from "../lib/allowlist";
// US-19 in-app browser + computer-use (scoped): pure helpers, unit-tested;
// storage keys extend the muse-desktop.* localStorage namespace.
import {
  addBrowserAnnotation,
  createBrowserAnnotation,
  browserCaptureAttachment,
  formatBrowserCaptureContext,
  loadBrowserAnnotations,
  loadBrowserPermissions,
  removeBrowserAnnotation,
  saveBrowserAnnotations,
  saveBrowserPermissions,
  setBrowserAppPermission,
  type BrowserAnnotation,
  type BrowserAppPermission,
  type BrowserCapture,
  type BrowserElementAnchor,
} from "../lib/browserAnnotate";
import {
  desktopCaptureAttachment,
  formatDesktopCaptureContext,
  type DesktopCapture,
} from "../lib/desktopControl";
export type {
  BrowserAnnotation,
  BrowserAppPermission,
  BrowserCapture,
  BrowserElementAnchor,
} from "../lib/browserAnnotate";
export type { MemoryEntry } from "../lib/memory";
export type {
  InputAnswer,
  InputOption,
  InputPicks,
  InputQuestion,
  InputRequest,
} from "../lib/input";
export { buildAnswers, parseInputRequest } from "../lib/input";
// Serialized poll chain: the periodic tick and the immediate post-send kick
// share it so two drains never overlap with the same cursor (overlap would
// deliver the same buffered events twice and duplicate streamed text).
import { createPollChain, enqueuePoll } from "../lib/poll";
// US-10 reflexive phase: kind→phase mapping + placeholder entries, so the
// stream shows "thinking…" synchronously on send and on `item/started`
// even before the first delta lands.
import {
  applyItemSnapshotUpdate,
  dropEmptyPlaceholders,
  isItemStartKind,
  itemSnapshotIsTerminal,
  itemSnapshotLane,
  isRunningKind,
  isStoppedKind,
  isSubagentItemKind,
  isInternalSubagentItemKind,
  isThinkingItemKind,
  upsertReflexivePlaceholder,
} from "../lib/phase";
// Sub-agent payload parsing/formatting (US-6 controls): pure, unit-tested.
import {
  formatDrilldown,
  formatSubagentResult,
  isTerminalSubagentStatus,
  parseSubagentPayload,
} from "../lib/subagent";
// US-4 compaction: local extractive summaries + server context gesture.
// Entry counts drive the recap UI; the host `session/contextUsage` triple
// drives the occupancy display + server-gesture suggestion (see compact.ts).
import {
  buildSummary,
  COMPACT_AUTO_ENTRIES,
  dropSummary,
  formatSummaryText,
  isCompactCommand,
  loadSummary,
  parseContextUsage,
  parseTokenUsage,
  saveSummary,
  type ContextUsage,
  type ServerCompactionState,
  type ThreadSummary,
} from "../lib/compact";
import {
  engineErrorSummary,
  findRetryPrompt,
  parseTurnCompletion,
  type EngineErrorDetails,
  type TurnCompletionDetails,
} from "../lib/engineError";
import { statusLogText } from "../lib/statusLog";
// Boot auto-resume candidate selection (pure, unit-tested): which stored
// sessions need a silent `resume_session` after `restore_sessions` settles.
import { selectResumeOnOpen } from "../lib/bootResume";
import {
  parseRetryScheduled,
  resumeRecoveryDelay,
  shouldAcceptRetryScheduled,
  type RetryScheduled,
  type StreamRecoveryNotice,
} from "../lib/streamHealth";
// US-7 fan-out: `/fanout` becomes one parent-turn prompt (no spawn
// endpoint exists); children surface as `subagent` entries as usual.
import {
  buildFanoutPrompt,
  fanoutQueueNote,
  parseFanoutCommand,
} from "../lib/fanout";
// US-5 thread archiving flag helper (pure, unit-tested).
import {
  moveThread as moveThreadRow,
  withArchivedFlag,
  withPinnedFlag,
  withUnreadFlag,
} from "../lib/threads";
// US-3 + US-30 Projects: create/attach/settings-override live in
// ../lib/projects (dependency-free, unit-tested).
import {
  attachThread as attachThreadRow,
  createProject as createProjectRow,
  DEFAULT_PROJECT_SETTINGS,
  deleteProject as deleteProjectRow,
  resolveProjectSettings,
  setProjectOverride as setProjectOverrideRow,
  updateProject as updateProjectRow,
  settingsForThread,
  type Project,
  type ProjectSettings,
  type ThreadProjectMap,
} from "../lib/projects";
import {
  validateSetupCommand,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeInspection,
  type WorktreeSetupResult,
  type WorktreeReadiness,
} from "../lib/worktrees";
import {
  clearWorktreeCleanup,
  loadWorktreeCleanupIntents,
  markWorktreeCleanupFailed,
  requestWorktreeCleanup,
  saveWorktreeCleanupIntents,
  type WorktreeCleanupIntent,
} from "../lib/worktreeCleanup";
export type {
  Project,
  ProjectSettings,
  ProjectSettingsOverride,
  ThreadProjectMap,
} from "../lib/projects";
export {
  DEFAULT_PROJECT_SETTINGS,
  diffProjectSettings,
  resolveProjectSettings,
  settingsForThread,
} from "../lib/projects";
// US-9 automations/scheduled + review queue: pure schedule logic (cron,
// due → review enqueue, approve/discard, target resolution). No workflow/*
// MSP endpoint exists, so scheduling is a client-side timer (see the
// automation effect below) + persisted state — due entries never auto-send.
import {
  approveReview,
  buildSchedule,
  discardReview,
  enqueueDue,
  enqueueRunNow,
  loadReviewQueue,
  loadSchedules,
  MAX_SCHEDULES,
  pendingReviews,
  resolveReviewTarget,
  saveReviewQueue,
  saveSchedules,
  setScheduleEnabled,
  deleteSchedule as removeSchedule,
  validateScheduleInput,
  type ReviewItem,
  type Schedule,
  type ScheduleInput,
} from "../lib/schedules";
export type { ReviewItem, Schedule, ScheduleInput, ThreadReuse } from "../lib/schedules";
import {
  archiveRun,
  appendRun,
  cancelRun,
  completeRun,
  createScheduleRun,
  isRetryableScheduleError,
  loadScheduleRuns,
  markRecoveredRunFailed,
  markRunStarted,
  markRunRead,
  queueRunRetry,
  recoverScheduleRuns,
  restoreRun,
  retryRunNow,
  saveScheduleRuns,
  settleRunsForSession,
  settleRun,
  mergeScheduleRuns,
  type ScheduleRun,
} from "../lib/scheduleRuns";
export type { ScheduleRun, ScheduleRunStatus } from "../lib/scheduleRuns";
import { loadNativeScheduleRuns, saveNativeScheduleRuns } from "../lib/scheduleRunLedger";
import { loadNativeSchedules, mergeSchedules, saveNativeSchedules } from "../lib/scheduleLedger";
import {
  createSchedulerWakeupQueue,
  INITIAL_SCHEDULER_WAKEUP_STATUS,
  nextSchedulerWakeAt,
  syncNativeSchedulerWakeup,
  type SchedulerWakeupStatus,
} from "../lib/schedulerWakeup";
import { buildScheduleRunSummary, mergeScheduleRunSummary } from "../lib/runSummary";
export type { ScheduleRunSummary } from "../lib/runSummary";
import {
  INITIAL_SCHEDULER_RUNTIME_STATUS,
  releaseSchedulerLease,
  releaseNativeSchedulerLease,
  renewSchedulerLease,
  renewNativeSchedulerLease,
  schedulerRuntimeErrorStatus,
  schedulerRuntimeStatusFromProbe,
  tryAcquireSchedulerLease,
  tryAcquireNativeSchedulerLease,
  type SchedulerRuntimeStatus,
} from "../lib/schedulerLease";
import {
  appendNotification,
  buildApprovalNotification,
  buildInputNotification,
  buildRunNotification,
  deliverDesktopNotification,
  loadNotifications,
  loadNotificationPreferences,
  mergeNotifications,
  markNotificationRead as markNotificationReadRow,
  markAllNotificationsRead as markAllNotificationsReadRows,
  notificationPermission as readNotificationPermission,
  requestNotificationPermission,
  saveNotificationPreferences,
  saveNotifications,
  unreadNotificationCount as countUnreadNotifications,
  type MuseNotification,
  type NotificationPermission,
} from "../lib/notifications";
export type { MuseNotification, NotificationPermission } from "../lib/notifications";
import {
  createNotificationWriteQueue,
  loadNativeNotifications,
  saveNativeNotifications,
} from "../lib/notificationLedger";
import { createLatestWriteQueue } from "../lib/writeQueue";
// US-12 + US-21 versioned artifacts + thread recap: extraction, versioning
// and per-thread persistence live in ../lib/artifacts (dependency-free,
// unit-tested); restore reuses the US-4 composer prefill below.
import {
  dropArtifacts,
  editArtifactVersion,
  findVersionText,
  loadArtifacts,
  mergeAssistantBlocks,
  saveArtifacts,
  setVersionComment,
  type Artifact,
} from "../lib/artifacts";
// w-settings (US-16 sandbox + US-31 providers): pure settings helpers
// (dependency-free, unit-tested); scope-guard client for the path probe.
import {
  hostSandboxConfigForProject,
  effectiveSandboxMode,
  PROVIDER_MAP_KEY,
  SETTINGS_KEY,
  parseModelList,
  parseProviderId,
  parseProviderMap,
  parseSandboxSettings,
  providerForProject,
  type LiveModel,
  type SandboxSettings,
} from "../lib/settings";
import {
  AUTHORIZATION_MODE_KEY,
  automaticApprovalChoice,
  authorizationModeLabel,
  hostApprovalMode,
  hostModeMatches,
  parseAuthorizationMode,
  productAuthorizationMode,
  type AuthorizationMode,
} from "../lib/authorization";
import {
  isSelectedApprovalAccepted,
  parseApprovalResolution,
  shouldCloseApprovalLane,
} from "../lib/approvalResolution";
import { checkScope, type ScopeVerdict } from "../lib/scope";
import { readStorageJson, readStorageString, writeStorageJson, writeStorageString } from "../lib/storage.ts";
import { reconnectErrorMessage, userFacingError } from "../lib/errorCopy";
import { forkFailureMessage } from "../lib/fork";
// w-integrations (US-24/US-26): curated connector directory + remote guard
// (pure, unit-tested). Hot-listing re-reads the registry, no restart.
import {
  findConnector,
  installConnector,
  listConnectorTools,
  loadConnectors,
  localConnectorIdForName,
  registerLocalConnector,
  rollbackLocalConnector,
  refreshLocalConnector,
  requestRemoteConnector,
  registerRemoteConnector,
  saveConnectors,
  setConnectorEnabled,
  setConnectorUseInMuse,
  uninstallConnector,
  type ConnectorEntry,
  type LocalMcpCallResult,
  type LocalMcpProbeResult,
  type ConnectorTool,
} from "../lib/connectors";
import {
  buildMcpPackageCommand,
  parseMcpbArchive,
  type ParsedMcpPackage,
} from "../lib/mcpPackage.ts";
import { buildHostMcpServers, type HostMcpStdioServer } from "../lib/hostMcp";
import {
  parseComputerStatus,
  type ComputerLevel,
  type ComputerStatus,
} from "../lib/computerUse";
import {
  callRemoteMcp as callRemoteMcpTransport,
  isRemoteMcpAuthenticationError,
  probeRemoteMcp as probeRemoteMcpTransport,
  remoteMcpCredentialKey,
  type RemoteMcpCallResult,
  type RemoteMcpProbeResult,
  type RemoteMcpSession,
} from "../lib/remoteMcp.ts";
// w-integrations (US-25): slash-invokable + auto-suggested skills with
// progressive disclosure (pure, unit-tested).
import {
  buildSkillInvocation,
  formatSkillInvokeTrace,
  formatSkillTrace,
  loadSkills,
  mergeBuiltinSkills,
  parseSkillCommand,
  resolveSkill,
  saveSkills,
  setSkillEnabled,
  suggestSkills,
  type Skill,
  type SkillInvocationProgress,
  type SkillResourceContext,
  type SkillSuggestion,
} from "../lib/skills";
import {
  findHostSkill,
  parseHostSkills,
  type HostSkill,
} from "../lib/hostSkills";
import {
  dedupeDiscoveredSkills,
  parseSkillDocuments,
  type RawSkillDocument,
  type SkillScanSummary,
} from "../lib/skillDiscovery";
// w-collab (US-27/US-28): share bundles + modes + channel stub (pure,
// unit-tested). `shareThread` is aliased: the hook exposes `shareSession`.
import {
  emptyShareState,
  listSessionBundles,
  loadShareState,
  revokeBundle,
  saveShareState,
  setShareMode as setShareModePure,
  shareThread as createShareBundle,
  shouldAutoShare,
  type BundleFormat,
  type ShareBundle,
  type ShareMode,
  type ShareState,
} from "../lib/sharing";
// w-collab (US-34): CLI/IDE config import (pure, unit-tested). Import-only:
// merges never overwrite live sessions or existing imported rows.
import {
  dismissImportedSession,
  loadImportedSessions,
  mergeImportedSessions,
  parseImportPayload,
  saveImportedSessions,
  type ResumableSession,
} from "../lib/importConfig";
// US-23 opt-in local index: line parsers + mtime rescan + search live in
// ../lib/indexer (dependency-free, unit-tested); the hook only owns state,
// folder-pick reading, and localStorage write-through.
import {
  buildIndex,
  dropIndexData,
  indexStats,
  loadIndexData,
  loadIndexEnabled,
  MAX_INDEX_FILES,
  normalizePath,
  parseGitignore,
  rescanIndex,
  saveIndexData,
  saveIndexEnabled,
  searchIndex,
  shouldIndexPath,
  type FileSnapshot,
  type IndexStore,
  type LineHit,
} from "../lib/indexer";
export type { LineHit } from "../lib/indexer";
// US-20 memory + anti-drift: dated/sourced entries, stale warnings, SCAN
// nudge (pure, unit-tested); storage extends the muse-desktop.* keys.
import {
  addMemory,
  buildScanNudge,
  loadLastScan,
  loadMemories,
  removeMemory,
  saveLastScan,
  saveMemories,
  shouldScanNudge,
  type MemoryEntry,
} from "../lib/memory";
import {
  EMPTY_GIT_REVIEW,
  type GitCommitResult,
  type GitMutationExpectation,
  type GitDiffScope,
  type GitDiffSnapshot,
  type GitPrResult,
  type GitPushResult,
  type GitReviewState,
  type GitStatusSnapshot,
  type GitTurnSnapshot,
} from "../lib/git";
import { formatTerminalContext } from "../lib/terminalContext";
import { formatWorkspaceFileContext } from "../lib/fileContext";
import {
  extractHistoryItems,
  historyEventsToLogEntries,
  historyItemsToLogEntries,
  mergeHistoryLog,
} from "../lib/history";
import { parseBranchObservation } from "../lib/branch";
import { parseStreamChunk } from "../lib/streamChunks";

const GIT_STATUS_CAPTURE_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("operation timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}


/** One session: persisted metadata + live running flag. */
export interface MuseSession extends StoredSession {
  running: boolean;
}

function isEphemeralSession(session: MuseSession | null | undefined): boolean {
  return session?.session_durability?.toLowerCase() === "ephemeral";
}

/** M0-02: renderer-owned connection state for a session identity. */
export type SessionConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** US-23 local index surface (opt-in, default off). */
export interface IndexApi {
  enabled: boolean;
  paused: boolean;
  fileCount: number;
  lineCount: number;
  builtAt: number | null;
  lastSummary: string | null;
  /** True once a folder was picked, so Rescan/Rebuild have a source. */
  hasSource: boolean;
  query: string;
  results: LineHit[];
  setIndexEnabled: (on: boolean) => void;
  setIndexPaused: (paused: boolean) => void;
  indexPickedFiles: (files: FileList | File[]) => Promise<void>;
  rescanIndexFiles: () => Promise<void>;
  rebuildIndex: () => Promise<void>;
  deleteIndex: () => void;
  setIndexQuery: (q: string) => void;
}

export type {
  GitDiffScope,
  GitDiffSnapshot,
  GitReviewState,
  GitStatusSnapshot,
  GitTurnSnapshot,
} from "../lib/git";

/** M1-05: persistent terminal session owned by a conversation workspace. */
export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  cwd: string;
  shell: string;
  generation: number;
  cols: number;
  rows: number;
}

export interface TerminalState {
  info: TerminalInfo;
  output: string;
  done: boolean;
}

/** M1-07: real filesystem browser state, kept per conversation. */
export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: "directory" | "file" | "symlink";
  size: number | null;
  modifiedAt: number | null;
  accessible: boolean;
}

export interface FileReadResult {
  path: string;
  size: number;
  modifiedAt: number | null;
  binary: boolean;
  content: string | null;
  mediaType?: string | null;
  base64Data?: string | null;
  truncated: boolean;
  observedAt: number;
}

export interface FilesBrowserState {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  selectedPath: string | null;
  preview: FileReadResult | null;
  loading: boolean;
  error: string | null;
  observedAt: number | null;
  stale: boolean;
  changedPaths: string[];
}

function emptyFilesBrowserState(): FilesBrowserState {
  return {
    path: "",
    entries: [],
    truncated: false,
    selectedPath: null,
    preview: null,
    loading: false,
    error: null,
    observedAt: null,
    stale: false,
    changedPaths: [],
  };
}

/** Keep attachment parts aligned with the expanded text sent to the host. */
function inputPartsWithText(text: string, parts?: TurnInputPart[]): OutboxInputPart[] {
  const source = parts ?? (text.trim().length > 0 ? [{ type: "text", text }] : []);
  const next: OutboxInputPart[] = source.map((part) =>
    part.type === "text" ? { ...part } : { ...part },
  );
  const firstText = next.findIndex((part) => part.type === "text");
  if (firstText >= 0) {
    const part = next[firstText];
    if (part.type === "text") next[firstText] = { ...part, text };
  } else if (text.trim().length > 0) {
    next.unshift({ type: "text", text });
  }
  return next;
}

type FileWithRelPath = File & { webkitRelativePath?: string };

/**
 * Directory-input path → workspace-relative path. The input prefixes every
 * file with the picked top folder (`root/src/a.ts`); that root is dropped.
 */
function indexRelPath(f: File): string {
  const w = f as FileWithRelPath;
  const raw =
    w.webkitRelativePath !== undefined && w.webkitRelativePath.length > 0
      ? w.webkitRelativePath
      : f.name;
  const norm = normalizePath(raw);
  const slash = norm.indexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

/**
 * Read one folder pick into snapshots: the root .gitignore is read first
 * so eligibility uses it, then only eligible files are read (capped), so a
 * huge folder pick stays bounded.
 */
async function readIndexSnapshots(
  files: File[],
): Promise<{ snapshots: FileSnapshot[]; patterns: string[] }> {
  let gitText = "";
  for (const f of files) {
    if (indexRelPath(f) === ".gitignore") {
      try {
        gitText = await f.text();
      } catch {
        gitText = "";
      }
      break;
    }
  }
  const patterns = parseGitignore(gitText);
  const eligible = files
    .filter((f) => shouldIndexPath(indexRelPath(f), patterns))
    .slice(0, MAX_INDEX_FILES);
  const snapshots: FileSnapshot[] = [];
  for (const f of eligible) {
    try {
      snapshots.push({
        path: indexRelPath(f),
        mtimeMs: f.lastModified,
        content: await f.text(),
      });
    } catch {
      // Skip unreadable files; the rest still index.
    }
  }
  return { snapshots, patterns };
}

/** Raw event relayed by the Rust supervisor (always tagged by session_id). */
export interface MuseEvent {
  session_id: string;
  kind: string;
  payload: string;
}

/** Latest host event observed for one session (live only, never persisted). */
export interface StreamActivity {
  lastEventAt: number;
  lastEventKind: string;
}

/** A user decision was accepted and the host has not emitted its next turn event yet. */
export interface ResumePending {
  requestedAt: number;
  source: "approval" | "input";
}

/** Latest bounded terminal result supplied by the host for each session. */
export type SessionTurnCompletion = TurnCompletionDetails;

/** One buffered backend event with its sequence number (poll transport). */
interface DrainedEvent extends MuseEvent {
  seq: number;
}

interface PollResult {
  head: number;
  oldest?: number | null;
  truncated?: boolean;
  events: DrainedEvent[];
}

/**
 * Poll cadence: fast while a turn streams (near-live text), slow at idle.
 * The host emits line-frames as they arrive; 150ms keeps chunking invisible.
 */
const POLL_FAST_MS = 150;
const POLL_SLOW_MS = 1000;

export interface ApprovalChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
}


export interface ApprovalRequest {
  session_id: string;
  request_id: string;
  summary: string;
  toolName: string;
  choices: ApprovalChoice[];
}

/** One bounded chunk returned by the host's lazy item output reader. */
export interface ItemOutputChunk {
  content: string;
  /** Base64 bytes when the host marks the output as binary. */
  base64Data?: string;
  offsetBytes: number;
  nextOffsetBytes: number;
  byteLen: number;
  eof: boolean;
  mediaType?: string;
}

/** A turn admitted to the host queue and still reclaimable. */
export interface QueuedTurn {
  session_id: string;
  turn_id: string;
  text: string;
  createdAt: number;
  /** Present only after hydration; the host queue was not snapshotted. */
  recovered?: boolean;
}

interface UseMuseSessions {
  sessions: MuseSession[];
  activeId: string | null;
  logs: Record<string, LogEntry[]>;
  activeLog: LogEntry[];
  approvals: ApprovalRequest[];
  activeApprovals: ApprovalRequest[];
  /** M0-02: latest live event used to explain quiet/stalled turns. */
  streamActivityBySession: Record<string, StreamActivity>;
  activeStreamActivity: StreamActivity | null;
  /** M0-02: bounded recovery outcome shown next to stale/resuming liveness. */
  recoveryNoticeBySession: Record<string, StreamRecoveryNotice>;
  activeRecoveryNotice: StreamRecoveryNotice | null;
  /** M0-02/M0-05: explicit bridge state after a permission or input decision. */
  resumePendingBySession: Record<string, ResumePending>;
  activeResumePending: ResumePending | null;
  /** Host-provided retry backoff, kept live beside the conversation stream. */
  retryScheduledBySession: Record<string, RetryScheduled>;
  activeRetryScheduled: RetryScheduled | null;
  /** M2-08: host-authored terminal result, when the protocol provides one. */
  turnCompletionBySession: Record<string, SessionTurnCompletion>;
  /** M0-04: cancellation accepted by the host, awaiting terminal status. */
  stoppingBySession: Record<string, boolean>;
  /** M0-02: connection lifecycle, separate from turn execution state. */
  connectionBySession: Record<string, SessionConnectionState>;
  activeConnectionState: SessionConnectionState;
  /** M1-10: queued turns that can still be reclaimed before launch. */
  queuedTurns: QueuedTurn[];
  /** Remove a restored queue reminder locally without claiming host state. */
  dismissQueuedTurn: (sessionId: string, turnId: string) => void;
  /** Default folder for new threads (persisted); each thread keeps its own. */
  workspace: string | null;
  /** Change the default folder for new threads (not a global lock). */
  setWorkspace: (path: string) => void;
  setActive: (id: string | null) => void;
  /** w-settings: sandbox settings (persisted) + whole-object setter. */
  sandbox: SandboxSettings;
  setSandbox: (next: SandboxSettings) => void;
  /** M2-02: explicitly restart the workspace host after a posture change. */
  restartHost: (workspacePath?: string | null) => Promise<boolean>;
  /** Global tool-authorization posture (persisted locally). */
  authorizationMode: AuthorizationMode;
  setAuthorizationMode: (mode: AuthorizationMode) => void;
  /** w-settings: provider id selected for the current project. */
  providerId: string;
  /** w-settings: persist the provider selection for the current project. */
  setProviderId: (id: string) => void;
  /** US-31: live host catalog (`model/list` snapshot), null when unloaded. */
  liveModels: LiveModel[] | null;
  /** US-31: last catalog load failure (panel shows it, picker falls back). */
  modelsError: string | null;
  /** US-31: (re)load the catalog, optionally flagging one session active. */
  refreshModels: (sessionId?: string) => Promise<void>;
  /** US-31: model-picker gesture on one session, then reload the catalog. */
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  /** Host-backed reasoning picker for one session. */
  setSessionReasoningEffort: (
    sessionId: string,
    reasoningEffort: ProjectSettings["reasoningEffort"],
  ) => Promise<boolean>;
  /** w-settings: route a path through the scope-guard prompt path. */
  checkPathScope: (path: string) => Promise<ScopeVerdict>;
  /** M2-03: create a real Git worktree from a validated orchestration plan. */
  createWorktree: (
    sessionId: string,
    plan: WorktreePlan,
  ) => Promise<WorktreeRecord | null>;
  /** M2-03: atomically create a worktree and open its conversation. */
  createWorktreeSession: (
    sessionId: string,
    plan: WorktreePlan,
    projectSettings?: ProjectSettings,
  ) => Promise<WorktreeRecord | null>;
  worktrees: WorktreeRecord[];
  /** Explicit cleanup attempts that need a retry after an interruption. */
  cleanupIntents: WorktreeCleanupIntent[];
  /** Remove one managed worktree after explicit user confirmation in the UI. */
  /** Creates the worktree a conversation will start in, before it exists. */
  createWorktreeForWorkspace: (
    workspace: string,
    plan: WorktreePlan,
  ) => Promise<WorktreeRecord | null>;
  removeWorktree: (sessionId: string, record: WorktreeRecord) => Promise<boolean>;
  /** M2-06: inspect one worktree before cleanup or handoff. */
  inspectWorktree: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<WorktreeInspection | null>;
  /** M2-04: inspect local manifests and required executables without running code. */
  checkWorktreeReadiness: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<WorktreeReadiness | null>;
  /** M2-04: run one user-entered setup command in an existing managed worktree. */
  runWorktreeSetup: (
    sessionId: string,
    record: WorktreeRecord,
    command: string,
    envAllowlist: string[],
  ) => Promise<WorktreeSetupResult | null>;
  /** M2-04: request cancellation of the active setup process, if any. */
  cancelWorktreeSetup: (sessionId: string, record: WorktreeRecord) => Promise<boolean>;
  startSession: () => Promise<string | null>;
  startSessionInWorkspace: (
    workspacePath: string,
    projectSettings?: ProjectSettings,
    projectId?: string,
  ) => Promise<string | null>;
  /** M1-09: create a server-side branch from completed conversation turns. */
  /** Fork at the latest completed turn, or at an explicit MSP turn anchor. */
  forkSession: (sessionId: string, lastTurnId?: string) => Promise<string | null>;
  reconnectSession: (id: string, options?: { silent?: boolean }) => Promise<void>;
  reconnectingId: string | null;
  /** M0-02: reconcile durable history and pending actions without a restart. */
  reconcileSession: (id: string, options?: { silent?: boolean }) => Promise<void>;
  reconcilingId: string | null;
  connectedIds: string[];
  /** M1-06: capability negotiated with each workspace host. */
  userShellAvailableForSession: (sessionId: string) => boolean;
  /** M1-06: whether the host has this conversation loaded; `undefined` = unreported. */
  sessionLoadedForSession: (sessionId: string) => boolean | undefined;
  /**
   * M0-03: send one turn and get an explicit result. `retryKey` re-sends
   * an existing outbox entry (same clientMessageId, byte-identical
   * expansion). ok=true means the supervisor acknowledged admission — the
   * draft may be cleared; ok=false leaves the text recoverable.
   */
  sendInput: (
    sessionId: string,
    text: string,
    retryKey?: string,
    inputParts?: TurnInputPart[],
  ) => Promise<SendResult>;
  /** M1-10: inject guidance into the currently running turn. */
  steerInput: (
    sessionId: string,
    text: string,
    inputParts?: TurnInputPart[],
  ) => Promise<SendResult>;
  /** Reclaim one queued turn; never interrupts a running turn. */
  unqueueTurn: (sessionId: string, turnId: string) => Promise<boolean>;
  /** Failed outgoing messages across sessions (retryable, durable). */
  pendingSends: OutboxEntry[];
  /** Re-send a failed entry: verifies the server first when ambiguous. */
  retrySend: (clientMessageId: string) => Promise<void>;
  /** M0-07: retry a terminally failed turn from its last user message. */
  retryFailedTurn: (sessionId: string, failureEntryId: string) => Promise<void>;
  /** Give up on a failed entry: drops it and its undelivered user entry. */
  discardSend: (clientMessageId: string) => void;
  approve: (sessionId: string, approvalId: string, choiceId: string) => Promise<boolean>;
  /** US-15: persisted allowlist rules + effective decision per request. */
  allowlist: AllowRule[];
  allowDecisionFor: (approval: ApprovalRequest) => ResolvedApproval;
  /** Approve, then memorize an allow rule (command pattern + choice scope). */
  rememberApproval: (approval: ApprovalRequest, choiceId: string) => Promise<void>;
  revokeAllowRule: (id: string) => void;
  setAllowRuleDecision: (id: string, decision: AllowDecision) => void;
  answerInput: (sessionId: string, inputId: string, answers: InputAnswer[]) => Promise<void>;
  cancelInput: (sessionId: string, inputId: string) => Promise<void>;
  inputRequests: InputRequest[];
  activeInputRequests: InputRequest[];
  cancelSession: (sessionId: string) => Promise<void>;
  killSession: (sessionId: string) => Promise<void>;
  /** US-4: summaries by source session id (a stored summary = compacted). */
  summaries: Record<string, ThreadSummary>;
  /** US-4: build the local summary now (`/compact` manual path / button). */
  compactSession: (sessionId: string) => void;
  /** US-4: open a fresh thread pre-filled with the source summary. */
  newFromSummary: (sourceId: string) => Promise<void>;
  /** US-4: prefill text for the composer after `newFromSummary`. */
  prefill: string | null;
  /** Put an explicit user-editable note into the active composer. */
  prefillComposer: (text: string) => void;
  clearPrefill: () => void;
  /** M4-02: one captured browser image waiting for the active composer. */
  prefillAttachment: ComposerAttachment | null;
  prefillAttachmentSessionId: string | null;
  clearPrefillAttachment: () => void;
  /** US-4: host occupancy per session (`session/contextUsage` triple). */
  usageBySession: Record<string, ContextUsage>;
  /** US-4: renderer-only lifecycle for the host compaction gesture. */
  serverCompactionBySession: Record<string, ServerCompactionState>;
  /** US-4: server context gesture (`session/compact`), user-clicked only. */
  serverCompact: (sessionId: string) => Promise<void>;
  /** US-12 + US-21: versioned artifacts per thread (extracted blocks). */
  artifacts: Record<string, Artifact[]>;
  /** US-21: 1-click restore — copy the version text via US-4 prefill. */
  restoreArtifact: (sessionId: string, artifactId: string, v: number) => void;
  /** US-21: anchored per-version comment (persisted). */
  commentArtifact: (sessionId: string, artifactId: string, v: number, comment: string, anchorQuote?: string) => void;
  /** Save a local artifact edit as the next version, preserving history. */
  editArtifact: (sessionId: string, artifactId: string, v: number, text: string) => void;
  /** US-23 opt-in local index (panel state + folder-pick indexing). */
  index: IndexApi;
  /** M1-01/M1-03: Git status/diff snapshots and guarded Review mutations. */
  gitReview: (sessionId: string) => GitReviewState;
  /** M1-01: explicit Git baseline captured before the latest logical turn. */
  gitTurnSnapshot: (sessionId: string) => GitTurnSnapshot | null;
  refreshGitStatus: (sessionId: string) => Promise<GitStatusSnapshot | null>;
  loadGitDiff: (
    sessionId: string,
    scope: GitDiffScope,
    baseRef?: string,
  ) => Promise<GitDiffSnapshot | null>;
  stageGitFiles: (
    sessionId: string,
    paths: string[],
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  restoreGitFiles: (
    sessionId: string,
    paths: string[],
    scope: "staged" | "unstaged",
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  applyGitHunk: (
    sessionId: string,
    path: string,
    scope: "staged" | "unstaged",
    action: "stage" | "unstage" | "discard",
    hunkHeader: string,
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  commitGit: (
    sessionId: string,
    message: string,
    expected: GitMutationExpectation,
  ) => Promise<GitCommitResult | null>;
  /** M1-04: synchronize one explicit remote without guessing a destination. */
  fetchGit: (sessionId: string, remote: string) => Promise<GitStatusSnapshot | null>;
  /** M1-04: fast-forward the current branch from an explicit remote branch. */
  pullGit: (
    sessionId: string,
    remote: string,
    branch: string,
    expectedHead: string | null,
    expectedStatus: string | null,
  ) => Promise<GitStatusSnapshot | null>;
  pushGit: (
    sessionId: string,
    remote: string,
    branch: string,
    expectedHead: string | null,
  ) => Promise<GitPushResult | null>;
  createGitPr: (
    sessionId: string,
    title: string,
    body: string,
    base: string,
    head: string,
  ) => Promise<GitPrResult | null>;
  /** M1-05: persistent PTY controls; closing the panel leaves it alive. */
  terminalForSession: (sessionId: string) => TerminalState | null;
  openTerminal: (sessionId: string, cols?: number, rows?: number) => Promise<TerminalInfo | null>;
  readTerminal: (terminalId: string) => Promise<void>;
  writeTerminal: (terminalId: string, input: string) => Promise<void>;
  /** M1-06: run one explicit command through MSP's user-shell lane. */
  runUserShell: (sessionId: string, command: string) => Promise<boolean>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (sessionId: string) => Promise<void>;
  /** Add a bounded, attributed terminal snapshot to the next prompt. */
  prepareTerminalContext: (sessionId: string) => boolean;
  /** M1-07: session-scoped real filesystem listing and bounded preview. */
  filesForSession: (sessionId: string) => FilesBrowserState;
  /** M1-07: insert the current text-file preview into the composer draft. */
  prepareWorkspaceFileContext: (sessionId: string) => boolean;
  listWorkspaceFiles: (sessionId: string, path?: string) => Promise<void>;
  readWorkspaceFile: (sessionId: string, path: string) => Promise<void>;
  watchWorkspaceFiles: (sessionId: string) => Promise<void>;
  unwatchWorkspaceFiles: (sessionId: string) => Promise<void>;
  /** M1-07: open a verified workspace entry in the system handler. */
  openWorkspacePath: (sessionId: string, path: string) => Promise<void>;
  /** US-5: move a thread to the archived list (persisted flag). */
  renameSession: (sessionId: string, title: string) => void;
  archiveSession: (sessionId: string) => void;
  togglePinned: (sessionId: string) => void;
  moveConversation: (sessionId: string, direction: -1 | 1) => void;
  /** US-5: move a thread back to the active list (persisted flag). */
  restoreSession: (sessionId: string) => void;
  /** US-3: project list (creation refused past 5, see projectError). */
  projects: Project[];
  threadProjects: ThreadProjectMap;
  /** Last project refusal (quota / blank name); null when clean. */
  projectError: string | null;
  /** Creates a project and returns it, so a caller can select it at once. */
  createProject: (name: string, workspaces?: string[]) => Project | null;
  /** Delete a project; its threads become ungrouped (no orphans). */
  deleteProject: (id: string) => void;
  updateProject: (id: string, patch: { name?: string; instructions?: string; workspace?: string; workspaces?: string[] }) => void;
  /** Attach a thread to a project (null detaches). */
  attachThread: (sessionId: string, projectId: string | null) => void;
  /** Project a thread is attached to (null = ungrouped/unknown). */
  projectForSession: (sessionId: string) => Project | null;
  /** US-30: global defaults + per-project overrides (inherit + diff). */
  globalSettings: ProjectSettings;
  setGlobalSettings: (patch: Partial<ProjectSettings>) => void;
  setProjectOverride: (
    projectId: string,
    key: keyof ProjectSettings,
    value: ProjectSettings[keyof ProjectSettings] | undefined,
  ) => void;
  /** Effective settings for a project (null = global as-is). */
  settingsFor: (projectId: string | null) => ProjectSettings;
  /** US-9: automation schedules (all) + pending review entries. */
  schedules: Schedule[];
  reviewQueue: ReviewItem[];
  /** M3-06: durable scheduled execution records. */
  scheduleRuns: ScheduleRun[];
  /** M3-07: live lease ownership shown by the Automations surface. */
  schedulerStatus: SchedulerRuntimeStatus;
  /** M3-07: native one-shot wake-up status for the next schedule. */
  schedulerWakeupStatus: SchedulerWakeupStatus;
  /** US-9: validate + append a schedule; returns the id, null on error. */
  createSchedule: (input: ScheduleInput) => string | null;
  /** US-9: enable/disable one schedule. */
  setScheduleEnabled: (id: string, enabled: boolean) => void;
  /** US-9: delete one schedule. */
  deleteSchedule: (id: string) => void;
  /** US-9: enqueue a review entry for one schedule immediately. */
  runScheduleNow: (id: string) => void;
  /** M3-07: cancel a queued retry without touching an in-flight host turn. */
  cancelScheduleRun: (id: string) => void;
  /** M3-07: explicitly reconcile a row recovered after an app restart. */
  markScheduleRunRecoveryFailed: (id: string) => void;
  /** M3-08: clear the independent inbox unread marker. */
  markScheduleRunRead: (id: string) => void;
  /** M3-08: archive or restore a run in the inbox. */
  setScheduleRunArchived: (id: string, archived: boolean) => void;
  /** M3-08: promote a failed/delayed retry to the local scheduler now. */
  retryScheduleRunNow: (id: string) => void;
  /** M3-09: durable completion/failure notifications for scheduled runs. */
  notifications: MuseNotification[];
  notificationPermission: NotificationPermission;
  notificationsMuted: boolean;
  unreadNotificationCount: number;
  enableNotifications: () => Promise<NotificationPermission>;
  setNotificationsMuted: (muted: boolean) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  /** US-9: approve a review entry → sent as normal turn input. */
  approveReview: (id: string) => Promise<void>;
  /** US-9: discard a pending review entry. */
  discardReview: (id: string) => void;
  /** w-collab US-27: share mode + bundles for one session (newest first). */
  shareMode: ShareMode;
  setShareMode: (mode: ShareMode) => void;
  sessionBundles: (sessionId: string) => ShareBundle[];
  /** Snapshot the thread log into a bundle (null when disabled/empty). */
  shareSession: (sessionId: string, format: BundleFormat) => ShareBundle | null;
  /** Un-share: revoke the bundle locally (its link then 404s). */
  unshareBundle: (bundleId: string) => void;
  /** w-collab US-28: channel stub flag (off) — never connected. */
  channelsExperimental: boolean;
  /** w-collab US-34: resumable sessions surfaced by config imports. */
  importedSessions: ResumableSession[];
  importNotes: string[];
  importConfigText: (source: string, content: string) => void;
  dismissImport: (id: string) => void;
  /** US-19: anchored page comments (URL + selection, persisted). */
  browserAnnotations: BrowserAnnotation[];
  /** US-19: anchor a comment to a URL, selection and optional element. */
  addBrowserAnnotation: (url: string, selection: string, comment: string, element?: BrowserElementAnchor | null) => void;
  /** M4-02: insert explicit page context into the active composer draft. */
  prepareBrowserContext: (sessionId: string, context: string) => boolean;
  /** M4-02: insert a captured page image and its provenance into the composer. */
  prepareBrowserCapture: (sessionId: string, capture: BrowserCapture) => boolean;
  /** M4-04: insert an explicitly captured desktop surface into the composer. */
  prepareDesktopCapture: (sessionId: string, capture: DesktopCapture) => boolean;
  /** US-19: remove an anchored comment by id. */
  removeBrowserAnnotation: (id: string) => void;
  /** US-19: computer-use per-app permissions (default denied). */
  browserPermissions: BrowserAppPermission[];
  /** US-19: toggle one app's computer-use permission. */
  setBrowserAppPermission: (app: string, allowed: boolean) => void;
  /** Computer use: the CUA driver's status, and the three level actions. */
  computerUse: ComputerStatus | null;
  computerBusy: boolean;
  refreshComputerUse: () => Promise<ComputerStatus | null>;
  setComputerLevel: (level: ComputerLevel) => Promise<void>;
  disableComputerUse: () => Promise<void>;
  /** US-20: dated/sourced memory entries (persisted, global to the app). */
  memories: MemoryEntry[];
  /** US-20: SCAN review nudge text when due, else null. */
  scanNudge: string | null;
  addMemoryEntry: (text: string, source: string) => void;
  removeMemoryEntry: (id: string) => void;
  /** US-20: stamp the SCAN review as done (dismisses the nudge). */
  ackScanNudge: () => void;
  /** US-6 controls: one hook method per `subagent/*` MSP method. */
  subagentClose: (sessionId: string, agentId: string, reason?: string) => Promise<void>;
  subagentReopen: (sessionId: string, agentId: string) => Promise<void>;
  subagentInterrupt: (sessionId: string, agentId: string) => Promise<void>;
  subagentStop: (sessionId: string, agentId: string) => Promise<void>;
  subagentResume: (sessionId: string, agentId: string) => Promise<void>;
  subagentFollowup: (sessionId: string, agentId: string, task: string) => Promise<void>;
  /** `subagent/readResult`: formatted result text, or null on error. */
  subagentReadResult: (sessionId: string, agentId: string) => Promise<string | null>;
  /** Drill-down via `session/read`; explicit error when unavailable. */
  subagentDrilldown: (sessionId: string, childSessionId: string | undefined) => Promise<string | null>;
  /** M1-06: load one bounded chunk of a large host-owned item output. */
  readItemOutput: (sessionId: string, entry: LogEntry, offsetBytes?: number) => Promise<ItemOutputChunk | null>;
  /** w-integrations US-24/US-26: installed connector entries. */
  connectors: ConnectorEntry[];
  /** w-integrations US-24: hot-listed tools (re-read, no restart). */
  connectorTools: ConnectorTool[];
  /** M3-01: initialize a real local MCP stdio server and list its tools. */
  probeLocalMcp: (
    command: string,
    workspacePath?: string | null,
  ) => Promise<LocalMcpProbeResult | null>;
  /** M3-01: call one tool on a local MCP stdio server. */
  callLocalMcp: (
    command: string,
    toolName: string,
    argumentsText: string,
    workspacePath?: string | null,
  ) => Promise<LocalMcpCallResult | null>;
  /** M3-03: persist a local server after a successful probe. */
  registerLocalConnector: (
    name: string,
    command: string,
    tools: ConnectorTool[],
    serverVersion?: string,
  ) => boolean;
  /** M3-03: install and probe one local `.mcpb` package revision. */
  installMcpPackage: (file: File) => Promise<boolean>;
  /** M3-01/M3-03: re-probe and persist tools for an existing local server. */
  refreshLocalMcp: (
    id: string,
    workspacePath?: string | null,
  ) => Promise<LocalMcpProbeResult | null>;
  /** M3-03: restore the previous verified local tool catalog. */
  rollbackLocalMcp: (id: string) => boolean;
  /** M3-01: currently live persistent local MCP process ids. */
  mcpRunningIds: string[];
  /** M3-01: start a configured local MCP process explicitly. */
  startLocalMcp: (
    id: string,
    workspacePath?: string | null,
  ) => Promise<LocalMcpProbeResult | null>;
  /** M3-01: stop a configured local MCP process explicitly. */
  stopLocalMcp: (id: string) => Promise<boolean>;
  /** M3-01: call a tool through the persistent process. */
  callRegisteredLocalMcp: (
    id: string,
    toolName: string,
    argumentsText: string,
  ) => Promise<LocalMcpCallResult | null>;
  /** M3-02: IDs with an authenticated remote MCP session in memory. */
  remoteConnectedIds: string[];
  /** M3-02: perform a real remote initialize + tools/list exchange. */
  probeRemoteMcp: (
    name: string,
    url: string,
    token?: string,
  ) => Promise<RemoteMcpProbeResult | null>;
  /** M3-02: call a tool through the in-memory remote session. */
  callRemoteMcp: (
    id: string,
    toolName: string,
    argumentsText: string,
  ) => Promise<RemoteMcpCallResult | null>;
  /** M3-02: drop the in-memory token/session and mark the entry disconnected. */
  disconnectRemoteMcp: (id: string) => void;
  /** M3-02: revoke the native credential and disconnect the remote entry. */
  forgetRemoteMcpCredential: (id: string) => Promise<void>;
  /** w-integrations US-26: last remote-guard refusal message, if any. */
  remoteNotice: string | null;
  /** w-integrations US-24: 1-click install from the curated directory. */
  installConnectorById: (dirId: string) => void;
  /** w-integrations US-24: remove an installed connector. */
  uninstallConnectorById: (id: string) => void;
  /** w-integrations US-24: enable/disable an installed connector. */
  setConnectorEnabledById: (id: string, enabled: boolean) => void;
  /** M3-01: opt one local connector into new Muse session startup config. */
  setConnectorUseInMuseById: (id: string, enabled: boolean) => void;
  /** w-integrations US-25: skills (builtins merged over stored). */
  skills: Skill[];
  /** M3-05: skills exposed by the connected Muse host, keyed by session. */
  hostSkillsBySession: Record<string, HostSkill[]>;
  /** M3-05: renderer-only progress for the most recent skill invocation. */
  skillInvocationsBySession: Record<string, SkillInvocationProgress | undefined>;
  /** Refresh one host-owned skill catalogue (safe no-op in browser preview). */
  refreshHostSkills: (sessionId: string) => Promise<HostSkill[] | null>;
  /** w-integrations US-25: enable/disable a skill by slash name. */
  setSkillEnabledByName: (name: string, enabled: boolean) => void;
  /**
   * w-integrations US-25: suggest skills for a draft AND trace every
   * suggestion into the session log (auditable auto-suggest).
   */
  traceSkillSuggestions: (sessionId: string, text: string) => SkillSuggestion[];
  /** w-integrations US-25: invoke `/name args` (traced, then sent). */
  invokeSkill: (sessionId: string, name: string, args: string) => void;
  /** M3-04: refresh bounded SKILL.md discovery for the selected workspace. */
  scanSkills: (workspacePath?: string | null) => Promise<SkillScanSummary | null>;
  error: string | null;
  /** Set a bounded user-facing orchestration error from a composite action. */
  setError: (message: string | null) => void;
  /** TEMPORARY dev diagnosis: backend events received by this window. */
  evtCount: number;
  /** True when the Tauri backend is unreachable (plain-browser preview). */
  backendMissing: boolean;
  /** M0-10: latest native prerequisite probe (null in web preview). */
  startupProbe: StartupProbe | null;
  /** M0-10: rerun the bounded first-launch prerequisite probe. */
  probeStartup: (workspacePath?: string | null) => Promise<StartupProbe | null>;
}

interface BackendSessionMeta {
  session_id: string;
  workspace: string;
  running: boolean;
  session_durability?: string;
  /** Model the host reports for this session, when it exposes one. */
  model_id?: string;
  /** Host projection, when this sidecar exposes one. */
  approval_mode?: string;
  granted_capabilities?: string[];
  /**
   * Whether the host holds this session in memory. `session/list` reports
   * `notLoaded` for every persisted session after a host restart, so the
   * renderer needs the distinction to avoid offering an action the host will
   * refuse with `sessionNotLoaded`.
   */
  loaded?: boolean;
  /** Title the host keeps for this conversation, when it has one. */
  title?: string;
}

/** A placeholder title ("Session 01a0…" or none) gives way to the host title. */
function withHostTitle(local: string, host: string | undefined): string {
  return host !== undefined && (local === "" || local.startsWith("Session ")) ? host : local;
}

interface BackendWorktreeSessionResult {
  worktree: WorktreeRecord;
  session: BackendSessionMeta;
}

/** Status-kind mapping lives in ../lib/phase (unit-tested, US-10). */

function shortTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}…` : oneLine;
}

/**
 * Parse a stream-chunk payload: JSON `{itemId, text}` from the supervisor, or
 * raw text from older payloads. Never throws.
 */
function parseRichContent(value: unknown): RichContent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, 16).flatMap((raw): RichContent[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof item[key] === "string" && (item[key] as string).trim().length > 0
        ? (item[key] as string).trim().slice(0, 240)
        : undefined;
    const type = text("type");
    const mediaType = text("mediaType") ?? text("media_type");
    const path = text("path");
    const sourceToolName = text("sourceToolName") ?? text("source_tool_name");
    if (!type || !mediaType || !path || !sourceToolName) return [];
    const dimension = (key: string): number | undefined => {
      const n = item[key];
      return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10000 ? n : undefined;
    };
    const width = dimension("width");
    const height = dimension("height");
    return [{ type, mediaType, path, sourceToolName, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }];
  });
  return items.length > 0 ? items : undefined;
}

function parseChunk(payload: string): { itemId?: string; turnId?: string; outputRef?: string; richContent?: RichContent[]; text: string } {
  const parsed = parseStreamChunk(payload);
  let richContent: RichContent[] | undefined;
  if (payload.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(payload.trim()) as Record<string, unknown>;
      const nested = typeof obj.item === "object" && obj.item !== null && !Array.isArray(obj.item)
        ? obj.item as Record<string, unknown>
        : null;
      richContent = parseRichContent(obj.richContent ?? nested?.richContent);
    } catch {
      // The stream parser already preserves a plain-text fallback.
    }
  }
  return { ...parsed, ...(richContent ? { richContent } : {}) };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") throw new Error("MCP package installation requires a browser runtime");
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

/**
 * M0-03: the supervisor resolves `send_input` on admission, not turn end.
 * A missing resolution after this long is an *ambiguous* outcome (the turn
 * may or may not have started): the entry recovers as failed/ambiguous and
 * a retry must verify the server conversation before retransmitting.
 */
const ACK_TIMEOUT_MS = 15000;
const ACK_TIMEOUT_MSG =
  `no acknowledgment after ${ACK_TIMEOUT_MS / 1000}s — the outcome is unknown; ` +
  "retry checks the server before resending";

/** Rejects with ACK_TIMEOUT_MSG when the invoke never settles in time. */
function withAckTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(ACK_TIMEOUT_MSG)), ACK_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Index of the last open entry matching role (+agentId), -1 when none. */
function lastOpenIndex(
  log: LogEntry[],
  role: LogRole,
  agentId?: string,
  itemId?: string,
): number {
  // When the supervisor tags a delta, prefer the exact item. If the host did
  // not send item/started first, fall back only to an unbound placeholder;
  // appending a new entry is safer than mixing concurrent items together.
  if (itemId !== undefined) {
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (
        e.open &&
        e.role === role &&
        (agentId === undefined || e.agentId === agentId) &&
        e.itemId === itemId
      ) {
        return i;
      }
    }
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (
        e.open &&
        e.role === role &&
        (agentId === undefined || e.agentId === agentId) &&
        e.itemId === undefined
      ) {
        return i;
      }
    }
    return -1;
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.open && e.role === role && (agentId === undefined || e.agentId === agentId)) return i;
  }
  return -1;
}

/** Best-effort parse of a tool-request payload into id + summary + choices. */
function parseApproval(sessionId: string, payload: string): ApprovalRequest {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const requestId =
        (typeof obj.request_id === "string" && obj.request_id) ||
        (typeof obj.approvalId === "string" && obj.approvalId) ||
        (typeof obj.id === "string" && obj.id) ||
        trimmed;
      // An `approval/updated` stage may intentionally omit the command
      // preview. Preserve the previous preview when the hook upserts the
      // same approval id instead of replacing it with the JSON envelope.
      const summary =
        typeof obj.summary === "string"
          ? obj.summary
          : (typeof obj.command === "string" && obj.command) ||
            (typeof obj.description === "string" && obj.description) ||
            trimmed;
      const toolName = typeof obj.toolName === "string" ? obj.toolName : "tool";
      const rawChoices = Array.isArray(obj.choices) ? obj.choices : [];
      const choices: ApprovalChoice[] = rawChoices
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => {
          const decision =
            typeof c.decision === "string"
              ? c.decision
              : typeof c.decision === "object" && c.decision !== null &&
                  typeof (c.decision as Record<string, unknown>).kind === "string"
                ? ((c.decision as Record<string, unknown>).kind as string)
                : "";
          return {
            choiceId:
              typeof c.choiceId === "string"
                ? c.choiceId
                : typeof c.choice_id === "string"
                  ? c.choice_id
                  : "",
            label: typeof c.label === "string" ? c.label : "?",
            decision,
            scope: typeof c.scope === "string" ? c.scope : "",
          };
        })
        .filter((c) => c.choiceId.length > 0);
      return { session_id: sessionId, request_id: requestId, summary, toolName, choices };
    } catch {
      // fall through
    }
  }
  return { session_id: sessionId, request_id: trimmed, summary: trimmed, toolName: "tool", choices: [] };
}

function parsePendingSnapshot(
  sessionId: string,
  pending: unknown,
): { approvals: ApprovalRequest[]; inputs: InputRequest[] } {
  if (typeof pending !== "object" || pending === null) {
    return { approvals: [], inputs: [] };
  }
  const raw = pending as { approvals?: unknown; userInputs?: unknown };
  const approvals = Array.isArray(raw.approvals)
    ? raw.approvals
        .map((item) => parseApproval(sessionId, JSON.stringify(item) ?? ""))
        .filter((item) => item.request_id.length > 0)
    : [];
  const inputs = Array.isArray(raw.userInputs)
    ? raw.userInputs
        .map((item) => parseInputRequest(sessionId, JSON.stringify(item) ?? ""))
        .filter((item): item is InputRequest => item !== null)
    : [];
  return { approvals, inputs };
}

function isMethodUnavailable(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /(?:-32601|method\s*not\s*found|methodnotfound)/i.test(detail);
}

/**
 * Session-multiplexing hook.
 *
 * - Session list + active session, persisted to localStorage and merged
 *   with the supervisor's `restore_sessions` on boot.
 * - Per-session append-only log (user input, assistant stream chunks
 *   coalesced into one open entry, sub-agent blocks grouped by agent id,
 *   tool/system entries), persisted per session and restored on boot.
 * - Invokes `start_session` / `send_input` / `approve` / `cancel_session` /
 *   `kill_session` / `subagent_*` with camelCase args (Tauri `#[command]`
 *   default), and
 *   subscribes to `output` / `subagent_event` / `tool_request` / `status`.
 *   (Event payloads stay snake_case: they are Rust-serde JSON, not args.)
 */
export function useMuseSessions(): UseMuseSessions {
  const [sessions, setSessions] = useState<MuseSession[]>([]);
  const sessionsRef = useRef<MuseSession[]>([]);
  sessionsRef.current = sessions;
  // Do not persist the initial empty render before boot restores history.
  // A state gate also protects StrictMode's setup/cleanup/setup replay.
  const [historyReady, setHistoryReady] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  // M0-02: keep a live heartbeat separate from the transcript. Persisted
  // entries can be old after a restart and must never masquerade as current
  // host activity.
  const [streamActivityBySession, setStreamActivityBySession] = useState<
    Record<string, StreamActivity>
  >({});
  const [recoveryNoticeBySession, setRecoveryNoticeBySession] = useState<
    Record<string, StreamRecoveryNotice>
  >({});
  const [resumePendingBySession, setResumePendingBySession] = useState<
    Record<string, ResumePending>
  >({});
  const resumePendingBySessionRef = useRef<Record<string, ResumePending>>({});
  resumePendingBySessionRef.current = resumePendingBySession;
  // One bounded recovery read per accepted decision. The host remains the
  // authority; this only prevents a quiet post-approval turn from waiting
  // forever for a notification that was dropped or never emitted.
  const resumeReconcileTimersRef = useRef<Record<string, {
    requestedAt: number;
    timer: ReturnType<typeof setTimeout>;
  }>>({});
  const [retryScheduledBySession, setRetryScheduledBySession] = useState<
    Record<string, RetryScheduled>
  >({});
  const [turnCompletionBySession, setTurnCompletionBySession] = useState<
    Record<string, SessionTurnCompletion>
  >({});
  // A cancel request is not the same thing as a confirmed stopped status.
  // Keep this renderer-only state separate from the persisted session row so
  // a slow host cannot make a turn look finished or lose its open transcript.
  const [stoppingBySession, setStoppingBySession] = useState<Record<string, boolean>>({});
  const stoppingBySessionRef = useRef<Record<string, boolean>>({});
  const [queuedTurnsBySession, setQueuedTurnsBySession] = useState<Record<string, QueuedTurn[]>>(() => {
    const stored = loadQueuedTurns();
    return Object.fromEntries(
      Object.entries(stored).map(([sessionId, rows]) => [
        sessionId,
        rows.map((row) => ({ ...row, recovered: true })),
      ]),
    );
  });
  /** M1-10: adopt a host queue snapshot only when the server actually serves
   * one; inline/legacy reads leave local reminders untouched. */
  const reconcileQueueSnapshot = useCallback(async (sessionId: string): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      const snapshot = await invoke<unknown>("read_queue_snapshot", { sessionId });
      setQueuedTurnsBySession((current) => {
        const next = reconcileQueuedTurns(sessionId, current[sessionId] ?? [], snapshot);
        if (next === null) return current;
        if (next.length === 0) {
          if (!(sessionId in current)) return current;
          const copy = { ...current };
          delete copy[sessionId];
          return copy;
        }
        return { ...current, [sessionId]: next as QueuedTurn[] };
      });
    } catch {
      // Queue snapshots are additive. An older host or a transient read
      // failure must never erase the local, user-visible reminder.
    }
  }, []);
  // Global authorization posture. This is intentionally kept separate from
  // sandbox settings: changing the posture must not mutate host capabilities.
  const [authorizationMode, setAuthorizationModeState] = useState<AuthorizationMode>(() => {
    return parseAuthorizationMode(readStorageString(AUTHORIZATION_MODE_KEY));
  });
  /** Effective host posture by session. `null` means a requested change was
   * refused or the host returned an incomplete projection; in that state the
   * local selector must never auto-approve a tool. */
  const [hostApprovalModeBySession, setHostApprovalModeBySession] = useState<Record<string, string | null>>({});
  // US-15 allowlist: restored once (survives restarts via localStorage),
  // written through on every change.
  const [allowlist, setAllowlist] = useState<AllowRule[]>(() => loadAllowlist());
  // US-9 automations: restored once (survive restarts via localStorage),
  // written through on every change (effect below).
  const [schedules, setSchedules] = useState<Schedule[]>(() => loadSchedules());
  const nativeSchedulesHydratedRef = useRef(!isTauriRuntime());
  const nativeScheduleWriterRef = useRef<((rows: Schedule[]) => void) | null>(null);
  if (nativeScheduleWriterRef.current === null && isTauriRuntime()) {
    nativeScheduleWriterRef.current = createLatestWriteQueue(saveNativeSchedules);
  }
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>(() => loadReviewQueue());
  const [scheduleRuns, setScheduleRuns] = useState<ScheduleRun[]>(() =>
    recoverScheduleRuns(loadScheduleRuns(), Date.now()),
  );
  const [nativeScheduleRunsReady, setNativeScheduleRunsReady] = useState(!isTauriRuntime());
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerRuntimeStatus>(
    () => INITIAL_SCHEDULER_RUNTIME_STATUS,
  );
  const [schedulerWakeupStatus, setSchedulerWakeupStatus] = useState<SchedulerWakeupStatus>(
    () => INITIAL_SCHEDULER_WAKEUP_STATUS,
  );
  const nativeSchedulerWakeupWriterRef = useRef<((wakeAt: number | null) => Promise<SchedulerWakeupStatus>) | null>(null);
  if (nativeSchedulerWakeupWriterRef.current === null) {
    nativeSchedulerWakeupWriterRef.current = createSchedulerWakeupQueue(syncNativeSchedulerWakeup);
  }
  // The native app-data copy is hydrated once before any subsequent state
  // write. The renderer state remains the SSOT; this gate prevents a startup
  // localStorage render from overwriting a newer native snapshot.
  const nativeScheduleRunsHydratedRef = useRef(!isTauriRuntime());
  const nativeScheduleRunsWriterRef = useRef<((rows: ScheduleRun[]) => void) | null>(null);
  if (nativeScheduleRunsWriterRef.current === null && isTauriRuntime()) {
    nativeScheduleRunsWriterRef.current = createLatestWriteQueue(saveNativeScheduleRuns);
  }
  const [notifications, setNotifications] = useState<MuseNotification[]>(() => loadNotifications());
  const [nativeNotificationsReady, setNativeNotificationsReady] = useState(!isTauriRuntime());
  const notificationsRef = useRef<MuseNotification[]>([]);
  notificationsRef.current = notifications;
  // As with schedule runs, native inbox hydration happens before the first
  // desktop write so a webview reload cannot erase unread attention items.
  const nativeNotificationsHydratedRef = useRef(!isTauriRuntime());
  const nativeNotificationWriterRef = useRef<((rows: MuseNotification[]) => void) | null>(null);
  if (nativeNotificationWriterRef.current === null && isTauriRuntime()) {
    nativeNotificationWriterRef.current = createNotificationWriteQueue(saveNativeNotifications);
  }
  const [notificationPreferences, setNotificationPreferences] = useState(() => loadNotificationPreferences());
  const [notificationPermissionState, setNotificationPermissionState] = useState<NotificationPermission>(
    () => readNotificationPermission(),
  );
  // w-integrations US-24/US-26: connector registry (survives restarts via
  // localStorage), written through on every change.
  const [connectors, setConnectors] = useState<ConnectorEntry[]>(() => loadConnectors());
  // Persistent MCP processes are native runtime state, not part of the
  // persisted connector registry. A relaunch starts them only on explicit
  // Start/Refresh, never during hydration.
  const [mcpRunningIds, setMcpRunningIds] = useState<string[]>([]);
  const mcpPollBusyRef = useRef(false);
  // Remote MCP session ids remain process memory only. Bearers live in this
  // ref while connected and, on desktop, are also kept in the native secure
  // store for an explicit reconnect; they never enter the registry or
  // localStorage.
  const remoteSessionsRef = useRef<Record<string, RemoteMcpSession>>({});
  const [remoteConnectedIds, setRemoteConnectedIds] = useState<string[]>([]);
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  // w-integrations US-25: skills, builtins merged over stored overrides.
  const [skills, setSkills] = useState<Skill[]>(() => mergeBuiltinSkills(loadSkills()));
  // Latest skills for the render-detached `/skill` path inside sendInput.
  const skillsRef = useRef<Skill[]>(skills);
  skillsRef.current = skills;
  const [hostSkillsBySession, setHostSkillsBySession] = useState<Record<string, HostSkill[]>>({});
  // Host catalog is keyed by session so a conversation switch never invokes
  // a selector discovered in another workspace.
  const hostSkillsRef = useRef<Record<string, HostSkill[]>>({});
  hostSkillsRef.current = hostSkillsBySession;
  // M3-05: skill invocation progress is deliberately ephemeral. The host
  // remains authoritative for turn state; this map only makes the client
  // expansion/admission pipeline observable without polluting the transcript.
  const [skillInvocationsBySession, setSkillInvocationsBySession] = useState<
    Record<string, SkillInvocationProgress | undefined>
  >({});
  const updateSkillInvocation = useCallback(
    (sessionId: string, patch: Partial<SkillInvocationProgress> & { clear?: boolean }): void => {
      setSkillInvocationsBySession((current) => {
        if (patch.clear) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        const previous = current[sessionId];
        if (previous === undefined) return current;
        const next = { ...previous, ...patch };
        delete (next as Partial<SkillInvocationProgress> & { clear?: boolean }).clear;
        return { ...current, [sessionId]: next };
      });
    },
    [],
  );
  const startSkillInvocation = useCallback(
    (sessionId: string, name: string, source: "host" | "local"): void => {
      const now = Date.now();
      setSkillInvocationsBySession((current) => ({
        ...current,
        [sessionId]: { name, source, stage: "preparing", startedAt: now, updatedAt: now },
      }));
    },
    [],
  );
  const refreshHostSkills = useCallback(async (sessionId: string): Promise<HostSkill[] | null> => {
    if (!isTauriRuntime() || sessionId.trim().length === 0) return null;
    try {
      const result = await invoke<unknown>("list_skills", { sessionId });
      const parsed = parseHostSkills(result);
      setHostSkillsBySession((current) => ({ ...current, [sessionId]: parsed }));
      return parsed;
    } catch (error) {
      // Host skill discovery is additive. Older sidecars may not expose
      // skill/list; keep the local catalogue usable and avoid a blocking UI
      // error for an optional capability.
      console.warn("host skill catalogue unavailable", error);
      setHostSkillsBySession((current) => ({ ...current, [sessionId]: [] }));
      return null;
    }
  }, []);
  // Latest connectors for the render-detached remote-guard path.
  const connectorsRef = useRef<ConnectorEntry[]>(connectors);
  connectorsRef.current = connectors;
  const [inputRequests, setInputRequests] = useState<InputRequest[]>([]);
  // US-19 browser: anchored comments + per-app computer-use permissions,
  // restored once (survive restarts via localStorage), written through below.
  const [browserAnnotations, setBrowserAnnotations] = useState<BrowserAnnotation[]>(() =>
    loadBrowserAnnotations(),
  );
  const [browserPermissions, setBrowserPermissions] = useState<BrowserAppPermission[]>(() =>
    loadBrowserPermissions(),
  );
  const [workspace, setWorkspaceState] = useState<string | null>(null);
  // w-settings: sandbox settings + per-project provider map, restored once
  // (survive restarts via localStorage), written through on every change.
  const [sandbox, setSandboxState] = useState<SandboxSettings>(() => {
    return parseSandboxSettings(readStorageJson<unknown>(SETTINGS_KEY, null));
  });
  const [providerMap, setProviderMap] = useState<Record<string, string>>(() => {
    return parseProviderMap(readStorageJson<unknown>(PROVIDER_MAP_KEY, null));
  });
  const [error, setError] = useState<string | null>(null);
  // US-4: local thread summaries (mirror of localStorage) + composer prefill
  // after `newFromSummary`.
  const [summaries, setSummaries] = useState<Record<string, ThreadSummary>>({});
  const [prefill, setPrefill] = useState<string | null>(null);
  const [prefillAttachmentState, setPrefillAttachmentState] = useState<{
    sessionId: string;
    attachment: ComposerAttachment;
  } | null>(null);
  // US-12 + US-21: versioned artifacts per thread (mirror of localStorage).
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({});
  // w-collab US-27: share mode + bundles (persisted under
  // muse-desktop.sharing.v1 via the save effect below).
  const [shareState, setShareState] = useState<ShareState>(() => {
    try {
      return loadShareState();
    } catch {
      return emptyShareState();
    }
  });
  // w-collab US-28: channel stub stays behind its flag (off, never live).
  const [channelsExperimental] = useState(false);
  // w-collab US-34: resumable sessions from CLI/IDE config imports
  // (persisted under muse-desktop.import.v1; live sessions never touched).
  const [importedSessions, setImportedSessions] = useState<ResumableSession[]>(() => {
    try {
      return loadImportedSessions();
    } catch {
      return [];
    }
  });
  const [importNotes, setImportNotes] = useState<string[]>([]);
  // w-collab: auto-share keeps one live auto bundle per session; the map
  // (sessionId -> bundleId) is persisted alongside so a restart revokes the
  // stale auto snapshot instead of stacking new ones.
  const AUTO_MAP_KEY = "muse-desktop.sharing.auto.v1";
  const loadAutoMap = (): Record<string, string> => {
    const parsed = readStorageJson<unknown>(AUTO_MAP_KEY, null);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  };
  const autoBundleIds = useRef<Record<string, string> | null>(null);
  if (autoBundleIds.current === null) {
    autoBundleIds.current = loadAutoMap();
  }
  // US-20: memory entries + last SCAN review stamp, restored once and
  // written through on every change (localStorage, best-effort).
  const [memories, setMemories] = useState<MemoryEntry[]>(() => loadMemories());
  const [lastScan, setLastScan] = useState<number | null>(() => loadLastScan());
  // Latest logs for the render-detached compaction paths (`/compact` inside
  // sendInput, auto-compact effect): refs stay fresh where useCallback deps
  // would go stale.
  const logsRef = useRef<Record<string, LogEntry[]>>({});
  logsRef.current = logs;
  // US-3 + US-30 Projects: restored once (survive restarts via
  // localStorage), written through on every change like sessions.
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [threadProjects, setThreadProjects] = useState<ThreadProjectMap>(
    () => loadThreadProjects(),
  );
  const [globalSettings, setGlobalSettingsState] = useState<ProjectSettings>(
    () => loadGlobalSettings(DEFAULT_PROJECT_SETTINGS),
  );
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>(() => loadWorktrees());
  const [cleanupIntents, setCleanupIntents] = useState<WorktreeCleanupIntent[]>(() =>
    loadWorktreeCleanupIntents(),
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  // Fresh copies for the render-detached send path (same pattern as
  // logsRef): sendInput reads these so project settings never go stale.
  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;
  const threadProjectsRef = useRef<ThreadProjectMap>({});
  threadProjectsRef.current = threadProjects;
  // TEMPORARY dev diagnosis: counts backend events received by this window.
  const [evtCount, setEvtCount] = useState(0);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  // M1-06: initialize grants are host facts. Keep them separate from the
  // authorization posture and from persisted session metadata.
  const [grantedCapabilitiesBySession, setGrantedCapabilitiesBySession] = useState<
    Record<string, string[] | undefined>
  >({});
  // M1-06: whether the host has each conversation loaded. `session/list` calls
  // every persisted session `notLoaded` after a restart, and `session/userShell`
  // is refused in that state, so this is a precondition rather than a detail.
  const [sessionLoadedBySession, setSessionLoadedBySession] = useState<
    Record<string, boolean | undefined>
  >({});
  const [connectionBySession, setConnectionBySession] = useState<
    Record<string, SessionConnectionState>
  >({});
  const [backendMissing, setBackendMissing] = useState<boolean>(!isTauriRuntime());
  const [startupProbe, setStartupProbe] = useState<StartupProbe | null>(null);

  const probeStartup = useCallback(
    async (workspacePath?: string | null): Promise<StartupProbe | null> => {
      if (!isTauriRuntime()) return null;
      try {
        const result = await invoke<StartupProbe>("probe_startup", {
          workspacePath: workspacePath ?? workspace ?? null,
        });
        setStartupProbe(result);
        return result;
      } catch {
        // Older native bundles can lack the optional probe command. The
        // regular start error remains the source of truth in that case.
        return null;
      }
    },
    [workspace],
  );
  // M1-01: review snapshots are owned by the hook so the panel never reads
  // stale or cross-session Git state. A refresh replaces the snapshot; the
  // observed HEAD in each result is the basis for later mutating actions.
  const [gitReviewBySession, setGitReviewBySession] = useState<
    Record<string, GitReviewState>
  >({});
  const [gitTurnSnapshotsBySession, setGitTurnSnapshotsBySession] = useState<
    Record<string, GitTurnSnapshot>
  >(() => {
    const restored: Record<string, GitTurnSnapshot> = {};
    for (const session of loadSessions()) {
      const snapshot = loadGitTurnSnapshot(session.session_id);
      if (snapshot !== null) restored[session.session_id] = snapshot;
    }
    return restored;
  });
  const gitTurnSnapshotsRef = useRef<Record<string, GitTurnSnapshot>>({});
  gitTurnSnapshotsRef.current = gitTurnSnapshotsBySession;
  const gitRequestSeq = useRef<Record<string, number>>({});
  // M1-05: PTYs are backend-owned and survive work-panel unmounts. The hook
  // mirrors only the UI metadata and bounded output tail for the active window.
  const [terminalsBySession, setTerminalsBySession] = useState<
    Record<string, TerminalState>
  >({});
  const [filesBySession, setFilesBySession] = useState<Record<string, FilesBrowserState>>({});
  const filesRequestSeq = useRef<Record<string, number>>({});
  // M2-04: operation ids let the renderer cancel a specific native setup
  // process without trying to infer it from the active view.
  const setupOperationsRef = useRef<Map<string, string>>(new Map());
  // Mirror of "any session running", read by the poll loop to pick cadence.
  // Plain ref (not state): the loop lives outside render, StrictMode-safe.
  const runningRef = useRef(false);
  // Latest server turn id per session, used to target turn/steer without a
  // race against a newly started or completed turn.
  const turnIdsRef = useRef<Record<string, string>>({});
  // Keep the last terminal turn id long enough to reject a buffered retry
  // notification that arrives after the turn has already completed.
  const lastTerminalTurnIdsRef = useRef<Record<string, string>>({});
  // Shared poll cursor: the periodic tick and the post-send kick both drain
  // from here, so a kick never replays what the tick already fed.
  const cursorRef = useRef(0);
  // One serialized drain chain (tick + kicks); created once per mount.
  const pollChainRef = useRef(createPollChain());
  // Latest handleEvent, read by the render-detached poll drain.
  const handleEventRef = useRef<(evt: DrainedEvent) => void>(() => {});
  // False after unmount: a late kick must not setState on a dead component.
  const aliveRef = useRef(true);
  // Tombstoned ids (user-deleted): late events and backend restores must not
  // resurrect them. Lazy init survives StrictMode remounts (ref persists).
  const tombstoned = useRef<Set<string> | null>(null);
  if (tombstoned.current === null) {
    tombstoned.current = new Set(loadTombstones());
  }
  // Boot restore handshake: `restore_sessions` only admits sessions for
  // already-connected hosts. Set once the backend restore settles (success
  // or failure); the boot auto-resume effect below waits for it.
  const restoreSettledRef = useRef(false);
  // Boot auto-resume runs once: silent `resume_session` for the stored
  // sessions the backend did not admit (hosts do not survive a restart).
  const resumeAttemptedRef = useRef(new Set<string>());
  // M0-03 outbox: durable retryable sends per session, restored once. An
  // entry still `sending` at boot means the app died or reloaded mid-flight:
  // the outcome is unknown, so it recovers as failed/ambiguous (a retry
  // then verifies the server before retransmitting). Lazy init survives
  // StrictMode remounts: recovery is idempotent (failed entries are kept,
  // accepted ones are pruned defensively).
  const nativeOutboxHydratedRef = useRef(!isTauriRuntime());
  const nativeOutboxWriterRef = useRef<((store: OutboxStore) => void) | null>(null);
  if (nativeOutboxWriterRef.current === null && isTauriRuntime()) {
    nativeOutboxWriterRef.current = createOutboxWriteQueue(saveNativeOutbox);
  }
  const [outbox, setOutbox] = useState<Record<string, OutboxEntry[]>>(() => {
    const restored: Record<string, OutboxEntry[]> = {};
    for (const s of loadSessions()) {
      if (tombstoned.current?.has(s.session_id)) continue;
      const { entries, recovered } = recoverInterrupted(
        loadOutbox(s.session_id),
        Date.now(),
      );
      const live = entries.filter((e) => e.state !== "accepted");
      if (recovered > 0 || live.length !== entries.length) {
        saveOutbox(s.session_id, live);
      }
      if (live.length > 0) restored[s.session_id] = live;
    }
    return restored;
  });
  // Latest outbox for the render-detached send path (same pattern as logsRef).
  const outboxRef = useRef<Record<string, OutboxEntry[]>>({});
  outboxRef.current = outbox;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void loadNativeOutbox().then((nativeStore) => {
      if (cancelled) return;
      nativeOutboxHydratedRef.current = true;
      if (nativeStore === null) {
        nativeOutboxWriterRef.current?.(outboxRef.current);
        return;
      }
      setOutbox((current) => {
        const merged = mergeOutboxStores(current, nativeStore);
        const recovered: OutboxStore = {};
        for (const [sessionId, entries] of Object.entries(merged)) {
          const live = recoverInterrupted(entries, Date.now()).entries
            .filter((entry) => entry.state !== "accepted");
          if (live.length > 0) recovered[sessionId] = live;
          saveOutbox(sessionId, live);
        }
        return recovered;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (nativeOutboxHydratedRef.current) nativeOutboxWriterRef.current?.(outbox);
  }, [outbox]);

  /**
   * Read the host's folded history, falling back to the durable cursor-paged
   * view when an older/newer host does not expose `session/read`. Paging is
   * bounded by both page size and total pages so a malformed or endlessly
   * advancing cursor cannot stall reconciliation. The returned projection is
   * always the same LogEntry shape consumed by the renderer SSOT.
   */
  const readHistoryEntries = useCallback(async (sessionId: string): Promise<LogEntry[]> => {
    try {
      const history = await invoke<unknown>("read_session_history", { sessionId });
      return historyItemsToLogEntries(extractHistoryItems(history));
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error;
      const events: unknown[] = [];
      let cursor: string | undefined;
      let previousCursor: string | undefined;
      let reachedEnd = false;
      for (let page = 0; page < 8; page += 1) {
        const result = await invoke<unknown>("page_session_history", {
          sessionId,
          direction: "forward",
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (typeof result !== "object" || result === null) {
          throw new Error("view/page returned an invalid history envelope");
        }
        const envelope = result as { events?: unknown; nextCursor?: unknown };
        if (Array.isArray(envelope.events)) events.push(...envelope.events);
        const next = typeof envelope.nextCursor === "string" && envelope.nextCursor.trim().length > 0
          ? envelope.nextCursor.trim()
          : undefined;
        if (next === undefined) {
          reachedEnd = true;
          break;
        }
        if (next === cursor || next === previousCursor) {
          throw new Error("view/page returned a repeated history cursor");
        }
        previousCursor = cursor;
        cursor = next;
      }
      if (!reachedEnd) {
        throw new Error("view/page exceeded the bounded history page limit");
      }
      return historyEventsToLogEntries(events);
    }
  }, []);

  // One drain of the backend event buffer, shared by the periodic tick and
  // the immediate post-send kick. Stable across renders: it only touches refs
  // plus setState, so send/answer/approve callbacks can safely depend on it.
  const pollOnce = useCallback(async (): Promise<void> => {
    if (!aliveRef.current) return;
    try {
      const res = await invoke<PollResult>("poll_events", { since: cursorRef.current });
      if (!aliveRef.current) return;
      cursorRef.current = res.head;
      if (res.truncated === true) {
        // The native ring is intentionally bounded. Reconcile the sessions
        // that could have lost a request or terminal item before applying the
        // surviving tail, so an approval can never disappear into a silent
        // "thinking" state after a burst of host events.
        const candidates = new Set(
          sessionsRef.current
            .filter((session) => session.running)
            .map((session) => session.session_id),
        );
        for (const event of res.events) candidates.add(event.session_id);
        setError(
          `Some host updates were dropped${res.oldest === null || res.oldest === undefined ? "" : ` (oldest available event ${res.oldest})`}. Refreshing active conversation state.`,
        );
        await Promise.allSettled(
          [...candidates].slice(0, 50).map(async (sessionId) => {
            try {
              const pending = await invoke<unknown>("list_pending_requests", { sessionId });
              if (typeof pending === "object" && pending !== null) {
                const parsed = parsePendingSnapshot(sessionId, pending);
                setApprovals((cur) => [
                  ...cur.filter((item) => item.session_id !== sessionId),
                  ...parsed.approvals,
                ]);
                setInputRequests((cur) => [
                  ...cur.filter((item) => item.session_id !== sessionId),
                  ...parsed.inputs,
                ]);
              }
            } catch {
              // Older hosts may not implement the pull path; history below
              // still provides a useful recovery and the stale action remains.
            }
            try {
              const remote = await readHistoryEntries(sessionId);
              if (remote.length === 0) return;
              const local = logsRef.current[sessionId] ?? loadLog(sessionId);
              const merged = mergeHistoryLog(local, remote);
              setLogs((cur) => ({ ...cur, [sessionId]: merged }));
              saveLog(sessionId, merged);
            } catch {
              // History reconciliation is additive; keep the local transcript
              // and let the stream health row offer Reconnect/Stop if needed.
            }
          }),
        );
      }
      const apply = handleEventRef.current;
      for (const e of res.events) apply(e);
    } catch (err) {
      if (aliveRef.current) setError(`event poll failed: ${String(err)}`);
    }
  }, [readHistoryEntries]);

  // Immediate drain right after the backend acknowledges new work: without
  // this the next tick can be a full slow interval away, so the first paint
  // arrives late with a whole backlog at once (catch-up burst) instead of
  // streaming from the first tokens.
  const kickPoll = useCallback((): void => {
    enqueuePoll(pollChainRef.current, () => pollOnce());
  }, [pollOnce]);

  // Boot: restore local persistence first (instant history), then merge
  // the supervisor's live table, then poll the backend event buffer.
  // (Polling, not `listen` push: push subscriptions resolved yet never fired
  // in one environment, while `invoke` always worked — same broadcast
  // semantics, boring transport.)
  useEffect(() => {
    // No once-guard here: React StrictMode (dev) mounts, unmounts, and
    // remounts — a "booted" ref would skip the second (real) setup forever
    // after cleanup cancelled the first. Teardown below makes re-setup safe.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    aliveRef.current = true;

    const stored = loadSessions();
    const storedLogs: Record<string, LogEntry[]> = {};
    for (const s of stored) storedLogs[s.session_id] = loadLog(s.session_id);
    const storedWorkspace = loadWorkspace();
    const storedActive = loadActiveId();
    if (!cancelled) {
      // Mark restored sessions stopped: sidecar children do not survive
      // an app restart; the user relaunches by sending new input.
      // Tombstoned ids never come back, even from a stale persisted list.
      const live = stored.filter((s) => !tombstoned.current?.has(s.session_id));
      setSessions(live.map((s) => ({ ...s, running: false })));
      setConnectionBySession(
        Object.fromEntries(
          live.map((s) => [s.session_id, "disconnected" as SessionConnectionState]),
        ),
      );
      setLogs(storedLogs);
      // US-4: restore stored summaries (a stored summary = compacted thread).
      const storedSummaries: Record<string, ThreadSummary> = {};
      for (const s of stored) {
        const sum = loadSummary(s.session_id);
        if (sum !== null) storedSummaries[s.session_id] = sum;
      }
      setSummaries(storedSummaries);
      // US-12 + US-21: restore stored artifacts per thread.
      const storedArtifacts: Record<string, Artifact[]> = {};
      for (const s of stored) {
        const arts = loadArtifacts(s.session_id);
        if (arts.length > 0) storedArtifacts[s.session_id] = arts;
      }
      setArtifacts(storedArtifacts);
      setWorkspaceState(storedWorkspace);
      setActiveId(
        storedActive &&
          stored.some((s) => s.session_id === storedActive && s.archived !== true)
          ? storedActive
          : (stored.find((s) => s.archived !== true)?.session_id ?? null),
      );
      setHistoryReady(true);
    }

    // Outside the Tauri webview there is no backend: local history stays
    // visible, backend calls are skipped (their error banners would lie).
    if (!isTauriRuntime()) {
      setBackendMissing(true);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const restored = await invoke<BackendSessionMeta[]>("restore_sessions");
        if (cancelled) return;
        setConnectedIds(restored.map((s) => s.session_id));
        setGrantedCapabilitiesBySession((cur) => {
          const next = { ...cur };
          for (const meta of restored) {
            next[meta.session_id] = meta.granted_capabilities;
          }
          return next;
        });
        setSessionLoadedBySession((cur) => {
          const next = { ...cur };
          for (const meta of restored) {
            if (meta.loaded !== undefined) next[meta.session_id] = meta.loaded;
          }
          return next;
        });
        setSessions((cur) => {
          const next = [...cur];
          for (const meta of restored) {
            // The host keeps killed sessions server-side (no session/stop);
            // never merge a tombstoned id back in.
            if (tombstoned.current?.has(meta.session_id)) continue;
            const i = next.findIndex((s) => s.session_id === meta.session_id);
            if (i >= 0) {
              next[i] = {
                ...next[i],
                title: withHostTitle(next[i].title, meta.title),
                workspace: meta.workspace,
                running: meta.running,
                ...(meta.session_durability ? { session_durability: meta.session_durability } : {}),
                // The host owns the model, so its value wins when present; a
                // host that omits modelId keeps the last model we requested
                // instead of silently reverting to a generic "Model" label.
                ...(meta.model_id ? { model_id: meta.model_id } : {}),
              };
            } else {
              next.push({
                session_id: meta.session_id,
                workspace: meta.workspace,
                title: meta.title ?? `Session ${meta.session_id.slice(0, 8)}`,
                createdAt: Date.now(),
                running: meta.running,
                ...(meta.session_durability ? { session_durability: meta.session_durability } : {}),
                ...(meta.model_id ? { model_id: meta.model_id } : {}),
              });
            }
          }
          return next;
        });
        setConnectionBySession((cur) => {
          const next = { ...cur };
          for (const meta of restored) {
            if (!tombstoned.current?.has(meta.session_id)) {
              next[meta.session_id] = "connected";
            }
          }
          return next;
        });
        setHostApprovalModeBySession((cur) => {
          const next = { ...cur };
          for (const meta of restored) {
            if (typeof meta.approval_mode === "string" && !tombstoned.current?.has(meta.session_id)) {
              next[meta.session_id] = meta.approval_mode;
            }
          }
          return next;
        });
        setActiveId((cur) => {
          if (cur !== null) return cur;
          return restored[0]?.session_id ?? null;
        });
        // Host skills are session-scoped; hydrate them alongside restored
        // conversations without delaying the first transcript paint.
        void Promise.allSettled(
          restored
            .filter((meta) => !tombstoned.current?.has(meta.session_id))
            .map((meta) => refreshHostSkills(meta.session_id)),
        );
      } catch (e) {
        if (!cancelled) setError(`restore_sessions failed: ${String(e)}`);
      }
      restoreSettledRef.current = true;
      // Start polling from the current head: no replay of ancient history,
      // live events only. Each response advances the cursor past what we fed.
      try {
        const head = await invoke<PollResult>("poll_events", {});
        if (cancelled) return;
        cursorRef.current = head.head;
      } catch (err) {
        if (!cancelled) setError(`event poll failed: ${String(err)}`);
        return;
      }
      // US-31: the backend answered, so the host is up — snapshot the live
      // model catalog once (no per-session active flags yet; setSessionModel
      // reloads with the session after each pick). refreshModels is stable.
      if (!cancelled) await refreshModels();
      // setTimeout chain (not setInterval): cadence adapts to whether a
      // turn is streaming, and a slow tick never piles onto the next. The
      // drain itself goes through the shared chain so a post-send kick can
      // never overlap this tick with the same cursor.
      const tick = () => {
        enqueuePoll(pollChainRef.current, () => pollOnce());
        void pollChainRef.current.current.then(() => {
          if (!cancelled) {
            timer = setTimeout(
              tick,
              runningRef.current ? POLL_FAST_MS : POLL_SLOW_MS,
            );
          }
        });
      };
      tick();
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollOnce]);

  // Write-through persistence.
  // M0-02: never persist the hydrated value itself. A corrupt/absent store
  // hydrates to the read fallback, and mount-time write-through used to persist
  // that fallback — a transient read failure (force-kill during a storage flush)
  // became permanent data loss. Only real mutations (new identity) reach
  // storage; the ref is initialized during render so it captures the hydrated
  // value even when state changes before historyReady.
  const sessionsHydratedRef = useRef<typeof sessions | null>(null);
  if (sessionsHydratedRef.current === null) sessionsHydratedRef.current = sessions;
  useEffect(() => {
    if (!historyReady) return;
    if (sessions === sessionsHydratedRef.current) return;
    saveSessions(sessions.map(({ running: _r, ...rest }) => rest));
  }, [sessions, historyReady]);

  useEffect(() => {
    if (!historyReady) return;
    saveQueuedTurns(queuedTurnsBySession);
  }, [queuedTurnsBySession, historyReady]);

  useEffect(() => {
    if (!historyReady) return;
    saveActiveId(activeId);
  }, [activeId, historyReady]);

  useEffect(() => {
    saveAllowlist(allowlist);
  }, [allowlist]);

  // US-3 + US-30 write-through persistence (best-effort, cf. persist.ts).
  // M0-02: same hydration guard as sessions above — the loaded value (which may
  // be the read fallback after a corrupt store) is never persisted; only real
  // mutations are.
  const projectsHydratedRef = useRef<typeof projects | null>(null);
  if (projectsHydratedRef.current === null) projectsHydratedRef.current = projects;
  useEffect(() => {
    if (projects === projectsHydratedRef.current) return;
    saveProjects(projects);
  }, [projects]);

  useEffect(() => {
    saveWorktrees(worktrees);
  }, [worktrees]);

  useEffect(() => {
    saveWorktreeCleanupIntents(cleanupIntents);
  }, [cleanupIntents]);

  useEffect(() => {
    saveThreadProjects(threadProjects);
  }, [threadProjects]);

  useEffect(() => {
    saveGlobalSettings(globalSettings);
  }, [globalSettings]);

  // US-9 write-through persistence (best-effort localStorage, like the rest).
  useEffect(() => {
    saveSchedules(schedules);
    if (nativeSchedulesHydratedRef.current) {
      nativeScheduleWriterRef.current?.(schedules);
    }
  }, [schedules]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void loadNativeSchedules().then((nativeSchedules) => {
      if (cancelled) return;
      if (nativeSchedules !== null) {
        setSchedules((current) => mergeSchedules(current, nativeSchedules));
      } else {
        nativeScheduleWriterRef.current?.(schedulesRef.current);
      }
      nativeSchedulesHydratedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const wakeAt = nextSchedulerWakeAt(schedules);
    const syncWakeup = nativeSchedulerWakeupWriterRef.current;
    if (syncWakeup === null) return;
    void syncWakeup(wakeAt).then((status) => {
      if (!cancelled) setSchedulerWakeupStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [schedules]);

  useEffect(() => {
    saveReviewQueue(reviewQueue);
  }, [reviewQueue]);

  useEffect(() => {
    saveScheduleRuns(scheduleRuns);
    if (nativeScheduleRunsHydratedRef.current) {
      nativeScheduleRunsWriterRef.current?.(scheduleRuns);
    }
  }, [scheduleRuns]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void loadNativeScheduleRuns().then((nativeRuns) => {
      if (cancelled) return;
      if (nativeRuns !== null) {
        setScheduleRuns((current) => mergeScheduleRuns(current, nativeRuns));
      } else {
        nativeScheduleRunsWriterRef.current?.(scheduleRunsRef.current);
      }
      nativeScheduleRunsHydratedRef.current = true;
      setNativeScheduleRunsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveNotifications(notifications);
    if (nativeNotificationsHydratedRef.current) {
      nativeNotificationWriterRef.current?.(notifications);
    }
  }, [notifications]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void loadNativeNotifications().then((nativeNotifications) => {
      if (cancelled) return;
      if (nativeNotifications !== null) {
        setNotifications((current) => mergeNotifications(current, nativeNotifications));
      } else {
        nativeNotificationWriterRef.current?.(notificationsRef.current);
      }
      nativeNotificationsHydratedRef.current = true;
      setNativeNotificationsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveNotificationPreferences(notificationPreferences);
  }, [notificationPreferences]);

  // M3-09: terminal scheduled runs become durable inbox notifications. The
  // first render only hydrates the seen set so a restart does not replay every
  // historical completion as a desktop toast.
  const observedTerminalRuns = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!nativeScheduleRunsReady) return;
    const terminal = new Set(
      scheduleRuns
        .filter((run) => run.status === "completed" || run.status === "failed")
        .map((run) => `${run.id}:${run.status}:${run.finishedAt ?? ""}`),
    );
    if (observedTerminalRuns.current === null) {
      observedTerminalRuns.current = terminal;
      return;
    }
    const fresh = scheduleRuns.filter((run) => {
      if (run.status !== "completed" && run.status !== "failed") return false;
      return !observedTerminalRuns.current?.has(`${run.id}:${run.status}:${run.finishedAt ?? ""}`);
    });
    observedTerminalRuns.current = terminal;
    if (fresh.length === 0) return;
    const built = fresh.map((run) => buildRunNotification(run)).filter(
      (item): item is MuseNotification => item !== null,
    );
    if (built.length > 0) {
      setNotifications((cur) => built.reduce(appendNotification, cur));
    }
  }, [nativeScheduleRunsReady, scheduleRuns]);

  // Desktop toasts are best-effort. The in-app notification list remains the
  // source of truth when the browser API is denied or unavailable.
  const deliveredNotificationIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!nativeNotificationsReady) return;
    if (deliveredNotificationIds.current === null) {
      deliveredNotificationIds.current = new Set(notifications.map((item) => item.id));
      return;
    }
    for (const item of notifications) {
      if (!item.unread || deliveredNotificationIds.current.has(item.id)) continue;
      deliveredNotificationIds.current.add(item.id);
      if (!notificationPreferences.desktopMuted) void deliverDesktopNotification(item);
    }
  }, [nativeNotificationsReady, notifications, notificationPreferences.desktopMuted]);

  // Approval and answerable-input prompts are attention notifications. They
  // are in-memory host state, so an app restart does not replay stale prompts.
  const observedAttentionRequests = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set([
      ...approvals.map((item) => `approval:${item.session_id}:${item.request_id}`),
      ...inputRequests.map((item) => `input:${item.session_id}:${item.input_id}`),
    ]);
    if (observedAttentionRequests.current === null) {
      observedAttentionRequests.current = current;
      return;
    }
    const previous = observedAttentionRequests.current;
    const freshApprovals = approvals.filter((item) =>
      !previous.has(`approval:${item.session_id}:${item.request_id}`),
    );
    const freshInputs = inputRequests.filter((item) =>
      !previous.has(`input:${item.session_id}:${item.input_id}`),
    );
    observedAttentionRequests.current = current;
    const built = [
      ...freshApprovals.map((item) => buildApprovalNotification({
        sessionId: item.session_id,
        requestId: item.request_id,
        toolName: item.toolName,
        summary: item.summary,
      })),
      ...freshInputs.map((item) => buildInputNotification({
        sessionId: item.session_id,
        inputId: item.input_id,
        toolName: item.tool_name,
        questionCount: item.questions.length,
      })),
    ];
    if (built.length > 0) {
      setNotifications((cur) => built.reduce(appendNotification, cur));
    }
  }, [approvals, inputRequests]);

  const enableNotifications = useCallback(async (): Promise<NotificationPermission> => {
    const next = await requestNotificationPermission();
    setNotificationPermissionState(next);
    return next;
  }, []);

  const setNotificationsMuted = useCallback((muted: boolean): void => {
    setNotificationPreferences({ desktopMuted: muted });
  }, []);

  const markNotificationRead = useCallback((id: string): void => {
    setNotifications((cur) => markNotificationReadRow(cur, id));
  }, []);

  const markAllNotificationsRead = useCallback((): void => {
    setNotifications((cur) => markAllNotificationsReadRows(cur));
  }, []);

  // US-9 client-side scheduler: no workflow/* MSP endpoint exists, so a
  // bounded UI-side scheduler admits due schedules. Ask mode enters review;
  // workspace/YOLO mode creates a run record and dispatches automatically.
  // Refs stay fresh where timeout-closure deps would go stale.
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const reviewQueueRef = useRef(reviewQueue);
  reviewQueueRef.current = reviewQueue;
  const scheduleRunsRef = useRef(scheduleRuns);
  scheduleRunsRef.current = scheduleRuns;
  const schedulerLeaseOwner = useRef(`scheduler-${newId()}`);
  const schedulerLeaseMode = useRef<"native" | "local" | "none">("none");
  const schedulerCheckInFlight = useRef(false);
  const schedulerCheckPromise = useRef<Promise<void> | null>(null);
  const scheduledExecutorRef = useRef<((item: ReviewItem, run: ScheduleRun) => Promise<void>) | null>(null);
  useEffect(() => {
    const check = (): Promise<void> => {
      if (schedulerCheckInFlight.current) return schedulerCheckPromise.current ?? Promise.resolve();
      schedulerCheckInFlight.current = true;
      const owner = schedulerLeaseOwner.current;
      const task = tryAcquireNativeSchedulerLease(owner).then((nativeClaim) => {
      const acquired = nativeClaim === null
        ? tryAcquireSchedulerLease(owner, Date.now())
        : nativeClaim;
      schedulerLeaseMode.current = nativeClaim === null
        ? (acquired ? "local" : "none")
        : (acquired ? "native" : "none");
      setSchedulerStatus(schedulerRuntimeStatusFromProbe(nativeClaim, acquired, Date.now()));
      if (!acquired) return;
      if (nativeClaim === null) {
        renewSchedulerLease(owner, Date.now());
      } else {
        void renewNativeSchedulerLease(owner);
      }
      const res = enqueueDue(schedulesRef.current, reviewQueueRef.current, Date.now());
      if (res.added.length === 0) {
        // `skip` can consume missed cron slots without creating a run. Keep
        // that cursor durable or the same missed window would be revisited.
        if (res.schedules.some((row, index) => row.lastFiredAt !== schedulesRef.current[index]?.lastFiredAt)) {
          setSchedules(res.schedules);
        }
      } else {
        setSchedules(res.schedules);
        const automatic = res.added.filter((item) => item.authorizationMode !== "ask");
        const automaticIds = new Set(automatic.map((item) => item.id));
        setReviewQueue(res.queue.filter((item) => !automaticIds.has(item.id)));
        for (const item of automatic) {
          const occurrenceKey = item.occurrenceKey;
          if (occurrenceKey && scheduleRunsRef.current.some((run) =>
            (run.occurrenceKey ?? `${run.scheduleId}:${run.occurrenceAt}`) === occurrenceKey,
          )) {
            // The schedule cursor and run ledger are both durable. If a
            // restored queue ever replays the same occurrence, claim it once.
            continue;
          }
          const run = createScheduleRun({
            scheduleId: item.scheduleId,
            scheduleName: item.scheduleName,
            instructions: item.instructions,
            threadReuse: item.threadReuse,
            ...(item.workspace ? { workspace: item.workspace } : {}),
            ...(item.projectId ? { projectId: item.projectId } : {}),
            ...(item.model ? { model: item.model } : {}),
            ...(item.authorizationMode ? { authorizationMode: item.authorizationMode } : {}),
            ...(item.missedPolicy ? { missedPolicy: item.missedPolicy } : {}),
            ...(item.timeZone ? { timeZone: item.timeZone } : {}),
            occurrenceAt: item.occurrenceAt ?? item.createdAt,
            ...(item.occurrenceKey ? { occurrenceKey: item.occurrenceKey } : {}),
          }, Date.now());
          setScheduleRuns((cur) => appendRun(cur, run));
          void scheduledExecutorRef.current?.(item, run);
        }
      }
      const now = Date.now();
      const retries = scheduleRunsRef.current.filter((run) =>
        run.status === "queued" && run.nextRetryAt !== undefined && run.nextRetryAt <= now,
      );
      for (const run of retries) {
        const item: ReviewItem = {
          id: `retry-${run.id}-${run.attempt ?? 1}`,
          scheduleId: run.scheduleId,
          scheduleName: run.scheduleName,
          instructions: run.instructions,
          threadReuse: run.threadReuse,
          ...(run.workspace ? { workspace: run.workspace } : {}),
          ...(run.projectId ? { projectId: run.projectId } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.authorizationMode ? { authorizationMode: run.authorizationMode } : {}),
          ...(run.missedPolicy ? { missedPolicy: run.missedPolicy } : {}),
          ...(run.timeZone ? { timeZone: run.timeZone } : {}),
          occurrenceAt: run.occurrenceAt,
          ...(run.occurrenceKey ? { occurrenceKey: run.occurrenceKey } : {}),
          createdAt: run.createdAt,
          status: "approved",
        };
        void scheduledExecutorRef.current?.(item, run);
      }
      }).catch(() => {
        schedulerLeaseMode.current = "none";
        setSchedulerStatus(schedulerRuntimeErrorStatus(Date.now()));
      }).finally(() => {
        schedulerCheckInFlight.current = false;
        schedulerCheckPromise.current = null;
      });
      schedulerCheckPromise.current = task;
      return task;
    };
    // Keep one adaptive timeout rather than setInterval: a suspended webview
    // can otherwise accumulate callbacks and race the lease/reconciliation
    // path when it becomes visible again.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNextCheck = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        void check().finally(scheduleNextCheck);
      }, 15000);
    };
    void check().finally(scheduleNextCheck);
    // A suspended renderer can miss several interval ticks. Re-check as soon
    // as the window becomes usable again so the persisted missed-run policy
    // is applied promptly instead of waiting for the next 15 s tick.
    const wake = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
      releaseSchedulerLease(schedulerLeaseOwner.current);
      if (schedulerLeaseMode.current === "native") {
        void releaseNativeSchedulerLease(schedulerLeaseOwner.current);
      }
      schedulerLeaseMode.current = "none";
    };
  }, []);
  // w-settings write-through persistence (best-effort, like the rest here).
  useEffect(() => {
    writeStorageJson(SETTINGS_KEY, sandbox);
  }, [sandbox]);

  useEffect(() => {
    writeStorageString(AUTHORIZATION_MODE_KEY, authorizationMode);
  }, [authorizationMode]);

  useEffect(() => {
    writeStorageJson(PROVIDER_MAP_KEY, providerMap);
  }, [providerMap]);
  // w-integrations write-through persistence.
  useEffect(() => {
    saveConnectors(connectors);
  }, [connectors]);

  useEffect(() => {
    saveSkills(skills);
  }, [skills]);
  // w-collab: write-through for share state + imported sessions. Keys stay
  // inside the muse-desktop.* namespace like the rest of persist.ts.
  useEffect(() => {
    saveShareState(shareState);
  }, [shareState]);

  useEffect(() => {
    saveImportedSessions(importedSessions);
  }, [importedSessions]);
  // US-19 write-through persistence (muse-desktop.browser.* keys).
  useEffect(() => {
    saveBrowserAnnotations(browserAnnotations);
  }, [browserAnnotations]);

  useEffect(() => {
    saveBrowserPermissions(browserPermissions);
  }, [browserPermissions]);

  useEffect(() => {
    saveMemories(memories);
  }, [memories]);

  useEffect(() => {
    if (lastScan !== null) saveLastScan(lastScan);
  }, [lastScan]);

  useEffect(() => {
    // null means "not loaded yet" (there is no clear-workspace action),
    // so never persist it over the stored value.
    if (workspace !== null) saveWorkspace(workspace);
  }, [workspace]);

  /** Append entries to a session log (state + disk), creating the session row if needed. */
  function pushLog(sessionId: string, entries: LogEntry[]): void {
    if (entries.length === 0) return;
    setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), ...entries] }));
    appendLog(sessionId, entries);
  }

  /**
   * US-4: build the local extractive summary of a thread now and record it
   * (disk + state) with a system note in the log. Stable across renders:
   * it only touches refs, setState and imports, so `sendInput` and the
   * auto-compact effect can safely depend on it.
   */
  const doCompact = useCallback((sessionId: string): void => {
    const log = logsRef.current[sessionId] ?? loadLog(sessionId);
    const summary = buildSummary(sessionId, log);
    saveSummary(summary);
    setSummaries((cur) => ({ ...cur, [sessionId]: summary }));
    const note: LogEntry = {
      id: newId(),
      ts: Date.now(),
      role: "system",
      text:
        `Thread compacted — local summary ready (${summary.entryCount} entries: ` +
        `${summary.decisions.length} decisions, ${summary.context.length} context, ` +
        `${summary.todos.length} to-dos). Open a new thread via "New From Summary".`,
    };
    setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), note] }));
    appendLog(sessionId, [note]);
  }, []);

  // US-4 auto-compaction: once a thread log reaches the persisted-log cap
  // (COMPACT_AUTO_ENTRIES == persist MAX_LOG_ENTRIES), build the local
  // summary once. The disk write inside doCompact is synchronous, so the
  // loadSummary guard stops the loop on the re-render the note triggers.
  useEffect(() => {
    for (const [sid, log] of Object.entries(logs)) {
      const effective = settingsForThread(globalSettings, projects, threadProjects, sid);
      if (
        effective.autoCompact &&
        log.length >= COMPACT_AUTO_ENTRIES &&
        loadSummary(sid) === null
      ) {
        doCompact(sid);
      }
    }
  }, [logs, doCompact, globalSettings, projects, threadProjects]);

  // US-4 server half: host occupancy per session (latest triple wins; the
  // host only emits on change). Never persisted — it is live host state.
  const [usageBySession, setUsageBySession] = useState<
    Record<string, ContextUsage>
  >({});
  const [serverCompactionBySession, setServerCompactionBySession] = useState<
    Record<string, ServerCompactionState>
  >({});
  const serverCompactionRef = useRef<Record<string, ServerCompactionState>>({});
  serverCompactionRef.current = serverCompactionBySession;

  const settleServerCompaction = useCallback(
    (sessionId: string, state: ServerCompactionState): void => {
      serverCompactionRef.current = {
        ...serverCompactionRef.current,
        [sessionId]: state,
      };
      setServerCompactionBySession(serverCompactionRef.current);
      if (state.status === "idle") return;
      window.setTimeout(() => {
        if (serverCompactionRef.current[sessionId]?.status !== state.status) return;
        const next = { ...serverCompactionRef.current };
        delete next[sessionId];
        serverCompactionRef.current = next;
        setServerCompactionBySession(next);
      }, state.status === "pending" ? 20_000 : 8_000);
    },
    [],
  );

  // US-4 server half: the real context gesture (`session/compact`).
  // User-clicked only — async host work is never fired automatically.
  // The ack is admission-only; `noop` is a success. Rejections carry the
  // friendly sentence mapped in Rust (`missing_run`, `run_active`).
  const serverCompact = useCallback(async (sessionId: string) => {
    if (serverCompactionRef.current[sessionId]?.status === "pending") return;
    settleServerCompaction(sessionId, { status: "pending" });
    let status: string;
    try {
      status = await invoke<string>("compact_session", { sessionId });
    } catch (e) {
      const message = userFacingError(
        `server compact failed: ${e instanceof Error ? e.message : String(e)}`,
        "Engine compaction could not be completed.",
      );
      settleServerCompaction(sessionId, { status: "error", message });
      const note: LogEntry = {
        id: newId(),
        ts: Date.now(),
        role: "system",
        text: `Server compaction failed — ${message}`,
      };
      setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), note] }));
      appendLog(sessionId, [note]);
      return;
    }
    const outcome: ServerCompactionState = status === "noop"
      ? { status: "noop" }
      : status === "accepted"
        ? { status: "accepted" }
        : { status: "error", message: "The host returned an unknown compaction result." };
    settleServerCompaction(sessionId, outcome);
    const note: LogEntry = {
      id: newId(),
      ts: Date.now(),
      role: "system",
      text:
        status === "noop"
          ? "Server compaction: nothing to compact (noop)."
          : status === "accepted"
            ? "Server compaction accepted — the host is working in the background."
            : "Server compaction failed — the host returned an unknown result.",
    };
    setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), note] }));
    appendLog(sessionId, [note]);
  }, []);

  // US-12 + US-21: extract assistant fenced blocks into versioned artifacts.
  // Only closed assistant entries not yet anchoring a version are merged:
  // a streaming entry keeps its id while its text grows, so extracting it
  // early would freeze a partial v1. The effect is idempotent and never
  // loops (it writes artifacts, not logs).
  useEffect(() => {
    let changed = false;
    const next: Record<string, Artifact[]> = { ...artifacts };
    for (const [sid, log] of Object.entries(logs)) {
      const cur = next[sid] ?? [];
      const anchored = new Set<string>();
      for (const a of cur) {
        for (const ver of a.versions) anchored.add(ver.sourceEntryId);
      }
      const fresh = log.filter(
        (e) => e.role === "assistant" && e.open !== true && !anchored.has(e.id),
      );
      if (fresh.length === 0) continue;
      const merged = mergeAssistantBlocks(
        cur,
        sid,
        fresh.map((e) => ({ entryId: e.id, text: e.text, ts: e.ts })),
      );
      if (JSON.stringify(merged) !== JSON.stringify(cur)) {
        next[sid] = merged;
        saveArtifacts(sid, merged);
        changed = true;
      }
    }
    if (changed) setArtifacts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  function ensureSessionRow(sessionId: string, ws: string | null): void {
    if (tombstoned.current?.has(sessionId)) return;
    setSessions((cur) => {
      if (cur.some((s) => s.session_id === sessionId)) return cur;
      return [
        ...cur,
        {
          session_id: sessionId,
          workspace: ws ?? "",
          title: `Session ${sessionId.slice(0, 8)}`,
          createdAt: Date.now(),
          running: true,
        },
      ];
    });
  }

  function markUnread(sessionId: string): void {
    if (activeId === sessionId) return;
    setSessions((cur) => withUnreadFlag(cur, sessionId, true));
  }

  const setConnectionState = useCallback(
    (sessionId: string, state: SessionConnectionState): void => {
      setConnectionBySession((cur) =>
        cur[sessionId] === state ? cur : { ...cur, [sessionId]: state },
      );
    },
    [],
  );

  const touchStreamActivity = useCallback(
    (sessionId: string, kind: string, at = Date.now()): void => {
      setStreamActivityBySession((cur) => {
        const previous = cur[sessionId];
        if (previous?.lastEventAt === at && previous.lastEventKind === kind) {
          return cur;
        }
        return {
          ...cur,
          [sessionId]: { lastEventAt: at, lastEventKind: kind },
        };
      });
      setRecoveryNoticeBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
    },
    [],
  );

  function closeOpenBlocks(sessionId: string, itemId?: string, turnId?: string): void {
    setLogs((cur) => {
      const log = cur[sessionId];
      if (!log || !log.some((e) => e.open)) return cur;
      // With an item id, close only that block: concurrent items keep
      // streaming into their own entries. Without one (turn end), close all.
      const next = log.map((e) =>
        e.open && (itemId === undefined || e.itemId === itemId)
          ? { ...e, open: false, ...(turnId ? { turnId } : {}) }
          : e,
      );
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  /**
   * US-10: paint the reflexive phase immediately (synchronously on send,
   * on turn/item start) as an empty open entry. The first delta coalesces
   * into it, so the stream is never blank pre-first-token. No-op when a
   * live entry already exists.
   */
  function ensurePlaceholder(
    sessionId: string,
    itemId?: string,
    agentId?: string,
    role: "assistant" | "thinking" | "tool" = "assistant",
    turnId?: string,
    initialText = "",
    richContent?: RichContent[],
    /** Host-internal child lane: created so its text stays out of the answer,
     *  never rendered as a controllable sub-agent block. */
    internal = false,
  ): void {
    const stamp = { id: newId(), ts: Date.now() };
    setLogs((cur) => {
      const next = upsertReflexivePlaceholder(cur[sessionId] ?? [], {
        itemId,
        agentId,
        role,
        turnId,
        initialText,
        richContent,
        internal,
        stamp,
      });
      if (next === (cur[sessionId] ?? [])) return cur;
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  /** US-10: remove a still-empty placeholder (send failed, no delta came). */
  function dropPlaceholder(sessionId: string): void {
    setLogs((cur) => {
      const log = cur[sessionId];
      if (!log) return cur;
      const next = dropEmptyPlaceholders(log);
      if (next === log) return cur;
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  function clearStopping(sessionId: string): void {
    delete stoppingBySessionRef.current[sessionId];
    setStoppingBySession((cur) => {
      if (!(sessionId in cur)) return cur;
      const next = { ...cur };
      delete next[sessionId];
      return next;
    });
  }

  function markResumePending(sessionId: string, source: ResumePending["source"]): void {
    const pending = { requestedAt: Date.now(), source };
    resumePendingBySessionRef.current = {
      ...resumePendingBySessionRef.current,
      [sessionId]: pending,
    };
    setResumePendingBySession((cur) => ({ ...cur, [sessionId]: pending }));
    // A successful decision means the host accepted work again even when an
    // older/reconnected session snapshot still says idle. Let the liveness
    // row represent that bridge until the next terminal or progress event.
    setSessions((cur) =>
      cur.map((session) =>
        session.session_id === sessionId ? { ...session, running: true } : session,
      ),
    );
    setConnectionState(sessionId, "connected");
  }

  function clearResumePending(sessionId: string): void {
    if (!(sessionId in resumePendingBySessionRef.current)) return;
    const nextRef = { ...resumePendingBySessionRef.current };
    delete nextRef[sessionId];
    resumePendingBySessionRef.current = nextRef;
    setResumePendingBySession((cur) => {
      if (!(sessionId in cur)) return cur;
      const next = { ...cur };
      delete next[sessionId];
      return next;
    });
  }

  function clearRetryScheduled(sessionId: string): void {
    setRetryScheduledBySession((cur) => {
      if (!(sessionId in cur)) return cur;
      const next = { ...cur };
      delete next[sessionId];
      return next;
    });
  }

  function clearTurnCompletion(sessionId: string): void {
    setTurnCompletionBySession((cur) => {
      if (!(sessionId in cur)) return cur;
      const next = { ...cur };
      delete next[sessionId];
      return next;
    });
  }

  /** M3-08: settle an admitted scheduled turn when the host actually stops. */
  function settleScheduleRunsForSession(
    sessionId: string,
    outcome: Parameters<typeof settleRunsForSession>[2],
  ): void {
    const log = logsRef.current[sessionId] ?? [];
    const lastAssistant = [...log].reverse().find((entry) =>
      entry.role === "assistant" && entry.text.trim().length > 0,
    );
    const preview = lastAssistant?.text.trim().replace(/\s+/g, " ").slice(0, 320);
    const resultSummary = outcome.status === "completed"
      ? mergeScheduleRunSummary(buildScheduleRunSummary(sessionId, log), outcome.resultFacts)
      : undefined;
    setScheduleRuns((cur) => {
      return settleRunsForSession(cur, sessionId, {
        ...outcome,
        ...(outcome.status === "completed" && preview ? { resultPreview: preview } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      }, Date.now());
    });
  }

  /** Update the ephemeral skill progress only when the event can belong to
   * the current invocation. A known turn id protects a new invocation from a
   * late completion event from the previous turn. */
  function updateSkillInvocationFromHost(
    sessionId: string,
    stage: SkillInvocationProgress["stage"],
    payload: string,
    detail: string,
  ): void {
    let incomingTurnId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed.turnId === "string" && parsed.turnId.length > 0) {
        incomingTurnId = parsed.turnId;
      }
    } catch {
      // Older hosts can emit an empty or plain-text status payload.
    }
    setSkillInvocationsBySession((current) => {
      const previous = current[sessionId];
      if (previous === undefined || previous.stage === "completed" || previous.stage === "failed") {
        return current;
      }
      if (previous.turnId !== undefined && incomingTurnId !== undefined && previous.turnId !== incomingTurnId) {
        return current;
      }
      return {
        ...current,
        [sessionId]: {
          ...previous,
          stage,
          updatedAt: Date.now(),
          ...(incomingTurnId && previous.turnId === undefined ? { turnId: incomingTurnId } : {}),
          detail,
        },
      };
    });
  }

  function handleEvent(evt: MuseEvent): void {
    const { session_id: sid, kind, payload } = evt;
    setEvtCount((c) => c + 1);
    if (!sid) return;
    // Deleted stays deleted: late in-flight events for a killed session are
    // dropped instead of resurrecting its row.
    if (tombstoned.current?.has(sid)) return;
    if (kind === "workspace_changed") {
      let changedPaths: string[] = [];
      try {
        const parsed = JSON.parse(payload) as { paths?: unknown };
        if (Array.isArray(parsed.paths)) {
          changedPaths = parsed.paths
            .filter((path): path is string => typeof path === "string" && path.length > 0)
            .slice(0, 20);
        }
      } catch {
        // Keep the stale marker even when an older watcher emits no payload.
      }
      setFilesBySession((cur) => {
        const previous = cur[sid] ?? emptyFilesBrowserState();
        const nextPaths = [...previous.changedPaths, ...changedPaths]
          .filter((path, index, all) => all.indexOf(path) === index)
          .slice(0, 20);
        return {
          ...cur,
          [sid]: { ...previous, stale: true, changedPaths: nextPaths },
        };
      });
      return;
    }
    if (kind === "workspace_watch_error") {
      setFilesBySession((cur) => ({
        ...cur,
        [sid]: {
          ...(cur[sid] ?? emptyFilesBrowserState()),
          error: `workspace watcher failed: ${payload}`,
        },
      }));
      return;
    }
    // The host owns branch identity. Keep only its bounded observation on the
    // conversation row; never derive it from the selected workspace or from
    // a renderer-side Git refresh. A detached HEAD is represented by the
    // absence of the optional local branch field.
    if (kind === "branch_changed") {
      let parsed: ReturnType<typeof parseBranchObservation> = null;
      try {
        parsed = parseBranchObservation(JSON.parse(payload));
      } catch {
        parsed = null;
      }
      if (parsed === null) return;
      const observation = parsed;
      touchStreamActivity(sid, kind);
      setConnectionState(sid, "connected");
      setSessions((cur) => cur.map((session) => {
        if (session.session_id !== sid) return session;
        const next = { ...session };
        if (observation.branch === null) delete next.branch;
        else next.branch = observation.branch;
        return next;
      }));
      return;
    }
    if (kind === "skill_changed") {
      // Refresh from the host rather than trusting notification contents;
      // notifications only invalidate the session-scoped catalogue.
      void refreshHostSkills(sid);
      return;
    }
    // Keep this heartbeat independent from log timestamps: a host status
    // event can prove progress even when it has no user-facing log line.
    touchStreamActivity(sid, kind);
    // A decision is an intentional gap in the host stream. Clear the bridge
    // marker only when a real host progress/terminal signal arrives; the
    // approval/input resolution itself is not enough to prove that the turn
    // resumed and must remain visible to the user.
    if (
      kind === "output" ||
      kind === "thinking" ||
      kind === "item_updated" ||
      kind === "subagent_event" ||
      kind === "item_done" ||
      isItemStartKind(kind) ||
      isRunningKind(kind) ||
      isStoppedKind(kind) ||
      kind === "host_exited"
    ) {
      clearResumePending(sid);
      clearRetryScheduled(sid);
    }
    if (kind !== "host_exited") setConnectionState(sid, "connected");
    if (
      activeId !== sid &&
      (kind === "output" ||
        kind === "thinking" ||
        kind === "item_updated" ||
        kind === "subagent_event" ||
        kind === "tool_request" ||
        kind === "input_request" ||
        kind === "input_settled" ||
        kind === "status")
    ) {
      markUnread(sid);
    }
    if (kind === "host_exited") {
      updateSkillInvocationFromHost(sid, "failed", payload, "Muse stopped before the skill invocation completed");
      setConnectedIds((cur) => cur.filter((id) => id !== sid));
      setGrantedCapabilitiesBySession((cur) => {
        if (!(sid in cur)) return cur;
        const next = { ...cur };
        delete next[sid];
        return next;
      });
      setConnectionState(sid, "disconnected");
      setHostApprovalModeBySession((cur) => {
        if (!(sid in cur)) return cur;
        const next = { ...cur };
        delete next[sid];
        return next;
      });
      clearStopping(sid);
      clearRetryScheduled(sid);
      // A full host was replaced to make room (`HOST_RECYCLED_MESSAGE` in
      // main.rs): opening this conversation again resumes it silently. A
      // crashed host keeps the manual Reconnect, so a crash cannot loop.
      if (payload.startsWith("Muse closed this conversation to make room")) {
        resumeAttemptedRef.current.delete(sid);
      }
    }
    if (kind === "output") {
      ensureSessionRow(sid, null);
      const { itemId, turnId, outputRef, richContent, text } = parseChunk(payload);
      if (turnId !== undefined) {
        turnIdsRef.current[sid] = turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        // Coalesce into the last open assistant entry, not merely the last
        // entry: an interleaved subagent/tool block must not fragment the turn.
        const i = lastOpenIndex(log, "assistant", undefined, itemId);
        let next: LogEntry[];
        if (i >= 0) {
          const merged = {
            ...log[i],
            text: log[i].text + text,
            itemId: itemId ?? log[i].itemId,
            ...(outputRef === undefined ? {} : { outputRef }),
            ...(richContent === undefined ? {} : { richContent }),
          };
          next = [...log.slice(0, i), merged, ...log.slice(i + 1)];
        } else {
          next = [
            ...log,
            { id: newId(), ts: Date.now(), role: "assistant" as LogRole, text, itemId, outputRef, ...(richContent === undefined ? {} : { richContent }), open: true },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      return;
    }
    if (kind === "thinking") {
      ensureSessionRow(sid, null);
      const { itemId, turnId, outputRef, richContent, text } = parseChunk(payload);
      if (turnId !== undefined) {
        turnIdsRef.current[sid] = turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      // A few hosts can deliver the first delta before item/started. Promote
      // the send-time placeholder first so the delta still lands in the
      // dedicated lane and never leaves a phantom assistant "thinking" row.
      ensurePlaceholder(sid, itemId, undefined, "thinking");
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        const i = lastOpenIndex(log, "thinking", undefined, itemId);
        let next: LogEntry[];
        if (i >= 0) {
          const prev = log[i];
          next = [
            ...log.slice(0, i),
            { ...prev, text: prev.text + text, itemId: itemId ?? prev.itemId, ...(outputRef === undefined ? {} : { outputRef }), ...(richContent === undefined ? {} : { richContent }) },
            ...log.slice(i + 1),
          ];
        } else {
          next = [
            ...log,
            {
              id: newId(),
              ts: Date.now(),
              role: "thinking" as LogRole,
              text,
              itemId,
              outputRef,
              ...(richContent === undefined ? {} : { richContent }),
              open: true,
            },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      return;
    }
    if (kind === "shell_output") {
      ensureSessionRow(sid, null);
      const { itemId, turnId, outputRef, richContent, text } = parseChunk(payload);
      if (turnId !== undefined) {
        turnIdsRef.current[sid] = turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        const i = lastOpenIndex(log, "tool", undefined, itemId);
        let next: LogEntry[];
        if (i >= 0) {
          const previous = log[i];
          const separator = previous.text.length > 0 && text.length > 0 ? "\n" : "";
          next = [
            ...log.slice(0, i),
            { ...previous, text: `${previous.text}${separator}${text}`, itemId: itemId ?? previous.itemId, ...(outputRef === undefined ? {} : { outputRef }), ...(richContent === undefined ? {} : { richContent }) },
            ...log.slice(i + 1),
          ];
        } else {
          next = [
            ...log,
            { id: newId(), ts: Date.now(), role: "tool", text, itemId, outputRef, ...(richContent === undefined ? {} : { richContent }), open: true },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      return;
    }
    if (kind === "subagent_event") {
      ensureSessionRow(sid, null);
      const parsed = parseSubagentPayload(payload);
      const terminalStatus = isTerminalSubagentStatus(parsed.status);
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        const i = lastOpenIndex(log, "subagent", parsed.agentId, parsed.itemId);
        let next: LogEntry[];
        if (i >= 0) {
          // Keep drill-down identity learned earlier: a bare delta must not
          // wipe the childSessionId announced at `item/started`.
          const prev = log[i];
          if (
            parsed.replace === true &&
            parsed.revision !== undefined &&
            prev.itemRevision !== undefined &&
            parsed.revision <= prev.itemRevision
          ) {
            return cur;
          }
          const nextText = parsed.replace === true
            ? (parsed.text.length > 0 ? parsed.text : prev.text)
            : prev.text + parsed.text;
          next = [
            ...log.slice(0, i),
            {
              ...prev,
              text: nextText,
              itemId: parsed.itemId ?? prev.itemId,
              subagentInternal:
                parsed.itemKind === undefined
                  ? prev.subagentInternal
                  : isInternalSubagentItemKind(parsed.itemKind),
              childSessionId: parsed.childSessionId ?? prev.childSessionId,
              objective: parsed.objective ?? prev.objective,
              subagentRole: parsed.role ?? prev.subagentRole,
              depth: parsed.depth ?? prev.depth,
              subagentStatus: parsed.status ?? prev.subagentStatus,
              ...(parsed.revision === undefined ? {} : { itemRevision: parsed.revision }),
              ...(terminalStatus ? { open: false } : {}),
            },
            ...log.slice(i + 1),
          ];
        } else {
          next = [
            ...log,
            {
              id: newId(),
              ts: Date.now(),
              role: "subagent" as LogRole,
              text: parsed.text,
              agentId: parsed.agentId,
              itemId: parsed.itemId,
              ...(parsed.itemKind === undefined
                ? {}
                : { subagentInternal: isInternalSubagentItemKind(parsed.itemKind) }),
              childSessionId: parsed.childSessionId,
              objective: parsed.objective,
              subagentRole: parsed.role,
              depth: parsed.depth,
              subagentStatus: parsed.status,
              ...(parsed.revision === undefined ? {} : { itemRevision: parsed.revision }),
              open: !terminalStatus,
            },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      return;
    }
    if (kind === "input_request") {
      ensureSessionRow(sid, null);
      clearResumePending(sid);
      const req = parseInputRequest(sid, payload);
      if (req === null) {
        pushLog(sid, [
          { id: newId(), ts: Date.now(), role: "system", text: "input requested (unparseable)" },
        ]);
        return;
      }
      setInputRequests((cur) => {
        const i = cur.findIndex(
          (r) => r.session_id === sid && r.input_id === req.input_id,
        );
        if (i >= 0) {
          const next = [...cur];
          next[i] = req;
          return next;
        }
        return [...cur, req];
      });
      pushLog(sid, [
        { id: newId(), ts: Date.now(), role: "tool", text: `Input requested: ${req.tool_name}` },
      ]);
      return;
    }
    if (kind === "input_settled") {
      let inputId = "";
      let outcome = "settled";
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (typeof obj.inputId === "string") inputId = obj.inputId;
        if (typeof obj.outcome === "string") outcome = obj.outcome;
      } catch {
        // keep defaults
      }
      if (inputId.length > 0) {
        setInputRequests((cur) =>
          cur.filter((r) => !(r.session_id === sid && r.input_id === inputId)),
        );
      }
      pushLog(sid, [
        { id: newId(), ts: Date.now(), role: "system", text: `Input ${outcome}` },
      ]);
      return;
    }
    if (kind === "item_updated") {
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(payload);
        if (typeof value === "object" && value !== null) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        return;
      }
      if (parsed === null) return;
      const nested = parsed?.item && typeof parsed.item === "object"
        ? parsed.item as Record<string, unknown>
        : null;
      const itemIdValue = parsed?.itemId ?? parsed?.id ?? nested?.itemId ?? nested?.id;
      const itemId = typeof itemIdValue === "string" ? itemIdValue : "";
      const textValue = parsed?.text ?? parsed?.content ?? nested?.text ?? nested?.content;
      const text = typeof textValue === "string" ? textValue : "";
      const richContent = parseRichContent(parsed?.richContent ?? nested?.richContent);
      const outputRefValue = parsed?.outputRef ?? parsed?.output_ref ?? nested?.outputRef ?? nested?.output_ref;
      const outputRef = typeof outputRefValue === "string" && outputRefValue.trim().length > 0
        ? outputRefValue.trim()
        : undefined;
      const terminalSnapshot = itemSnapshotIsTerminal(parsed);
      if (itemId.length === 0 || (!terminalSnapshot && text.length === 0 && richContent === undefined && outputRef === undefined)) return;
      const lane = itemSnapshotLane(parsed);
      const revisionValue = parsed?.revision ?? nested?.revision;
      const revision = typeof revisionValue === "number" && Number.isFinite(revisionValue)
        ? revisionValue
        : undefined;
      const turnIdValue = parsed?.turnId ?? parsed?.turn_id ?? nested?.turnId ?? nested?.turn_id;
      const turnId = typeof turnIdValue === "string" && turnIdValue.length > 0
        ? turnIdValue
        : undefined;
      const commandTextValue = parsed?.commandText ?? parsed?.command_text ?? nested?.commandText ?? nested?.command_text;
      const commandText = typeof commandTextValue === "string" ? commandTextValue : undefined;
      if (turnId !== undefined) {
        turnIdsRef.current[sid] = turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      setLogs((cur) => {
        const next = applyItemSnapshotUpdate(cur[sid] ?? [], {
          itemId,
          role: lane,
          text,
          ...(turnId === undefined ? {} : { turnId }),
          ...(commandText === undefined ? {} : { commandText }),
          ...(outputRef === undefined ? {} : { outputRef }),
          ...(richContent === undefined ? {} : { richContent }),
          ...(revision === undefined ? {} : { revision }),
          open: !terminalSnapshot,
          stamp: { id: newId(), ts: Date.now() },
        });
        if (next === cur[sid]) return cur;
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      if (lane !== "tool") {
        setSessions((cur) => cur.map((session) =>
          session.session_id === sid ? { ...session, running: true } : session,
        ));
      }
      return;
    }
    if (kind === "item_done") {
      // Close exactly the completed item; other open blocks keep streaming.
      ensureSessionRow(sid, null);
      let itemId: string | undefined;
      let turnId: string | undefined;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (typeof obj.itemId === "string" && obj.itemId.length > 0) itemId = obj.itemId;
        if (typeof obj.turnId === "string" && obj.turnId.length > 0) turnId = obj.turnId;
      } catch {
        // unparseable payload: close all, as before
      }
      closeOpenBlocks(sid, itemId, turnId);
      // w-collab US-27: a turn end (item_done without item id) refreshes
      // the auto snapshot; per-item completions never do (no spam).
      if (itemId === undefined) refreshAutoShare(sid);
      return;
    }
    // Hosts with a retry policy can explain the backoff directly. Keep this
    // in the live stream state so the transcript stays quiet and the user
    // can see the attempt/countdown instead of an indefinite thinking lane.
    if (kind === "turn/retryScheduled") {
      ensureSessionRow(sid, null);
      const retry = parseRetryScheduled(payload);
      if (retry === null) {
        // Older/incomplete hosts still get the generic bounded status copy.
        const text = statusLogText(kind, payload);
        if (text !== null) pushLog(sid, [{ id: newId(), ts: Date.now(), role: "system", text }]);
        return;
      }
      if (!shouldAcceptRetryScheduled(
        retry,
        turnIdsRef.current[sid],
        lastTerminalTurnIdsRef.current[sid],
      )) {
        // A reconnect can flush an older retry after a newer turn started or
        // after this turn already completed. Keep that stale notification out
        // of the live status and transcript.
        return;
      }
      if (retry.turnId !== undefined) {
        turnIdsRef.current[sid] = retry.turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      clearResumePending(sid);
      clearStopping(sid);
      setRetryScheduledBySession((cur) => ({ ...cur, [sid]: retry }));
      setSessions((cur) => cur.map((session) =>
        session.session_id === sid ? { ...session, running: true } : session,
      ));
      ensurePlaceholder(sid, undefined, undefined, "thinking", retry.turnId);
      return;
    }
    if (kind === "tool_request") {
      ensureSessionRow(sid, null);
      clearResumePending(sid);
      const req = parseApproval(sid, payload);
      // Compound shell commands reuse one approval id for every stage. An
      // updated tool_request replaces its choices and requirement while
      // retaining the original command preview and tool label when the host
      // omits them from the update notification.
      setApprovals((cur) => {
        const i = cur.findIndex(
          (a) => a.session_id === sid && a.request_id === req.request_id,
        );
        if (i < 0) return [...cur, req];
        const previous = cur[i];
        const next = [...cur];
        next[i] = {
          ...req,
          summary: req.summary || previous.summary,
          toolName: req.toolName === "tool" ? previous.toolName : req.toolName,
        };
        return next;
      });
      let updated = false;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        updated = obj.updated === true;
      } catch {
        // Legacy hosts do not tag update notifications; retain the original
        // log behavior for their payloads.
      }
      if (!updated) {
        pushLog(sid, [
          { id: newId(), ts: Date.now(), role: "tool", text: `Approval requested: ${req.summary}` },
        ]);
        // The first approval pauses the assistant lane. Later stage updates
        // must leave the resumed placeholder open while the next choice is
        // presented, otherwise the UI appears blank between clicks.
        if (shouldCloseApprovalLane(updated, resumePendingBySessionRef.current[sid] !== undefined)) {
          closeOpenBlocks(sid);
        }
      }
      return;
    }
    // US-4 server half: host occupancy triple. Latest wins, no log noise,
    // no persistence — the CompactBar reads it live. Malformed payloads
    // are dropped (the host only emits on change anyway).
    if (kind === "context_usage") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const usage = parseContextUsage(parsed);
      if (usage === null) return;
      setUsageBySession((cur) =>
        cur[sid] !== undefined &&
        cur[sid].pressure === usage.pressure &&
        cur[sid].usedTokens === usage.usedTokens &&
        cur[sid].windowTokens === usage.windowTokens
          ? cur
          : {
              ...cur,
              [sid]: {
                ...usage,
                ...(cur[sid]?.tokenUsage ? { tokenUsage: cur[sid].tokenUsage } : {}),
              },
            },
      );
      return;
    }
    // US-4 server half: host-reported token counters. Keep these separate
    // from the context occupancy triple: the host is the source of truth and
    // Muse never derives or persists provider totals locally.
    if (kind === "token_usage") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const tokenUsage = parseTokenUsage(parsed);
      if (tokenUsage === null) return;
      setUsageBySession((cur) => ({
        ...cur,
        [sid]: {
          ...(cur[sid] ?? { pressure: "unknown", usedTokens: null, windowTokens: null }),
          tokenUsage,
        },
      }));
      return;
    }
    if (kind === "approval_mode_changed") {
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const hostMode = typeof obj.mode === "string" ? obj.mode : "";
        const mapped = productAuthorizationMode(hostMode);
        if (mapped === null) {
          setError(`The host reported an unsupported approval mode: ${hostMode || "unknown"}.`);
          return;
        }
        setHostApprovalModeBySession((cur) => ({ ...cur, [sid]: hostMode }));
        // The notification is scoped to this session. Keep it as the host
        // projection used by approval gating; never overwrite the global
        // selector or its persisted value from a delayed sibling event.
      } catch {
        setError("The host reported an invalid approval mode update.");
      }
      return;
    }
    // US-10: `item/started` paints before the first delta. Ensure a visible
    // open block even when no chunk has landed yet (no system-line noise,
    // and other open items keep streaming).
    if (isItemStartKind(kind)) {
      updateSkillInvocationFromHost(sid, "running", payload, "Muse is executing the skill");
      ensureSessionRow(sid, null);
      let itemId: string | undefined;
      let turnId: string | undefined;
      let agentId: string | undefined;
      let itemRole: "assistant" | "thinking" | "tool" = "assistant";
      let initialText = "";
      let richContent: RichContent[] | undefined;
      let subagentInternal = false;
      let modelToolCall = false;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const rawId = obj.itemId ?? obj.id;
        if (typeof rawId === "string" && rawId.length > 0) itemId = rawId;
        if (typeof obj.turnId === "string" && obj.turnId.length > 0) turnId = obj.turnId;
        richContent = parseRichContent(obj.richContent);
        const rawKind = obj.itemKind ?? obj.kind;
        if (typeof rawKind === "string") {
          if (isSubagentItemKind(rawKind)) {
            agentId = itemId ?? "agent";
            // Host-internal housekeeping (`reminderchild`) keeps a lane so its
            // text cannot leak into the answer, but never a control console.
            subagentInternal = isInternalSubagentItemKind(rawKind);
          } else if (isThinkingItemKind(rawKind)) {
            itemRole = "thinking";
          } else if (rawKind.toLowerCase().replace(/[\s_-]+/g, "") === "usershell") {
            itemRole = "tool";
            const commandText = obj.commandText;
            if (typeof commandText === "string" && commandText.trim().length > 0) {
              initialText = `$ ${commandText.trim()}`;
            }
          } else if (rawKind.toLowerCase() === "toolcall") {
            // The model's own tool call: a tool row named by its summary
            // ("powershell · List directory names"), not an empty assistant
            // message that read as "thinking…" while a command ran or hung.
            itemRole = "tool";
            modelToolCall = true;
            initialText = typeof obj.toolSummary === "string" && obj.toolSummary.trim().length > 0
              ? obj.toolSummary.trim()
              : "Tool call";
          }
        }
      } catch {
        // unparseable payload: still show the reflexive phase
      }
      if (turnId !== undefined) {
        turnIdsRef.current[sid] = turnId;
        delete lastTerminalTurnIdsRef.current[sid];
      }
      // A user shell runs outside any turn; the model's tool call is its turn.
      if (itemRole !== "tool" || modelToolCall) {
        setSessions((cur) =>
          cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
        );
      }
      ensurePlaceholder(sid, itemId, agentId, itemRole, turnId, initialText, richContent, subagentInternal);
      return;
    }
    // status (and any future kinds): record + reflect liveness.
    ensureSessionRow(sid, null);
    if (kind === "started") {
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (typeof obj.turnId === "string" && obj.turnId.length > 0) {
          turnIdsRef.current[sid] = obj.turnId;
          if (lastTerminalTurnIdsRef.current[sid] !== obj.turnId) {
            delete lastTerminalTurnIdsRef.current[sid];
          }
          setQueuedTurnsBySession((cur) => {
            const queued = cur[sid];
            if (!queued || !queued.some((turn) => turn.turn_id === obj.turnId)) return cur;
            const next = { ...cur, [sid]: queued.filter((turn) => turn.turn_id !== obj.turnId) };
            if (next[sid].length === 0) delete next[sid];
            return next;
          });
        }
      } catch {
        // Older supervisor builds may emit an empty started payload.
      }
    }
    if (kind === "turn/unqueued") {
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const queuedTurnId = typeof obj.turnId === "string" ? obj.turnId : "";
        if (queuedTurnId.length > 0) {
          setRetryScheduledBySession((cur) => {
            const retry = cur[sid];
            if (retry?.turnId !== queuedTurnId) return cur;
            const next = { ...cur };
            delete next[sid];
            return next;
          });
          setQueuedTurnsBySession((cur) => {
            const queued = cur[sid] ?? [];
            const next = { ...cur, [sid]: queued.filter((turn) => turn.turn_id !== queuedTurnId) };
            if (next[sid].length === 0) delete next[sid];
            return next;
          });
        }
      } catch {
        // Keep the queue card until the explicit command result settles.
      }
    }
    const completion = kind !== "host_exited" && isStoppedKind(kind)
      ? parseTurnCompletion(kind, payload)
      : null;
    if (isRunningKind(kind)) {
      updateSkillInvocationFromHost(sid, "running", payload, "Muse is executing the skill");
      clearStopping(sid);
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      // A (re)start must never blank the stream: keep/paint the reflexive
      // placeholder instead of closing it (US-10).
      ensurePlaceholder(sid);
    } else if (isStoppedKind(kind)) {
      if (completion !== null) {
        setTurnCompletionBySession((cur) => ({ ...cur, [sid]: completion }));
        setGitTurnSnapshotsBySession((cur) => {
          const previous = cur[sid];
          if (!previous) return cur;
          if (
            previous.turnId !== null &&
            completion.turnId !== undefined &&
            previous.turnId !== completion.turnId
          ) {
            return cur;
          }
          const phase: GitTurnSnapshot["phase"] = completion.error ? "failed" : "completed";
          const next: GitTurnSnapshot = {
            ...previous,
            phase,
            ...(completion.turnId ? { turnId: completion.turnId } : {}),
          };
          saveGitTurnSnapshot(sid, next);
          return { ...cur, [sid]: next };
        });
      }
      if (completion?.turnId !== undefined) {
        lastTerminalTurnIdsRef.current[sid] = completion.turnId;
        // Older hosts may omit item/completed. Preserve the exact turn anchor
        // on any remaining open lane before closing it.
        closeOpenBlocks(sid, undefined, completion.turnId);
      }
      // A cancelled turn says so in the transcript, as Claude Code's
      // "Interrupted": otherwise it simply ended on a half-run tool call.
      if (completion !== null && /cancel|interrupt|stop/i.test(completion.terminal)) {
        const stoppedTurn = completion.turnId;
        setLogs((cur) => {
          const log = cur[sid] ?? [];
          if (log.some((e) => e.role === "system" && e.text === "Stopped" && e.turnId === stoppedTurn)) return cur;
          const note: LogEntry = {
            id: newId(),
            ts: Date.now(),
            role: "system",
            text: "Stopped",
            ...(stoppedTurn === undefined ? {} : { turnId: stoppedTurn }),
          };
          const next = [...log, note];
          saveLog(sid, next);
          return { ...cur, [sid]: next };
        });
      }
      clearStopping(sid);
      delete turnIdsRef.current[sid];
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: false } : s)),
      );
      const failure = completion?.error;
      updateSkillInvocationFromHost(
        sid,
        failure ? "failed" : "completed",
        payload,
        failure?.message ?? "Muse completed the skill invocation",
      );
      settleScheduleRunsForSession(sid, failure
        ? { status: "failed", error: failure.message, retryable: failure.retryable }
        : kind === "host_exited"
          ? { status: "failed", error: "host exited before the scheduled turn completed", retryable: false }
          : {
              status: "completed",
              ...(completion?.resultPreview ? { resultPreview: completion.resultPreview } : {}),
              ...(completion?.resultIssues || completion?.resultNextSteps
                ? {
                    resultFacts: {
                      ...(completion.resultIssues ? { issues: completion.resultIssues } : {}),
                      ...(completion.resultNextSteps ? { nextSteps: completion.resultNextSteps } : {}),
                    },
                  }
                : {}),
            });
    }
    const isApprovalStatus = kind === "approval/resolved" || kind === "approval/updated" || kind === "approval_mode_changed";
    if (kind === "approval/resolved") {
      // The host can settle an approval independently of the click promise
      // (for example after a reconnect). Reconcile the durable card by id;
      // never leave a stale request blocking the conversation.
      const resolution = parseApprovalResolution(payload);
      if (resolution.approvalId !== null) {
        setApprovals((cur) =>
          cur.filter(
            (a) => !(a.session_id === sid && a.request_id === resolution.approvalId),
          ),
        );
      }
      // A resolution can be observed after a reconnect, without a local
      // approve() promise having painted the resume bridge. Treat only an
      // explicitly accepted decision as resumed work; denials still settle
      // through the host's terminal event without a misleading spinner.
      if (resolution.accepted) {
        if (resolution.turnId !== undefined) {
          turnIdsRef.current[sid] = resolution.turnId;
          delete lastTerminalTurnIdsRef.current[sid];
        }
        ensurePlaceholder(sid);
        markResumePending(sid, "approval");
        kickPoll();
      }
    }
    if (!isApprovalStatus) {
      if (completion?.error !== null && completion?.error !== undefined) {
        const failure: EngineErrorDetails = completion.error;
        pushLog(sid, [{
          id: newId(),
          ts: Date.now(),
          role: "system",
          text: engineErrorSummary(failure),
          engineError: failure,
        }]);
      } else if (completion === null) {
        // Only lifecycle events with an explicit user-facing consequence enter
        // the transcript. Protocol housekeeping and unknown future statuses
        // remain in the live stream/diagnostics instead of leaking raw JSON.
        const text = statusLogText(kind, payload);
        if (text !== null) {
          pushLog(sid, [{ id: newId(), ts: Date.now(), role: "system", text }]);
        }
      }
    }
    // Closing a (re)start would kill the just-painted placeholder; only
    // settle blocks for turn-end statuses. Approval updates are protocol
    // bookkeeping and must leave the resumed assistant block open.
    if (!isRunningKind(kind) && !isApprovalStatus) closeOpenBlocks(sid);
    // w-collab US-27: a stopped status also ends the turn — refresh the
    // auto snapshot (no-op unless the share mode is auto). Idempotent
    // with the item_done trigger above: one live auto bundle per session.
    if (isStoppedKind(kind)) refreshAutoShare(sid);
  }

  const setWorkspace = useCallback((path: string) => {
    setWorkspaceState(path);
    saveWorkspace(path);
    // Rust holds the pick as source of truth too (fire-and-forget: a stale
    // start_session arg can then still resolve server-side).
    void invoke<string>("set_workspace", { path }).catch(() => {});
  }, []);

  // w-settings: whole-object sandbox setter (the panel builds the next
  // object, including the explicit network/elevated permission toggles).
  const setSandbox = useCallback((next: SandboxSettings) => {
    setSandboxState(parseSandboxSettings(next));
  }, []);

  const restartHost = useCallback(async (workspacePath?: string | null): Promise<boolean> => {
    if (!isTauriRuntime()) {
      setError("Restarting a Muse host is available in the desktop app.");
      return false;
    }
    const target = workspacePath?.trim() || workspace?.trim();
    if (!target) {
      setError("Pick a workspace folder before restarting the Muse host.");
      return false;
    }
    try {
      setError(null);
      await invoke("restart_host", {
        workspacePath: target,
        sandboxMode: effectiveSandboxMode(sandbox),
        sandboxDisableWrite: false,
        sandboxDisableShell: false,
      });
      return true;
    } catch (e) {
      setError(`Host restart failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [sandbox, workspace]);

  const setAuthorizationMode = useCallback((mode: AuthorizationMode) => {
    const next = parseAuthorizationMode(mode);
    setAuthorizationModeState(next);
    if (!isTauriRuntime()) return;
    const targets = sessions.filter((session) =>
      connectedIds.includes(session.session_id),
    );
    if (targets.length === 0) return;
    // Until each host confirms the same closed MSP mode, suspend automatic
    // decisions for these sessions. A local preference is never authority
    // enough to bypass a host ceiling (for example promptUnmatched).
    setHostApprovalModeBySession((cur) => targets.reduce(
      (next, session) => ({ ...next, [session.session_id]: null }),
      { ...cur },
    ));
    // The host applies the new posture to subsequent actions. Pending
    // approvals remain race-guarded by their current requirement token.
    void Promise.allSettled(
      targets.map(async (session) => {
        const result = await invoke<Record<string, unknown>>("set_approval_mode", {
          sessionId: session.session_id,
          mode: next,
        });
        const effective = (result.effectiveMode as Record<string, unknown> | undefined)?.mode;
        if (result.status !== "accepted" || effective !== hostApprovalMode(next)) {
          throw new Error("host did not confirm the requested approval posture");
        }
        return session.session_id;
      }),
    ).then((results) => {
      const succeeded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.length - succeeded.length;
      setHostApprovalModeBySession((cur) => {
        const nextState = { ...cur };
        for (const sessionId of succeeded) nextState[sessionId] = hostApprovalMode(next);
        for (const session of targets) {
          if (!succeeded.includes(session.session_id)) nextState[session.session_id] = null;
        }
        return nextState;
      });
      if (failed > 0) {
        const firstRejection = results.find((result) => result.status === "rejected");
        const reason = firstRejection?.status === "rejected"
          ? ` First reason: ${userFacingError(firstRejection.reason)}`
          : "";
        setError(
          `${authorizationModeLabel(next)} saved locally, but ${failed} conversation${failed === 1 ? "" : "s"} could not update the host.${reason}`,
        );
      }
    });
  }, [connectedIds, sessions]);

  // w-settings: provider selection is per project (project id = workspace).
  const setProviderId = useCallback((id: string) => {
    setProviderMap((cur) => {
      const ws = workspace ?? loadWorkspace() ?? "";
      if (ws.length === 0) return cur;
      const checked = parseProviderId(id);
      if (cur[ws] === checked) return cur;
      return { ...cur, [ws]: checked };
    });
  }, [workspace]);

  // US-31: live host catalog. Null until the first successful load (the
  // panel falls back to the sample registry); failures record modelsError
  // instead of clobbering the banner — a picker must degrade, not shout.
  const [liveModels, setLiveModels] = useState<LiveModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const refreshModels = useCallback(async (sessionId?: string) => {
    try {
      const raw = await invoke("list_models", {
        sessionId: sessionId ?? null,
      });
      setLiveModels(parseModelList(raw));
      setModelsError(null);
    } catch (e) {
      setLiveModels(null);
      setModelsError(
        `model catalog unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, []);

  // US-31: model-picker gesture (`session/setModel`) on one session, then
  // reload so the host-flagged `isActive` row follows the choice.
  const setSessionModel = useCallback(
    async (sessionId: string, modelId: string) => {
      const target = liveModels?.find((m) => m.modelId === modelId) ?? null;
      try {
        await invoke("set_model", {
          sessionId,
          modelId,
          providerId: target?.providerId ?? null,
          profileId: target?.profileId ?? null,
        });
        setSessions((current) => current.map((session) =>
          session.session_id === sessionId ? { ...session, model_id: modelId } : session,
        ));
        setModelsError(null);
      } catch (e) {
        setError(
          `set model failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      await refreshModels(sessionId);
    },
    [liveModels, refreshModels],
  );

  const setSessionReasoningEffort = useCallback(
    async (
      sessionId: string,
      reasoningEffort: ProjectSettings["reasoningEffort"],
    ): Promise<boolean> => {
      try {
        await invoke("set_reasoning_effort", { sessionId, reasoningEffort });
        setError(null);
        return true;
      } catch (e) {
        setError(
          `set reasoning effort failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },
    [],
  );

  // w-settings: out-of-scope attempts (path outside cwd) route to the
  // existing scope-guard prompt path — the backend `check_scope` verdict,
  // with an error-banner prompt when access is denied.
  const checkPathScope = useCallback(async (path: string): Promise<ScopeVerdict> => {
    const verdict = await checkScope(path);
    if (!verdict.in_scope) {
      setError(`Scope guard: ${verdict.reason} — approval required before opening.`);
    }
    return verdict;
  }, []);

  const createWorktree = useCallback(
    async (sessionId: string, plan: WorktreePlan): Promise<WorktreeRecord | null> => {
      try {
        setError(null);
        const result = await invoke<WorktreeRecord>("git_worktree_create", {
          sessionId,
          branch: plan.branch,
          relativePath: plan.path,
          baseRef: plan.base,
        });
        setWorktrees((current) => [
          ...current.filter((record) => record.path !== result.path),
          result,
        ]);
        return result;
      } catch (e) {
        setError(`worktree creation failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  /**
   * Create the worktree a conversation will start in.
   *
   * The session does not exist yet, so the folder is passed explicitly and the
   * native command validates it as a directory. The record is registered here so
   * the retention and cleanup surfaces know about it from the first moment.
   */
  const createWorktreeForWorkspace = useCallback(
    async (workspace: string, plan: WorktreePlan): Promise<WorktreeRecord | null> => {
      try {
        setError(null);
        const result = await invoke<WorktreeRecord>("git_worktree_create_for_workspace", {
          workspace,
          branch: plan.branch,
          relativePath: plan.path,
          baseRef: plan.base,
        });
        setWorktrees((current) => [
          ...current.filter((record) => record.path !== result.path),
          result,
        ]);
        return result;
      } catch (e) {
        setError(`worktree creation failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const removeWorktree = useCallback(
    async (sessionId: string, record: WorktreeRecord): Promise<boolean> => {      setCleanupIntents((current) => requestWorktreeCleanup(current, record));
      try {
        setError(null);
        await invoke("git_worktree_remove", {
          sessionId,
          path: record.path,
        });
        setWorktrees((current) => current.filter((item) => item.path !== record.path));
        setCleanupIntents((current) => clearWorktreeCleanup(current, record));
        return true;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        setCleanupIntents((current) => markWorktreeCleanupFailed(current, record, detail));
        setError(`worktree removal failed: ${detail}`);
        return false;
      }
    },
    [],
  );

  const inspectWorktree = useCallback(
    async (
      sessionId: string,
      record: WorktreeRecord,
    ): Promise<WorktreeInspection | null> => {
      try {
        setError(null);
        return await invoke<WorktreeInspection>("git_worktree_inspect", {
          sessionId,
          path: record.path,
        });
      } catch (e) {
        setError(`worktree inspection failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const runWorktreeSetup = useCallback(
    async (
      sessionId: string,
      record: WorktreeRecord,
      command: string,
      envAllowlist: string[],
    ): Promise<WorktreeSetupResult | null> => {
      const validation = validateSetupCommand(command);
      if (validation !== null) {
        setError(validation);
        return null;
      }
      try {
        setError(null);
        const operationId = newId();
        const operationKey = `${sessionId}:${record.path}`;
        setupOperationsRef.current.set(operationKey, operationId);
        try {
          return await invoke<WorktreeSetupResult>("worktree_setup_run", {
            sessionId,
            path: record.path,
            command: command.trim(),
            operationId,
            envAllowlist,
          });
        } finally {
          if (setupOperationsRef.current.get(operationKey) === operationId) {
            setupOperationsRef.current.delete(operationKey);
          }
        }
      } catch (e) {
        setError(`worktree setup failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const checkWorktreeReadiness = useCallback(
    async (
      sessionId: string,
      record: WorktreeRecord,
    ): Promise<WorktreeReadiness | null> => {
      try {
        setError(null);
        return await invoke<WorktreeReadiness>("worktree_setup_readiness", {
          sessionId,
          path: record.path,
        });
      } catch (e) {
        setError(`worktree readiness failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const cancelWorktreeSetup = useCallback(
    async (sessionId: string, record: WorktreeRecord): Promise<boolean> => {
      const operationId = setupOperationsRef.current.get(`${sessionId}:${record.path}`);
      if (operationId === undefined) return false;
      try {
        return await invoke<boolean>("worktree_setup_cancel", {
          sessionId,
          operationId,
        });
      } catch (e) {
        setError(`worktree setup cancellation failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [],
  );

  const setActive = useCallback((id: string | null) => {
    if (id !== null) setSessions((cur) => withUnreadFlag(cur, id, false));
    setActiveId(id);
  }, []);

  // Shared session creation (US-4 `newFromSummary` reuses it so the fresh
  // thread goes through the exact same backend + state path as `+ New`).
  const startSessionRow = useCallback(
    async (
      workspaceOverride?: string,
      projectSettings?: ProjectSettings,
      projectSandboxSettings?: ProjectSettings,
    ): Promise<string | null> => {
    try {
      setError(null);
      // Live React state first: localStorage writes are best-effort and may
      // silently fail, which previously enabled the buttons while sending
      // workspace_path=null ("no workspace selected" from the backend).
      const ws = workspaceOverride?.trim() || workspace || loadWorkspace() || undefined;
      if (ws === undefined) {
        setError("Pick a workspace folder first.");
        return null;
      }
      const sandboxConfig = hostSandboxConfigForProject(sandbox, projectSandboxSettings);
      const meta = await invoke<BackendSessionMeta>("start_session", {
        workspacePath: ws,
        authorizationMode,
        sandboxMode: sandboxConfig.mode,
        sandboxDisableWrite: sandboxConfig.disableWrite,
        sandboxDisableShell: sandboxConfig.disableShell,
        mcpServers: buildHostMcpServers(connectorsRef.current, remoteSessionsRef.current, computerServerRef.current),
      });
      const requestedModelId = projectSettings?.model.trim();
      const record: MuseSession = {
        session_id: meta.session_id,
        workspace: meta.workspace,
        title: `Session ${meta.session_id.slice(0, 8)}`,
        createdAt: Date.now(),
        running: meta.running,
        ...(meta.session_durability ? { session_durability: meta.session_durability } : {}),
        ...(requestedModelId && requestedModelId !== "default"
          ? { model_id: requestedModelId }
          : {}),
      };
      setGrantedCapabilitiesBySession((cur) => ({
        ...cur,
        [meta.session_id]: meta.granted_capabilities,
      }));
      setConnectedIds((cur) => [...new Set([...cur, meta.session_id])]);
      setConnectionState(meta.session_id, "connected");
      if (typeof meta.approval_mode === "string" && meta.approval_mode.length > 0) {
        setHostApprovalModeBySession((cur) => ({ ...cur, [meta.session_id]: meta.approval_mode! }));
      }
      setSessions((cur) => [...cur, record]);
      setLogs((cur) => (cur[meta.session_id] ? cur : { ...cur, [meta.session_id]: [] }));
      setActiveId(meta.session_id);
      // The host only accepts model changes through session/setModel. Apply a
      // concrete project/global model after admission; `default` deliberately
      // leaves the engine's own default untouched.
      const modelId = requestedModelId;
      if (modelId && modelId !== "default") {
        await setSessionModel(meta.session_id, modelId);
      }
      if (projectSettings?.reasoningEffort !== undefined) {
        await setSessionReasoningEffort(meta.session_id, projectSettings.reasoningEffort);
      }
      void refreshHostSkills(meta.session_id);
      return meta.session_id;
    } catch (e) {
      setError(`start_session failed: ${String(e)}`);
      return null;
    }
    },
    [
      authorizationMode,
      sandbox,
      refreshHostSkills,
      setConnectionState,
      setSessionModel,
      setSessionReasoningEffort,
      workspace,
    ],
  );

  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);

  /**
   * Refresh the folded server state for a quiet turn without replacing its
   * live host. This is deliberately separate from reconnect: a dropped event
   * can leave the host healthy, and reattaching it would add unnecessary
   * lifecycle churn. All results flow back through the hook's SSOT.
   */
  const reconcileSession = useCallback(async (
    id: string,
    options: { silent?: boolean } = {},
  ): Promise<void> => {
    if (!isTauriRuntime()) return;
    const session = sessions.find((candidate) => candidate.session_id === id);
    if (!session) return;
    setReconcilingId(id);
    if (!options.silent) setError(null);
    try {
      const remote = await readHistoryEntries(id);
      // A history snapshot containing only the original user message is not
      // proof that the host resumed. Require a durable assistant/tool/reasoning
      // item before clearing the post-decision liveness marker.
      const progressFound = remote.some((entry) =>
        entry.role === "assistant" ||
        entry.role === "thinking" ||
        entry.role === "tool" ||
        entry.role === "subagent" ||
        entry.role === "system",
      );
      if (remote.length > 0) {
        const local = logsRef.current[id] ?? loadLog(id);
        const merged = mergeHistoryLog(local, remote);
        setLogs((cur) => ({ ...cur, [id]: merged }));
        saveLog(id, merged);
      }
      try {
        const pending = await invoke<unknown>("list_pending_requests", { sessionId: id });
        if (typeof pending === "object" && pending !== null) {
          const { approvals: nextApprovals, inputs: nextInputs } = parsePendingSnapshot(id, pending);
          setApprovals((cur) => [
            ...cur.filter((item) => item.session_id !== id),
            ...nextApprovals,
          ]);
          setInputRequests((cur) => [
            ...cur.filter((item) => item.session_id !== id),
            ...nextInputs,
          ]);
        }
      } catch {
        // Older hosts may not expose pending snapshots; history is still
        // useful and the explicit error below should not hide it.
      }
      await reconcileQueueSnapshot(id);
      if (progressFound) {
        touchStreamActivity(id, "history/reconciled");
        clearResumePending(id);
      }
      kickPoll();
    } catch (e) {
      setRecoveryNoticeBySession((cur) => ({
        ...cur,
        [id]: isMethodUnavailable(e) ? "unsupported" : "failed",
      }));
      if (!options.silent) {
        setError(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setReconcilingId(null);
    }
  }, [kickPoll, readHistoryEntries, reconcileQueueSnapshot, sessions, touchStreamActivity]);

  // A decision can be accepted while a host notification is lost or while an
  // older host simply stays quiet. Once the same liveness threshold is
  // reached, perform one bounded read of history and pending requests. This
  // is recovery only: it never invents a completion or clears the bridge
  // unless the host returns a durable progress item.
  useEffect(() => {
    const timers = resumeReconcileTimersRef.current;
    for (const [sessionId, entry] of Object.entries(timers)) {
      const pending = resumePendingBySession[sessionId];
      if (pending === undefined || pending.requestedAt !== entry.requestedAt) {
        clearTimeout(entry.timer);
        delete timers[sessionId];
      }
    }
    for (const [sessionId, pending] of Object.entries(resumePendingBySession)) {
      const existing = timers[sessionId];
      if (existing?.requestedAt === pending.requestedAt) continue;
      if (existing !== undefined) clearTimeout(existing.timer);
      const delay = resumeRecoveryDelay(pending.requestedAt);
      if (delay === null) continue;
      const timer = setTimeout(() => {
        delete timers[sessionId];
        if (!aliveRef.current) return;
        const current = resumePendingBySession[sessionId];
        if (current?.requestedAt !== pending.requestedAt) return;
        void reconcileSession(sessionId, { silent: true });
      }, delay);
      timers[sessionId] = { requestedAt: pending.requestedAt, timer };
    }
  }, [reconcileSession, resumePendingBySession]);

  useEffect(() => () => {
    for (const entry of Object.values(resumeReconcileTimersRef.current)) {
      clearTimeout(entry.timer);
    }
    resumeReconcileTimersRef.current = {};
  }, [settleServerCompaction]);

  const reconnectSession = useCallback(async (id: string, options?: { silent?: boolean }) => {
    const session = sessions.find((s) => s.session_id === id);
    if (!session || !isTauriRuntime()) return;
    const silent = options?.silent === true;
    if (isEphemeralSession(session)) {
      if (silent) {
        console.warn("boot resume skipped: ephemeral sessions cannot resume after a host restart", id);
        return;
      }
      setConnectionState(id, "error");
      setError("This Muse host uses ephemeral sessions. Your saved messages remain available, but this conversation cannot be resumed after the host restarts.");
      return;
    }
    if (!silent) setReconnectingId(id);
    setConnectionState(id, "connecting");
    if (!silent) setError(null);
    try {
      const projectSettings = threadProjects[id] !== undefined
        ? settingsForThread(globalSettings, projects, threadProjects, id)
        : undefined;
      const sandboxConfig = hostSandboxConfigForProject(sandbox, projectSettings);
      const meta = await invoke<BackendSessionMeta>("resume_session", {
        sessionId: id,
        workspacePath: session.workspace,
        sandboxMode: sandboxConfig.mode,
        sandboxDisableWrite: sandboxConfig.disableWrite,
        sandboxDisableShell: sandboxConfig.disableShell,
        mcpServers: buildHostMcpServers(connectorsRef.current, remoteSessionsRef.current, computerServerRef.current),
      });
      if (tombstoned.current?.has(id)) return;
      setGrantedCapabilitiesBySession((cur) => ({
        ...cur,
        [id]: meta.granted_capabilities,
      }));
      // `resume_session` is what loads a persisted conversation on the host, and
      // the terminal refuses "Run in Muse" while `loaded` is false. The restored
      // value is only a snapshot from boot, so the resumed one has to be written
      // back or the action stays disabled for the rest of the session.
      if (meta.loaded !== undefined) {
        setSessionLoadedBySession((cur) => ({ ...cur, [id]: meta.loaded }));
      }
      setSessions((cur) =>
        cur.map((session) =>
          session.session_id === id
            ? {
                ...session,
                title: withHostTitle(session.title, meta.title),
                ...(meta.model_id ? { model_id: meta.model_id } : {}),
              }
            : session,
        ),
      );
      // Resume restores the host's persisted posture. Reconcile it with the
      // current global selector before enabling the composer again. A host
      // ceiling must not make the saved conversation unusable: preserve the
      // observed projection and keep automatic approval fail-closed.
      let postureError: unknown = null;
      try {
        const posture = await invoke<Record<string, unknown>>("set_approval_mode", {
          sessionId: id,
          mode: authorizationMode,
        });
        const effective = (posture.effectiveMode as Record<string, unknown> | undefined)?.mode;
        if (typeof effective === "string") {
          setHostApprovalModeBySession((cur) => ({ ...cur, [id]: effective }));
        } else {
          postureError = new Error("host returned no effective approval mode");
          setHostApprovalModeBySession((cur) => ({ ...cur, [id]: null }));
        }
      } catch (error) {
        postureError = error;
        setHostApprovalModeBySession((cur) => ({
          ...cur,
          [id]: meta.approval_mode ?? null,
        }));
      }
      // Cold reconnects can outlive the renderer's local log (for example
      // after a storage reset or a crash during streaming). Reconcile the
      // folded server history before enabling the composer again. The read is
      // point-in-time and never re-emits pending requests; resume remains the
      // sole path that re-attaches the live session and restarts polling.
      try {
        const remote = await readHistoryEntries(id);
        if (remote.length > 0) {
          const local = logsRef.current[id] ?? loadLog(id);
          const merged = mergeHistoryLog(local, remote);
          setLogs((cur) => ({ ...cur, [id]: merged }));
          saveLog(id, merged);
        }
      } catch (historyError) {
        // A resumed session remains usable when an older host does not
        // implement inline history. Keep the local transcript and surface no
        // second blocking error; reconnect already proved the durable id.
        console.warn("session history hydration unavailable", historyError);
      }
      try {
        const pending = await invoke<unknown>("list_pending_requests", {
          sessionId: id,
        });
        if (typeof pending === "object" && pending !== null) {
          const { approvals: nextApprovals, inputs: nextInputs } = parsePendingSnapshot(id, pending);
          setApprovals((cur) => [
            ...cur.filter((item) => item.session_id !== id),
            ...nextApprovals,
          ]);
          setInputRequests((cur) => [
            ...cur.filter((item) => item.session_id !== id),
            ...nextInputs,
          ]);
        }
      } catch (pendingError) {
        // Resume still re-emits late-joiner requests on supported hosts. The
        // pull path is an additive recovery for hosts that expose the method.
        console.warn("pending request recovery unavailable", pendingError);
      }
      await reconcileQueueSnapshot(id);
      setConnectedIds((cur) => [...new Set([...cur, id])]);
      setConnectionState(id, "connected");
      clearStopping(id);
      setSessions((cur) => cur.map((s) => s.session_id === id ? { ...s, running: meta.running } : s));
      kickPoll();
      await refreshModels(id);
      await refreshHostSkills(id);
      if (postureError !== null) {
        if (silent) {
          console.warn("boot resume kept the host authorization posture", id);
        } else {
          setError("Conversation reconnected, but the host kept its existing authorization posture.");
        }
      }
    } catch (e) {
      if (silent) {
        console.warn("boot resume failed, staying disconnected", id, e);
        setConnectionState(id, "disconnected");
      } else {
        setConnectionState(id, "error");
        setError(reconnectErrorMessage(e));
      }
    } finally {
      setReconnectingId(null);
    }
  }, [authorizationMode, globalSettings, projects, readHistoryEntries, refreshHostSkills, sessions, threadProjects, kickPoll, refreshModels, reconcileQueueSnapshot, setConnectionState, sandbox]);

  // Resume on open: `restore_sessions` only admits sessions for
  // already-connected hosts, and hosts do not survive an app restart. Once
  // the backend restore settles, silently resume the open conversation so
  // Terminal/Files find their native route without a manual Reconnect — and
  // only that one: a host holds 32 loaded sessions and resuming every stored
  // row filled it (see lib/bootResume.ts). One automatic attempt per
  // conversation per run; a failure stays 'disconnected' for a manual Reconnect.
  useEffect(() => {
    if (!historyReady || !isTauriRuntime() || !restoreSettledRef.current) return;
    const id = selectResumeOnOpen({
      stored: sessions,
      restoredIds: connectedIds,
      tombstonedIds: tombstoned.current,
      activeId,
    });
    if (id === null || resumeAttemptedRef.current.has(id)) return;
    resumeAttemptedRef.current.add(id);
    void reconnectSession(id, { silent: true });
  }, [historyReady, activeId, connectedIds, sessions, reconnectSession]);


  const startSession = useCallback(async () => {
    return await startSessionRow(undefined, globalSettings, undefined);
  }, [globalSettings, startSessionRow]);

  const startSessionInWorkspace = useCallback(
    async (
      workspacePath: string,
      projectSettings?: ProjectSettings,
      projectId?: string,
    ) => {
      const sessionSettings = projectSettings ?? globalSettings;
      const sessionId = await startSessionRow(
        workspacePath,
        sessionSettings,
        projectSettings,
      );
      if (sessionId === null || projectId === undefined) return sessionId;
      // Attach before the caller can send the first turn. The ref is updated
      // synchronously so the send path uses the same project settings that
      // admitted this session, even before React re-renders.
      const next = attachThreadRow(
        threadProjectsRef.current,
        projectsRef.current,
        sessionId,
        projectId,
      );
      threadProjectsRef.current = next;
      setThreadProjects(next);
      return sessionId;
    },
    [globalSettings, startSessionRow],
  );

  const createWorktreeSession = useCallback(
    async (
      sessionId: string,
      plan: WorktreePlan,
      projectSettings?: ProjectSettings,
    ): Promise<WorktreeRecord | null> => {
      if (!isTauriRuntime()) {
        setError("Worktree conversations require the Muse Desktop runtime.");
        return null;
      }
      try {
        setError(null);
        const sessionSettings = projectSettings ?? globalSettings;
        const sandboxConfig = hostSandboxConfigForProject(sandbox, projectSettings);
        const result = await invoke<BackendWorktreeSessionResult>("git_worktree_create_session", {
          sessionId,
          branch: plan.branch,
          relativePath: plan.path,
          baseRef: plan.base,
          authorizationMode,
          sandboxMode: sandboxConfig.mode,
          sandboxDisableWrite: sandboxConfig.disableWrite,
          sandboxDisableShell: sandboxConfig.disableShell,
          mcpServers: buildHostMcpServers(connectorsRef.current, remoteSessionsRef.current, computerServerRef.current),
        });
        setWorktrees((current) => [
          ...current.filter((record) => record.path !== result.worktree.path),
          result.worktree,
        ]);
        const meta = result.session;
        const requestedModelId = sessionSettings.model.trim();
        const record: MuseSession = {
          session_id: meta.session_id,
          workspace: meta.workspace,
          title: `Session ${meta.session_id.slice(0, 8)}`,
          createdAt: Date.now(),
          running: meta.running,
          ...(meta.session_durability ? { session_durability: meta.session_durability } : {}),
          ...(requestedModelId && requestedModelId !== "default"
            ? { model_id: requestedModelId }
            : {}),
        };
        setGrantedCapabilitiesBySession((cur) => ({
          ...cur,
          [meta.session_id]: meta.granted_capabilities,
        }));
        setConnectedIds((current) => [...new Set([...current, meta.session_id])]);
        if (typeof meta.approval_mode === "string" && meta.approval_mode.length > 0) {
          setHostApprovalModeBySession((cur) => ({ ...cur, [meta.session_id]: meta.approval_mode! }));
        }
        setConnectionState(meta.session_id, "connected");
        setSessions((current) => [
          ...current.filter((session) => session.session_id !== meta.session_id),
          record,
        ]);
        setLogs((current) => (current[meta.session_id] ? current : { ...current, [meta.session_id]: [] }));
        setActiveId(meta.session_id);
        const modelId = requestedModelId;
        if (modelId && modelId !== "default") await setSessionModel(meta.session_id, modelId);
        if (sessionSettings.reasoningEffort !== undefined) {
          await setSessionReasoningEffort(meta.session_id, sessionSettings.reasoningEffort);
        }
        void refreshHostSkills(meta.session_id);
        return result.worktree;
      } catch (e) {
        setError(`worktree conversation failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [
      authorizationMode,
      sandbox,
      globalSettings,
      refreshHostSkills,
      setConnectionState,
      setSessionModel,
      setSessionReasoningEffort,
    ],
  );

  const [forkingId, setForkingId] = useState<string | null>(null);
  const forkSession = useCallback(
    async (sourceId: string, lastTurnId?: string): Promise<string | null> => {
      if (!isTauriRuntime() || forkingId !== null) return null;
      const source = sessions.find((session) => session.session_id === sourceId);
      if (!source) {
        setError("The source conversation is no longer available.");
        return null;
      }
      setForkingId(sourceId);
      setError(null);
      try {
        const meta = await invoke<BackendSessionMeta>("fork_session", {
          sessionId: sourceId,
          lastTurnId: lastTurnId?.trim() || null,
        });
        if (tombstoned.current?.has(meta.session_id)) {
          setError("The fork was created but is no longer available.");
          return null;
        }
        // The server owns the durable branch. Copy only completed local
        // entries for immediate continuity; live/open items belong to the
        // source turn and must not be replayed into the fork transcript.
        const inherited = (logsRef.current[sourceId] ?? loadLog(sourceId)).filter(
          (entry) => entry.open !== true,
        );
        const record: MuseSession = {
          session_id: meta.session_id,
          workspace: meta.workspace,
          title: `Branch of ${source.title || source.session_id.slice(0, 8)}`,
          createdAt: Date.now(),
          running: meta.running,
          ...(source.model_id ? { model_id: source.model_id } : {}),
          ...(meta.session_durability ? { session_durability: meta.session_durability } : {}),
        };
        setConnectedIds((current) => [...new Set([...current, meta.session_id])]);
        if (typeof meta.approval_mode === "string" && meta.approval_mode.length > 0) {
          setHostApprovalModeBySession((cur) => ({ ...cur, [meta.session_id]: meta.approval_mode! }));
        }
        setConnectionState(meta.session_id, "connected");
        setSessions((current) => [
          ...current.filter((session) => session.session_id !== meta.session_id),
          record,
        ]);
        setLogs((current) => ({ ...current, [meta.session_id]: inherited }));
        if (inherited.length > 0) appendLog(meta.session_id, inherited);
        setActiveId(meta.session_id);
        // A fork is a new host session, so the renderer-side copy of the
        // requested model must be applied through the same session/setModel
        // path as a normal start. Without this, Settings/Composer showed the
        // inherited model while the host silently used its default.
        if (source.model_id && source.model_id !== "default") {
          await setSessionModel(meta.session_id, source.model_id);
        }
        void refreshHostSkills(meta.session_id);
        return meta.session_id;
      } catch (error) {
        setError(forkFailureMessage(error));
        return null;
      } finally {
        setForkingId(null);
      }
    },
    [forkingId, refreshHostSkills, sessions, setConnectionState, setSessionModel],
  );

  // ---- w-integrations: connectors (US-24/US-26) + skills (US-25) ----
  // Hot-listed tools: re-read from the registry on every render, so a
  // fresh install lists without restart (no cache to invalidate).
  const connectorTools = useMemo(() => listConnectorTools(connectors), [connectors]);

  const installConnectorById = useCallback((dirId: string): void => {
    const r = installConnector(connectorsRef.current, dirId);
    if (r === null) {
      setError(`unknown connector "${dirId}": install from the curated directory.`);
      return;
    }
    setConnectors(r.registry);
  }, []);

  const disconnectRemoteMcp = useCallback((id: string): void => {
    delete remoteSessionsRef.current[id];
    setRemoteConnectedIds((current) => current.filter((item) => item !== id));
    setConnectors((current) => current.map((entry) => {
      if (entry.id !== id || entry.kind !== "remote") return entry;
      return {
        ...entry,
        status: "error",
        guardMessage: "Disconnected. Connect again to verify the remote endpoint.",
      };
    }));
  }, []);

  const forgetRemoteMcpCredential = useCallback(async (id: string): Promise<void> => {
    disconnectRemoteMcp(id);
    if (isTauriRuntime()) {
      try {
        await invoke("secure_store_remove", { key: remoteMcpCredentialKey(id) });
      } catch {
        setRemoteNotice("The remote session was disconnected, but its native credential could not be removed.");
        return;
      }
    }
    setRemoteNotice("Remote credential forgotten. Reconnect will require a new token.");
  }, [disconnectRemoteMcp]);

  const uninstallConnectorById = useCallback(async (id: string): Promise<void> => {
    const entry = findConnector(connectorsRef.current, id);
    if (mcpRunningIds.includes(id)) {
      try {
        await invoke<boolean>("mcp_local_stop", { connectorId: id });
        setMcpRunningIds((current) => current.filter((item) => item !== id));
      } catch (e) {
        setError(`cannot remove running MCP connector: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    if (remoteConnectedIds.includes(id)) disconnectRemoteMcp(id);
    setConnectors((cur) => uninstallConnector(cur, id).registry);
    if (entry?.source === "package" && entry.package && isTauriRuntime()) {
      await invoke("mcp_package_remove", {
        packageId: id,
        version: entry.package.version,
      }).catch(() => undefined);
    }
    if (entry?.kind === "remote" && isTauriRuntime()) {
      await invoke("secure_store_remove", { key: remoteMcpCredentialKey(id) }).catch(() => undefined);
    }
  }, [disconnectRemoteMcp, mcpRunningIds, remoteConnectedIds]);

  const setConnectorEnabledById = useCallback((id: string, enabled: boolean): void => {
    setConnectors((cur) => setConnectorEnabled(cur, id, enabled).registry);
    if (!enabled && mcpRunningIds.includes(id)) {
      // Disabling a connector must release its native child as well. The
      // registry remains the SSOT for availability; a failed stop is exposed
      // as an error so the user can retry explicitly.
      void invoke<boolean>("mcp_local_stop", { connectorId: id })
        .then((stopped) => {
          if (stopped) setMcpRunningIds((current) => current.filter((item) => item !== id));
        })
        .catch((e) => {
          setError(`local MCP disable failed to stop server: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
    if (!enabled && remoteConnectedIds.includes(id)) disconnectRemoteMcp(id);
  }, [disconnectRemoteMcp, mcpRunningIds, remoteConnectedIds]);

  const setConnectorUseInMuseById = useCallback((id: string, enabled: boolean): void => {
    setConnectors((current) => setConnectorUseInMuse(current, id, enabled));
  }, []);

  const probeRemoteMcp = useCallback(
    async (
      name: string,
      url: string,
      token = "",
    ): Promise<RemoteMcpProbeResult | null> => {
      const trimmedName = name.trim();
      const endpoint = url.trim();
      const id = `remote-${trimmedName.toLowerCase().replace(/[\s_]+/g, "-")}`;
      if (!trimmedName || !endpoint) {
        setRemoteNotice("Remote connector name and URL are required.");
        return null;
      }
      const existing = findConnector(connectorsRef.current, id);
      if (existing?.kind !== "remote") {
        const guard = requestRemoteConnector(connectorsRef.current, { id, name: trimmedName, url: endpoint });
        if (!guard.ok) {
          setRemoteNotice(guard.message);
          return null;
        }
      }
      setRemoteNotice(null);
      try {
        let effectiveToken = token;
        // Reconnects may be initiated from a persisted connector row, where
        // the token input is intentionally empty. Retrieve it only through
        // the native credential boundary; it never enters localStorage.
        if (!effectiveToken.trim() && existing?.kind === "remote" && isTauriRuntime()) {
          try {
            effectiveToken = (await invoke<string | null>("secure_store_get", {
              key: remoteMcpCredentialKey(id),
            })) ?? "";
          } catch {
            // A missing/unavailable store leaves the explicit reconnect path
            // usable; the result below remains a normal auth failure.
            effectiveToken = "";
          }
        }
        const result = await probeRemoteMcpTransport(endpoint, effectiveToken);
        const registered = registerRemoteConnector(connectorsRef.current, {
          id,
          name: trimmedName,
          url: endpoint,
          tools: result.tools,
          protocolVersion: result.protocolVersion,
          serverVersion: result.serverVersion,
        });
        if (registered === null) {
          setRemoteNotice("Remote MCP returned an invalid tool catalogue.");
          return null;
        }
        remoteSessionsRef.current[id] = {
          url: endpoint,
          token: effectiveToken,
          sessionId: result.sessionId,
          protocolVersion: result.protocolVersion,
          nextRequestId: 3,
        };
        setConnectors(registered.registry);
        setRemoteConnectedIds((current) => [...new Set([...current, id])]);
        if (effectiveToken.trim() && isTauriRuntime()) {
          try {
            await invoke("secure_store_set", {
              key: remoteMcpCredentialKey(id),
              secret: effectiveToken,
            });
          } catch {
            setRemoteNotice("Connected, but the native secure store is unavailable; reconnect after restart will require the token again.");
          }
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRemoteNotice(message);
        setConnectors((current) => current.map((entry) =>
          entry.id === id && entry.kind === "remote"
            ? { ...entry, status: "error", guardMessage: message }
            : entry,
        ));
        return null;
      }
    },
    [],
  );

  const callRemoteMcp = useCallback(
    async (
      id: string,
      toolName: string,
      argumentsText: string,
    ): Promise<RemoteMcpCallResult | null> => {
      const session = remoteSessionsRef.current[id];
      if (!session) {
        setRemoteNotice("Remote connector is disconnected. Connect it before calling a tool.");
        return null;
      }
      let args: unknown = {};
      if (argumentsText.trim()) {
        try {
          args = JSON.parse(argumentsText);
        } catch {
          setRemoteNotice("Remote tool arguments must be valid JSON.");
          return null;
        }
      }
      try {
        const result = await callRemoteMcpTransport(session, toolName, args);
        setRemoteNotice(null);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRemoteMcpAuthenticationError(message) && session.token.trim()) {
          // A 401/403 can mean that only the MCP session expired. Re-run the
          // initialize/tools-list handshake once with the in-memory bearer
          // token, then retry the call exactly once. Network timeouts and
          // ambiguous tool outcomes remain non-retryable.
          const entry = findConnector(connectorsRef.current, id);
          const name = entry?.kind === "remote" ? entry.name : id.replace(/^remote-/, "");
          try {
            const refreshed = await probeRemoteMcpTransport(session.url, session.token);
            const registered = registerRemoteConnector(connectorsRef.current, {
              id,
              name,
              url: session.url,
              tools: refreshed.tools,
              protocolVersion: refreshed.protocolVersion,
              serverVersion: refreshed.serverVersion,
            });
            if (registered !== null) {
              const nextSession: RemoteMcpSession = {
                url: session.url,
                token: session.token,
                sessionId: refreshed.sessionId,
                protocolVersion: refreshed.protocolVersion,
                nextRequestId: 3,
              };
              remoteSessionsRef.current[id] = nextSession;
              setConnectors(registered.registry);
              setRemoteConnectedIds((current) => [...new Set([...current, id])]);
              const retried = await callRemoteMcpTransport(nextSession, toolName, args);
              setRemoteNotice(null);
              return retried;
            }
          } catch {
            // Fall through to the normal disconnected state below. The
            // original failure remains actionable without hiding it behind a
            // second retry loop.
          }
        }
        setRemoteNotice(message);
        disconnectRemoteMcp(id);
        return null;
      }
    },
    [connectorsRef, disconnectRemoteMcp],
  );

  const setSkillEnabledByName = useCallback((name: string, enabled: boolean): void => {
    setSkills((cur) => setSkillEnabled(cur, name, enabled).skills);
  }, []);

  const traceSkillSuggestions = useCallback(
    (sessionId: string, text: string): SkillSuggestion[] => {
      const out = suggestSkills(skillsRef.current, text);
      if (out.length > 0) {
        const entries: LogEntry[] = out.map((s) => ({
          id: newId(),
          ts: Date.now(),
          role: "system",
          text: formatSkillTrace(s),
        }));
        pushLog(sessionId, entries);
      }
      return out;
    },
    [],
  );

  // M0-03: at most one in-flight send per session. This guard is the
  // express serialization of the send cycle: taken before any await and
  // released when the underlying invoke settles, keyed by session (never by
  // the selected conversation), so a retry cannot race a still-pending turn
  // while other sessions keep sending freely.
  const inFlightSends = useRef<Set<string>>(new Set());

  /** Capture an explicit repository baseline before a new logical turn. */
  const captureGitTurnSnapshot = useCallback(
    async (sessionId: string, clientMessageId: string): Promise<void> => {
      if (!isTauriRuntime()) return;
      try {
        const status = await withTimeout(
          invoke<GitStatusSnapshot>("git_status", { sessionId }),
          GIT_STATUS_CAPTURE_TIMEOUT_MS,
        );
        const snapshot: GitTurnSnapshot = {
          clientMessageId,
          turnId: null,
          capturedAt: Date.now(),
          phase: "captured",
          status,
        };
        saveGitTurnSnapshot(sessionId, snapshot);
        setGitTurnSnapshotsBySession((current) => ({ ...current, [sessionId]: snapshot }));
      } catch {
        // A non-Git workspace must not block a conversation send. Review will
        // simply omit the explicit last-turn card until a status is available.
      }
    },
    [],
  );

  const updateGitTurnSnapshot = useCallback(
    (
      sessionId: string,
      update: Partial<Pick<GitTurnSnapshot, "turnId" | "phase">>,
    ): void => {
      setGitTurnSnapshotsBySession((current) => {
        const previous = current[sessionId];
        if (!previous) return current;
        const next = { ...previous, ...update };
        saveGitTurnSnapshot(sessionId, next);
        gitTurnSnapshotsRef.current = { ...current, [sessionId]: next };
        return { ...current, [sessionId]: next };
      });
    },
    [],
  );

  /** Outbox state + disk for one session (functional update, no stale read). */
  function updateOutbox(
    sessionId: string,
    update: (cur: OutboxEntry[]) => OutboxEntry[],
  ): void {
    setOutbox((cur) => {
      const list = cur[sessionId] ?? [];
      const next = update(list);
      if (next === list) return cur;
      saveOutbox(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  /** Find a pending entry across every session (the key is global). */
  function findPendingEverywhere(clientMessageId: string): OutboxEntry | null {
    for (const list of Object.values(outboxRef.current)) {
      const hit = findOutbox(list, clientMessageId);
      if (hit !== null) return hit;
    }
    return null;
  }

  const sendInput = useCallback(
    async (
      sessionId: string,
      text: string,
      retryKey?: string,
      inputParts?: TurnInputPart[],
    ): Promise<SendResult> => {
      const trimmed = text.trim();
      const hasInputParts = inputParts?.some(
        (part) =>
          part.type === "image" ||
          part.type === "skill" ||
          (part.type === "text" && part.text.trim().length > 0),
      ) ?? false;
      if (!trimmed && !hasInputParts) return sendFailed(null, "the message is empty");
      // US-4: `/compact` is intercepted at send time and never reaches the
      // model — it builds the local extractive summary of this thread.
      // Local action, no server round trip: no outbox entry, nothing to ack.
      if (isCompactCommand(trimmed)) {
        doCompact(sessionId);
        return sendAccepted("local-compact");
      }
      if (inFlightSends.current.has(sessionId)) {
        return sendFailed(
          retryKey ?? null,
          "a send is already in progress for this conversation",
        );
      }
      // A new logical turn supersedes the previous terminal result. Keep the
      // host completion scoped to the turn that produced it.
      clearTurnCompletion(sessionId);
      const clientMessageId = retryKey ?? newId();
      const prior =
        retryKey !== undefined
          ? findOutbox(outboxRef.current[sessionId] ?? [], retryKey)
          : null;
      if (retryKey !== undefined && prior === null) {
        return sendFailed(retryKey, "the message to retry no longer exists");
      }
      // First send runs the expansion pipeline; a retry reuses the stored
      // byte-identical expansion, so skill/project expansion never doubles.
      let outgoing = prior !== null ? prior.outgoingText : trimmed;
      let fanout: ReturnType<typeof parseFanoutCommand> = null;
      let nativeSkill: { selector: string; arguments?: string } | null = null;
      let skillInvocation: { name: string; source: "host" | "local" } | null = null;
      if (prior === null) {
        // w-integrations US-25: `/skill-name args` expands to the skill
        // instructions (traced in the log) and sends as the turn.
        const skillCmd = parseSkillCommand(trimmed);
        if (skillCmd !== null) {
          const hostSkill = findHostSkill(hostSkillsRef.current[sessionId] ?? [], skillCmd.name);
          if (hostSkill !== null) {
            skillInvocation = { name: hostSkill.selector, source: "host" };
            startSkillInvocation(sessionId, hostSkill.selector, "host");
            // Native skills are expanded by the host. Keep the slash command
            // in the durable transcript while sending the typed selector as
            // a protocol `skill` part, which avoids leaking host instructions
            // into the renderer or duplicating them on retry.
            nativeSkill = {
              selector: hostSkill.selector,
              ...(skillCmd.args ? { arguments: skillCmd.args } : {}),
            };
            pushLog(sessionId, [
              {
                id: newId(),
                ts: Date.now(),
                role: "system",
                text: formatSkillInvokeTrace(hostSkill.selector, skillCmd.args),
              },
            ]);
            outgoing = trimmed;
          } else {
          const skill = resolveSkill(skillsRef.current, skillCmd.name);
          if (skill === null) {
            pushLog(sessionId, [
              {
                id: newId(),
                ts: Date.now(),
                role: "system",
                text: `unknown skill /${skillCmd.name}: install or enable it first.`,
              },
            ]);
            setError(`unknown skill /${skillCmd.name}`);
            return sendFailed(clientMessageId, `unknown skill /${skillCmd.name}`);
          }
          skillInvocation = { name: skill.name, source: "local" };
          startSkillInvocation(sessionId, skill.name, "local");
          let resources: SkillResourceContext[] = [];
          const declaredResourceCount = skill.resources?.length ?? 0;
          if (skill.discovered && skill.path && declaredResourceCount > 0) {
            updateSkillInvocation(sessionId, {
              stage: "loading-resources",
              updatedAt: Date.now(),
              detail: `Loading ${declaredResourceCount} resource${declaredResourceCount === 1 ? "" : "s"}`,
            });
            try {
              const loaded = await invoke<{
                resources: SkillResourceContext[];
                errors: Array<{ path: string; message: string }>;
              }>("skills_read_resources", {
                workspace: workspace?.trim() || null,
                skillPath: skill.path,
                resourcePaths: skill.resources ?? [],
              });
              if (loaded.errors.length > 0) {
                const detail = loaded.errors.map((item) => `${item.path}: ${item.message}`).join("; ");
                pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "system", text: `skill /${skill.name} resources unavailable: ${detail}` }]);
                setError(`skill /${skill.name} resources unavailable`);
                updateSkillInvocation(sessionId, {
                  stage: "failed",
                  updatedAt: Date.now(),
                  detail: "One or more resources could not be loaded",
                });
                return sendFailed(clientMessageId, `skill /${skill.name} resources unavailable`);
              }
              resources = loaded.resources;
              updateSkillInvocation(sessionId, {
                stage: "preparing",
                updatedAt: Date.now(),
                detail: `${resources.length} resource${resources.length === 1 ? "" : "s"} loaded`,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "system", text: `skill /${skill.name} could not load resources: ${message}` }]);
              setError(`skill /${skill.name} could not load resources`);
              updateSkillInvocation(sessionId, {
                stage: "failed",
                updatedAt: Date.now(),
                detail: "The resource loader was unavailable",
              });
              return sendFailed(clientMessageId, `skill /${skill.name} could not load resources`);
            }
          }
          pushLog(sessionId, [
            {
              id: newId(),
              ts: Date.now(),
              role: "system",
              text: formatSkillInvokeTrace(skill.name, skillCmd.args),
            },
          ]);
          outgoing = buildSkillInvocation(skill, skillCmd.args, resources);
          }
        }
        // US-7: `/fanout <n> "<task>"` never reaches the model as typed —
        // it becomes one parent-turn prompt instructing N parallel
        // subagents. A FIFO note is logged when n exceeds the lanes.
        fanout = parseFanoutCommand(outgoing);
        if (fanout !== null) {
          outgoing = buildFanoutPrompt(fanout);
          const note = fanoutQueueNote(fanout.count);
          if (note !== null) {
            pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "system", text: note }]);
          }
        }
        // A project contributes its settings and its folder, never text: the
        // rules that govern a session are the folder's, and the host injects
        // them itself (see src/lib/harnessRules.ts).
      }
      const originalText = prior !== null ? prior.text : trimmed;
      // Attachments are part of the durable send payload. On a retry, always
      // reuse the exact serialized parts from the outbox; on a first send,
      // replace the leading text part after skill expansion.
      const outgoingParts = prior?.inputParts ?? (
        nativeSkill === null
          ? inputPartsWithText(outgoing, inputParts)
          : [
              {
                type: "skill" as const,
                selector: nativeSkill.selector,
                ...(nativeSkill.arguments ? { arguments: nativeSkill.arguments } : {}),
              },
              ...(inputParts ?? []).filter((part, index) =>
                part.type === "image" || (part.type === "text" && index > 0),
              ),
            ]
      );
      // A retry keeps the exact command id from the durable entry. Legacy
      // ambiguous entries have no server id and cannot be checked safely.
      const serverCommandId =
        prior?.serverCommandId ??
        commandIdFromClientMessageId(clientMessageId, Date.now());
      if (serverCommandId === undefined) {
        return sendFailed(
          clientMessageId,
          prior?.ambiguous
            ? "this send predates durable server identity and cannot be verified safely"
            : "could not create a durable server command id",
        );
      }
      if (skillInvocation !== null) {
        updateSkillInvocation(sessionId, {
          stage: "sending",
          updatedAt: Date.now(),
          detail: skillInvocation.source === "host"
            ? "Sending the native skill part"
            : "Sending expanded instructions",
        });
      }
      // A retry keeps the original baseline; a fresh logical turn captures
      // the repository state before admission so Review can report concrete
      // files changed during that turn without reading assistant text.
      if (prior === null) {
        await captureGitTurnSnapshot(sessionId, clientMessageId);
      }
      inFlightSends.current.add(sessionId);
      let requestPending = false;
      let underlyingSettled = false;
      try {
        // One user entry per logical send: a retry finds its entry by
        // clientMessageId and never appends a duplicate bubble.
        const log = logsRef.current[sessionId] ?? loadLog(sessionId);
        if (!log.some((e) => e.clientMessageId === clientMessageId)) {
          closeOpenBlocks(sessionId);
          pushLog(sessionId, [
            {
              id: newId(),
              ts: Date.now(),
              role: "user",
              text: outgoing,
              clientMessageId,
            },
          ]);
        }
        // Outbox: a retry re-enters sending (attempts grow); a first send
        // creates the entry, so a crash/reload mid-flight stays recoverable.
        const entry =
          prior !== null
            ? { ...markSending(prior, Date.now()), serverCommandId }
            : createOutboxEntry({
                clientMessageId,
                serverCommandId,
                sessionId,
                text: originalText,
                outgoingText: outgoing,
                inputParts: outgoingParts,
                now: Date.now(),
              });
        updateOutbox(sessionId, (cur) => upsertOutbox(cur, entry));
        // US-10: reflexive indicator synchronously (<200ms), before the first
        // delta or even `item/started` can arrive. The first chunk coalesces
        // into this entry, so no catch-up burst ever paints.
        touchStreamActivity(sessionId, "client/send");
        ensurePlaceholder(sessionId);
        setSessions((cur) =>
          cur.map((s) =>
            s.session_id === sessionId
              ? {
                  ...s,
                  title: s.title.startsWith("Session ") ? shortTitle(originalText) : s.title,
                  running: true,
                }
              : s,
          ),
        );
        let acked = false;
        let failure = "";
        let ambiguous = false;
        let admissionDisposition: string | undefined;
        let admissionTurnId: string | undefined;
        try {
          setError(null);
          // Tauri cannot cancel an in-flight invoke. Keep the logical lane
          // occupied until the underlying request settles, even if the UI
          // timeout fires first; this prevents a second turn admission race.
          const request = invoke("send_input", {
            sessionId,
            commandId: serverCommandId,
            text: outgoing,
            inputParts: outgoingParts,
          });
          requestPending = true;
          const release = (): void => {
            underlyingSettled = true;
            inFlightSends.current.delete(sessionId);
          };
          void request.then(release, release);
          const ack = await withAckTimeout(request);
          if (typeof ack === "object" && ack !== null) {
            const admission = ack as { disposition?: unknown; turnId?: unknown };
            admissionDisposition = typeof admission.disposition === "string" ? admission.disposition : undefined;
            admissionTurnId = typeof admission.turnId === "string" && admission.turnId.length > 0
              ? admission.turnId
              : undefined;
            if (admission.disposition === "queued") {
              updateGitTurnSnapshot(sessionId, {
                phase: "queued",
                ...(admissionTurnId ? { turnId: admissionTurnId } : {}),
              });
              if (typeof admission.turnId === "string" && admission.turnId.length > 0) {
                const queued: QueuedTurn = {
                  session_id: sessionId,
                  turn_id: admission.turnId,
                  text: originalText,
                  createdAt: Date.now(),
                  recovered: false,
                };
                setQueuedTurnsBySession((cur) => ({
                  ...cur,
                  [sessionId]: [...(cur[sessionId] ?? []).filter((turn) => turn.turn_id !== queued.turn_id), queued],
                }));
              }
              pushLog(sessionId, [
                {
                  id: newId(),
                  ts: Date.now(),
                  role: "system",
                  text: "Turn queued — it will start after the current turn finishes.",
                },
              ]);
            } else if (admission.disposition === "steered") {
              pushLog(sessionId, [
                {
                  id: newId(),
                  ts: Date.now(),
                  role: "system",
                  text: "Guidance added to the current turn.",
                },
              ]);
            }
          }
          if (admissionDisposition !== "queued" && admissionDisposition !== "steered") {
            updateGitTurnSnapshot(sessionId, {
              phase: "running",
              ...(admissionTurnId ? { turnId: admissionTurnId } : {}),
            });
          }
          acked = true;
          if (skillInvocation !== null) {
            updateSkillInvocation(sessionId, {
              stage: admissionDisposition === "queued" ? "queued" : "running",
              updatedAt: Date.now(),
              ...(admissionTurnId ? { turnId: admissionTurnId } : {}),
              detail: admissionDisposition === "queued"
                ? "Waiting for the current turn to finish"
                : "Muse accepted the invocation",
            });
          }
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
          ambiguous = failure === ACK_TIMEOUT_MSG;
          if (!ambiguous) failure = `send_input failed: ${failure}`;
        }
        if (acked) {
          // Admission acknowledged: the entry leaves the outbox (the draft
          // may be cleared) and the turn streams from here.
          updateOutbox(sessionId, (cur) => removeOutbox(cur, clientMessageId));
          // Drain immediately: the next slow tick could be ~1s away, which
          // would delay the first tokens and dump them as one catch-up burst.
          kickPoll();
          return sendAccepted(clientMessageId);
        }
        updateOutbox(sessionId, (cur) =>
          upsertOutbox(cur, markFailed(entry, failure, Date.now(), ambiguous)),
        );
        if (skillInvocation !== null) {
          updateSkillInvocation(sessionId, {
            stage: ambiguous ? "unknown" : "failed",
            updatedAt: Date.now(),
            detail: ambiguous
              ? "The host did not confirm admission; verify before retrying"
              : failure,
          });
        }
        setError(failure);
        updateGitTurnSnapshot(sessionId, { phase: "failed" });
        if (!ambiguous) {
          // Definitive refusal: the turn never started, so withdraw the
          // reflexive placeholder; the entry stays retryable (same key).
          dropPlaceholder(sessionId);
          setSessions((cur) =>
            cur.map((s) => (s.session_id === sessionId ? { ...s, running: false } : s)),
          );
        }
        // Ambiguous: keep the live indicators — the turn may still be
        // running server-side; late events or Retry's server check settle it.
        return sendFailed(clientMessageId, failure);
      } finally {
        // A non-timed-out request has already settled and released the lane.
        // An ambiguous timeout deliberately leaves it occupied until the
        // underlying invoke's release continuation runs.
        if (!requestPending || underlyingSettled) {
          inFlightSends.current.delete(sessionId);
        }
      }
    },
    [
      captureGitTurnSnapshot,
      kickPoll,
      doCompact,
      touchStreamActivity,
      workspace,
      startSkillInvocation,
      updateSkillInvocation,
      updateGitTurnSnapshot,
    ],
  );

  const steerInput = useCallback(
    async (
      sessionId: string,
      text: string,
      inputParts?: TurnInputPart[],
    ): Promise<SendResult> => {
      const hasInputParts = inputParts?.some(
        (part) => part.type === "image" || (part.type === "text" && part.text.trim().length > 0),
      ) ?? false;
      if (text.trim().length === 0 && !hasInputParts) {
        return sendFailed(null, "the guidance is empty");
      }
      if (inFlightSends.current.has(sessionId)) {
        return sendFailed(null, "a send is already in progress for this conversation");
      }
      const expectedTurnId = turnIdsRef.current[sessionId];
      if (!expectedTurnId) {
        return sendFailed(null, "the current turn is not ready to receive guidance");
      }
      const clientMessageId = newId();
      const commandId = commandIdFromClientMessageId(clientMessageId, Date.now());
      if (commandId === undefined) {
        return sendFailed(clientMessageId, "could not create a durable command id");
      }
      const outgoingParts = inputPartsWithText(text, inputParts);
      try {
        setError(null);
        await withAckTimeout(
          invoke("steer_input", {
            sessionId,
            commandId,
            expectedTurnId,
            text,
            inputParts: outgoingParts,
          }),
        );
        const log = logsRef.current[sessionId] ?? loadLog(sessionId);
        if (!log.some((entry) => entry.clientMessageId === clientMessageId)) {
          pushLog(sessionId, [
            { id: newId(), ts: Date.now(), role: "user", text, clientMessageId },
          ]);
        }
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: "Guidance accepted by the current turn." },
        ]);
        touchStreamActivity(sessionId, "client/steer");
        kickPoll();
        return sendAccepted(clientMessageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(`turn/steer failed: ${message}`);
        return sendFailed(clientMessageId, `turn/steer failed: ${message}`);
      }
    },
    [kickPoll, touchStreamActivity],
  );

  const retrySend = useCallback(
    async (clientMessageId: string): Promise<void> => {
      const entry = findPendingEverywhere(clientMessageId);
      if (entry === null) {
        setError(
          `retry failed: pending message ${clientMessageId.slice(0, 8)} not found`,
        );
        return;
      }
      if (inFlightSends.current.has(entry.sessionId)) {
        setError(
          "the previous send is still pending; wait for it to settle before retrying",
        );
        return;
      }
      if (entry.ambiguous) {
        // Ambiguous outcome: verify the server conversation before any
        // retransmission — if the turn is already there, never resend (one
        // logical send can never become two accepted turns).
        if (entry.serverCommandId === undefined) {
          setError(
            "this ambiguous send cannot be verified because it has no server command id",
          );
          return;
        }
        try {
          const reached = await invoke<boolean>("check_input_reached", {
            sessionId: entry.sessionId,
            commandId: entry.serverCommandId,
          });
          if (reached) {
            updateOutbox(entry.sessionId, (cur) =>
              removeOutbox(cur, entry.clientMessageId),
            );
            pushLog(entry.sessionId, [
              {
                id: newId(),
                ts: Date.now(),
                role: "system",
                text: "Retry check: the turn was already delivered — not resent.",
              },
            ]);
            return;
          }
        } catch {
          // Probe unavailable (host down): the resend below fails visibly
          // with the real transport error instead of hiding behind the probe.
        }
      }
      // Retries send the expanded bytes stored in the outbox. Re-expanding
      // the original composer text could change skill/fanout/project output.
      await sendInput(
        entry.sessionId,
        entry.outgoingText,
        entry.clientMessageId,
        entry.inputParts,
      );
    },
    [sendInput],
  );

  const retryFailedTurn = useCallback(
    async (sessionId: string, failureEntryId: string): Promise<void> => {
      const log = logsRef.current[sessionId] ?? loadLog(sessionId);
      const prompt = findRetryPrompt(log, failureEntryId);
      if (prompt === null) {
        setError("retry failed: the original user message is no longer available");
        return;
      }
      if (inFlightSends.current.has(sessionId)) {
        setError("the previous send is still pending; wait for it to settle before retrying");
        return;
      }
      const result = await sendInput(sessionId, prompt);
      if (!result.ok) setError(result.error ?? "retry failed");
    },
    [sendInput],
  );

  const discardSend = useCallback((clientMessageId: string): void => {
    const entry = findPendingEverywhere(clientMessageId);
    if (entry === null) return;
    updateOutbox(entry.sessionId, (cur) => removeOutbox(cur, clientMessageId));
    setLogs((cur) => {
      const log = cur[entry.sessionId];
      if (!log) return cur;
      const kept = log.filter(
        (e) => !(e.role === "user" && e.clientMessageId === clientMessageId),
      );
      const next: LogEntry[] = [
        ...kept,
        {
          id: newId(),
          ts: Date.now(),
          role: "system",
          text: "Unsent message discarded.",
        },
      ];
      saveLog(entry.sessionId, next);
      return { ...cur, [entry.sessionId]: next };
    });
  }, []);

  /**
   * w-integrations US-25: invoke `/name args` from a button (the composer
   * slash path is intercepted inside sendInput). Traces to the log, then
   * sends the expanded instructions as the turn.
   */
  const invokeSkill = useCallback(
    (sessionId: string, name: string, args: string): void => {
      const hostSkill = findHostSkill(hostSkillsRef.current[sessionId] ?? [], name);
      const skill = resolveSkill(skillsRef.current, name);
      if (hostSkill === null && skill === null) {
        setError(`unknown skill /${name}`);
        return;
      }
      const selectedName = hostSkill?.selector ?? skill!.name;
      // Route through sendInput so native host skills become `skill` parts,
      // while local SKILL.md entries retain their existing expansion path.
      void sendInput(sessionId, `/${selectedName}${args.trim() ? ` ${args.trim()}` : ""}`);
    },
    [sendInput],
  );

  /**
   * US-4: open a fresh thread pre-filled with the source thread's summary.
   * The summary must exist (manual `/compact`, Compacter button, or auto at
   * the entry cap). The composer receives the formatted text as prefill —
   * nothing is sent to the model until the user presses Send.
   */
  const newFromSummary = useCallback(
    async (sourceId: string) => {
      const summary =
        summaries[sourceId] ?? loadSummary(sourceId);
      if (!summary) {
        setError(
          `no summary for thread ${sourceId.slice(0, 8)}: compact it first (/compact).`,
        );
        return;
      }
      const id = await startSessionRow();
      if (id === null) return;
      setSessions((cur) =>
        cur.map((s) =>
          s.session_id === id ? { ...s, title: `Suite ${sourceId.slice(0, 8)}` } : s,
        ),
      );
      setPrefill(formatSummaryText(summary));
    },
    [startSessionRow, summaries],
  );

  const clearPrefill = useCallback(() => setPrefill(null), []);
  const prefillComposer = useCallback((text: string) => {
    const bounded = text.trim().slice(0, 8_000);
    if (bounded.length > 0) setPrefill(bounded);
  }, []);

  /**
   * US-21: 1-click restore — the version text goes through the US-4
   * composer prefill, so nothing is sent until the user presses Send.
   */
  const restoreArtifact = useCallback(
    (sessionId: string, artifactId: string, v: number) => {
      const text = findVersionText(artifacts[sessionId] ?? [], artifactId, v);
      if (text === null) {
        setError(`restore failed: version v${v} not found in this thread.`);
        return;
      }
      setPrefill(text);
    },
    [artifacts],
  );

  /** US-21: anchored per-version comment (state + disk). */
  const commentArtifact = useCallback(
    (sessionId: string, artifactId: string, v: number, comment: string, anchorQuote?: string) => {
      setArtifacts((cur) => {
        const list = cur[sessionId] ?? [];
        const next = setVersionComment(list, artifactId, v, comment, anchorQuote);
        if (JSON.stringify(next) === JSON.stringify(list)) return cur;
        saveArtifacts(sessionId, next);
        return { ...cur, [sessionId]: next };
      });
    },
    [],
  );

  /** US-21: local artifact edits become a new persisted version. */
  const editArtifact = useCallback(
    (sessionId: string, artifactId: string, v: number, text: string) => {
      setArtifacts((cur) => {
        const list = cur[sessionId] ?? [];
        const next = editArtifactVersion(list, artifactId, v, text);
        if (next === list || JSON.stringify(next) === JSON.stringify(list)) return cur;
        saveArtifacts(sessionId, next);
        return { ...cur, [sessionId]: next };
      });
    },
    [],
  );

  // US-23 local index: opt-in (default off, persisted), paused flag, and
  // the stored line index. Picked File handles stay in memory only — the
  // on-demand Rescan re-reads them (mtime-based, no watcher).
  const [indexEnabled, setIndexEnabledState] = useState<boolean>(() =>
    loadIndexEnabled(),
  );
  const [indexPaused, setIndexPausedState] = useState(false);
  const [indexStore, setIndexStore] = useState<IndexStore>(() =>
    loadIndexData(),
  );
  const [indexQuery, setIndexQueryState] = useState("");
  const [indexSummary, setIndexSummary] = useState<string | null>(null);
  const indexFilesRef = useRef<File[]>([]);

  const setIndexEnabled = useCallback((on: boolean) => {
    setIndexEnabledState(on);
    saveIndexEnabled(on);
    if (!on) setIndexQueryState("");
  }, []);

  const setIndexPaused = useCallback((paused: boolean) => {
    setIndexPausedState(paused);
  }, []);

  const indexPickedFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const list = Array.from(files);
      if (list.length === 0) return;
      try {
        setError(null);
        const { snapshots, patterns } = await readIndexSnapshots(list);
        indexFilesRef.current = list;
        const store = buildIndex(snapshots, patterns);
        setIndexStore(store);
        saveIndexData(store);
        const s = indexStats(store);
        setIndexSummary(
          `Built ${s.files} file(s), ${s.lines} line(s) from ${list.length} picked.`,
        );
      } catch (e) {
        setError(`index build failed: ${String(e)}`);
      }
    },
    [],
  );

  const rescanIndexFiles = useCallback(async (): Promise<void> => {
    if (indexPaused) {
      setIndexSummary("Paused — resume to rescan.");
      return;
    }
    const list = indexFilesRef.current;
    if (list.length === 0) return;
    try {
      setError(null);
      const { snapshots, patterns } = await readIndexSnapshots(list);
      const { store, summary } = rescanIndex(indexStore, snapshots, patterns);
      setIndexStore(store);
      saveIndexData(store);
      setIndexSummary(
        `Rescan: ${summary.added} added, ${summary.updated} updated, ` +
          `${summary.removed} removed, ${summary.unchanged} unchanged.`,
      );
    } catch (e) {
      setError(`index rescan failed: ${String(e)}`);
    }
  }, [indexPaused, indexStore]);

  const rebuildIndex = useCallback(async (): Promise<void> => {
    const list = indexFilesRef.current;
    if (list.length === 0) return;
    try {
      setError(null);
      const { snapshots, patterns } = await readIndexSnapshots(list);
      const store = buildIndex(snapshots, patterns);
      setIndexStore(store);
      saveIndexData(store);
      const s = indexStats(store);
      setIndexSummary(`Rebuilt ${s.files} file(s), ${s.lines} line(s).`);
    } catch (e) {
      setError(`index rebuild failed: ${String(e)}`);
    }
  }, []);

  const deleteIndex = useCallback(() => {
    setIndexStore({ files: {}, builtAt: null });
    dropIndexData();
    indexFilesRef.current = [];
    setIndexQueryState("");
    setIndexSummary(null);
  }, []);

  const setIndexQuery = useCallback((q: string) => setIndexQueryState(q), []);

  const approve = useCallback(
    async (sessionId: string, approvalId: string, choiceId: string) => {
      try {
        setError(null);
        // The selected choice is the only local hint about whether the host
        // should resume the turn. A reject/deny choice must not paint a
        // misleading "resuming" bridge; the authoritative resolution event
        // still settles the approval and any terminal turn state.
        const acceptedChoice = isSelectedApprovalAccepted(
          approvals,
          sessionId,
          approvalId,
          choiceId,
        );
        const terminal = await invoke<boolean>("approve", {
          sessionId,
          approvalId,
          choiceId,
        });
        // A compound command returns terminal=false after one stage. Keep
        // the card mounted until the host emits the next stage update (the
        // backend also refreshes its requirement token at that point).
        if (terminal !== false) {
          setApprovals((cur) =>
            cur.filter(
              (a) => !(a.session_id === sessionId && a.request_id === approvalId),
            ),
          );
        }
        // The turn resumes after an accepted decision: drain now, don't wait
        // a tick. A rejection follows the host's terminal path instead.
        touchStreamActivity(sessionId, "client/approval");
        if (acceptedChoice) {
          // US-10: reflexive placeholder synchronously, same as after send.
          ensurePlaceholder(sessionId);
          markResumePending(sessionId, "approval");
        }
        kickPoll();
        return true;
      } catch (e) {
        setError(`approve failed: ${String(e)}`);
        return false;
      }
    },
    [approvals, kickPoll, touchStreamActivity],
  );

  // Balanced mode removes repetitive prompts for local workspace actions;
  // YOLO removes prompts for every non-denied choice. Network/elevated scopes
  // continue through the visible panel in balanced mode. Decisions still go
  // through the same approve IPC path, preserving host stale-token guards.
  const autoApprovalInFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const key of autoApprovalInFlight.current) {
      const [sessionId, requestId] = key.split("|");
      if (!approvals.some((a) => a.session_id === sessionId && a.request_id === requestId)) {
        autoApprovalInFlight.current.delete(key);
      }
    }
    if (authorizationMode === "ask") return;
    for (const approval of approvals) {
      const resolved = resolveApproval(allowlist, {
        toolName: approval.toolName,
        summary: approval.summary,
        scopes: approval.choices.map((choice) => choice.scope),
      });
      // An explicit persisted prompt/forbidden rule is more restrictive than
      // the global posture and must remain user-controlled.
      if (
        resolved.rule?.decision === "prompt" ||
        resolved.rule?.decision === "forbidden"
      ) {
        continue;
      }
      const choice = automaticApprovalChoice(authorizationMode, approval.choices);
      if (choice === null) continue;
      const effectiveHostMode = hostApprovalModeBySession[approval.session_id];
      if (!hostModeMatches(authorizationMode, effectiveHostMode)) {
        continue;
      }
      // Include the current choice set so an approval/updated stage can be
      // auto-decided even though the host intentionally reuses approvalId.
      const key = `${approval.session_id}|${approval.request_id}|${approval.choices
        .map((choice) => choice.choiceId)
        .join(",")}`;
      if (autoApprovalInFlight.current.has(key)) continue;
      autoApprovalInFlight.current.add(key);
      void approve(approval.session_id, approval.request_id, choice.choiceId);
    }
  }, [approvals, authorizationMode, approve, allowlist, hostApprovalModeBySession]);

  // US-15: effective allowlist decision for one pending approval request
  // (badge in the panel; most-restrictive-wins, network default-deny).
  const allowDecisionFor = useCallback(
    (approval: ApprovalRequest): ResolvedApproval =>
      resolveApproval(allowlist, {
        toolName: approval.toolName,
        summary: approval.summary,
        scopes: approval.choices.map((c) => c.scope),
      }),
    [allowlist],
  );

  // US-15 "toujours autoriser": send the decision, then memorize an allow
  // rule (command pattern + the chosen scope) for future requests.
  const rememberApproval = useCallback(
    async (approval: ApprovalRequest, choiceId: string) => {
      const approved = await approve(approval.session_id, approval.request_id, choiceId);
      if (!approved) return;
      const choice = approval.choices.find((c) => c.choiceId === choiceId);
      setAllowlist((cur) =>
        addAllowRule(cur, {
          pattern: defaultPatternFor(approval.toolName, approval.summary),
          scope: choice?.scope ?? "",
          decision: "allow",
        }),
      );
    },
    [approve],
  );

  const revokeAllowRule = useCallback((id: string) => {
    setAllowlist((cur) => removeAllowRule(cur, id));
  }, []);

  // US-19 browser: anchor a comment (invalid URL / empty comment = no-op),
  // remove one by id, toggle one app's computer-use permission.
  const addBrowserAnnotationCb = useCallback(
    (url: string, selection: string, comment: string, element?: BrowserElementAnchor | null) => {
      setBrowserAnnotations((cur) =>
        addBrowserAnnotation(cur, createBrowserAnnotation(url, selection, comment, element)),
      );
    },
    [],
  );

  const removeBrowserAnnotationCb = useCallback((id: string) => {
    setBrowserAnnotations((cur) => removeBrowserAnnotation(cur, id));
  }, []);

  const setBrowserAppPermissionCb = useCallback((app: string, allowed: boolean) => {
    setBrowserPermissions((cur) => setBrowserAppPermission(cur, app, allowed));
  }, []);

  // Computer use, owned by Rust: the renderer asks for a level by name and never
  // supplies a binary, an endpoint or an argument. What crosses back is the MCP
  // entry Rust built, kept in a ref so the send path can read it synchronously.
  const [computerUse, setComputerUse] = useState<ComputerStatus | null>(null);
  const computerServerRef = useRef<HostMcpStdioServer | null>(null);
  const [computerBusy, setComputerBusy] = useState(false);

  const refreshComputerUse = useCallback(async () => {
    if (!isTauriRuntime()) return null;
    try {
      const raw = await invoke<unknown>("computer_status");
      const status = parseComputerStatus(raw);
      setComputerUse(status);
      if (status?.grantState === "active") {
        const entry = await invoke<HostMcpStdioServer | null>("computer_mcp_server", {
          grantState: status.grantState,
        });
        computerServerRef.current = entry ?? null;
      } else {
        computerServerRef.current = null;
      }
      return status;
    } catch {
      // A driver that cannot be probed is not a driver we may hand to the host.
      computerServerRef.current = null;
      return null;
    }
  }, []);

  const setComputerLevel = useCallback(
    async (level: ComputerLevel) => {
      if (!isTauriRuntime()) return;
      setComputerBusy(true);
      try {
        const raw = await invoke<unknown>("computer_enable", { level });
        setComputerUse(parseComputerStatus(raw));
        await refreshComputerUse();
      } catch (error) {
        setError(userFacingError(error, "Computer use could not be enabled."));
      } finally {
        setComputerBusy(false);
      }
    },
    [refreshComputerUse],
  );

  const disableComputerUse = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setComputerBusy(true);
    try {
      const raw = await invoke<unknown>("computer_disable");
      setComputerUse(parseComputerStatus(raw));
      computerServerRef.current = null;
    } catch (error) {
      setError(userFacingError(error, "Computer use could not be turned off."));
    } finally {
      setComputerBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void refreshComputerUse();
  }, [refreshComputerUse]);

  const setAllowRuleDecisionCb = useCallback((id: string, decision: AllowDecision) => {
    setAllowlist((cur) => setAllowRuleDecision(cur, id, decision));
  }, []);

  const cancelSession = useCallback(async (sessionId: string) => {
    if (stoppingBySessionRef.current[sessionId]) return;
    stoppingBySessionRef.current[sessionId] = true;
    setStoppingBySession((cur) => ({ ...cur, [sessionId]: true }));
    try {
      setError(null);
      // Scope the interrupt to the turn currently observed for this session.
      // Older hosts accept the same command without `turnId`; the bridge only
      // includes the field when a live turn identity is known.
      const turnId = turnIdsRef.current[sessionId];
      await invoke("cancel_session", {
        sessionId,
        ...(turnId === undefined ? {} : { turnId }),
      });
      // The host owns the terminal state. Poll immediately so a queued
      // stopped event is reflected without waiting for the slow tick, while
      // preserving the open transcript until that event is observed.
      kickPoll();
    } catch (e) {
      clearStopping(sessionId);
      setError(`cancel_session failed: ${String(e)}`);
    }
  }, [kickPoll]);

  const unqueueTurn = useCallback(async (sessionId: string, turnId: string): Promise<boolean> => {
    try {
      setError(null);
      await invoke("unqueue_turn", { sessionId, turnId });
      setQueuedTurnsBySession((cur) => {
        const queued = cur[sessionId] ?? [];
        const next = { ...cur, [sessionId]: queued.filter((turn) => turn.turn_id !== turnId) };
        if (next[sessionId].length === 0) delete next[sessionId];
        return next;
      });
      kickPoll();
      return true;
    } catch (e) {
      setError(`turn/unqueue failed: ${String(e)}`);
      return false;
    }
  }, [kickPoll]);

  const dismissQueuedTurn = useCallback((sessionId: string, turnId: string): void => {
    setQueuedTurnsBySession((cur) => {
      const queued = cur[sessionId] ?? [];
      const next = { ...cur, [sessionId]: queued.filter((turn) => turn.turn_id !== turnId) };
      if (next[sessionId].length === 0) delete next[sessionId];
      return next;
    });
  }, []);

  const killSession = useCallback(
    async (sessionId: string) => {
      try {
        setError(null);
      await invoke("kill_session", { sessionId });
      clearStopping(sessionId);
      } catch (e) {
        setError(`kill_session failed: ${String(e)}`);
        return;
      }
      if (tombstoned.current === null) tombstoned.current = new Set();
      tombstoned.current.add(sessionId);
      saveTombstones([...tombstoned.current]);
      setConnectionBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setStreamActivityBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setRecoveryNoticeBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setRetryScheduledBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setConnectedIds((cur) => cur.filter((id) => id !== sessionId));
      setSessions((cur) => cur.filter((s) => s.session_id !== sessionId));
      setLogs((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      dropLog(sessionId);
      // M0-03: a deleted thread takes its retryable sends with it.
      dropOutbox(sessionId);
      dropGitTurnSnapshot(sessionId);
      setGitTurnSnapshotsBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setOutbox((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setApprovals((cur) => cur.filter((a) => a.session_id !== sessionId));
      setInputRequests((cur) => cur.filter((r) => r.session_id !== sessionId));
      setSkillInvocationsBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setQueuedTurnsBySession((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      // US-4: a killed thread takes its summary with it.
      // US-12 + US-21: and its artifacts.
      dropSummary(sessionId);
      dropArtifacts(sessionId);
      setArtifacts((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setSummaries((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      // US-3: a killed thread leaves its project attachment behind.
      setThreadProjects((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setActiveId((cur) => {
        if (cur !== sessionId) return cur;
        const remaining = loadSessions().filter(
          (s) => s.session_id !== sessionId && s.archived !== true,
        );
        return remaining[0]?.session_id ?? null;
      });
    },
    [],
  );

  // US-5: archive/restore flip the persisted `archived` flag (the
  // sessions write-through effect persists it); archiving the active
  // thread moves selection to the first remaining active thread.
  const renameSession = useCallback((sessionId: string, title: string) => {
    const next = title.trim().slice(0, 120);
    if (!next) return;
    setSessions(cur => cur.map(s => s.session_id === sessionId ? { ...s, title: next } : s));
    if (isTauriRuntime() && connectedIds.includes(sessionId)) {
      void invoke("rename_session", { sessionId, name: next }).catch((e) => {
        setError(`rename conversation failed: ${String(e)}`);
      });
    }
  }, [connectedIds]);

  const archiveSession = useCallback(
    (sessionId: string) => {
      setSessions((cur) => withArchivedFlag(cur, sessionId, true));
      if (activeId === sessionId) {
        const fallback =
          sessions.find((s) => s.session_id !== sessionId && s.archived !== true)
            ?.session_id ?? null;
        setActiveId(fallback);
      }
    },
    [sessions, activeId],
  );

  const restoreSession = useCallback((sessionId: string) => {
    setSessions((cur) => withArchivedFlag(cur, sessionId, false));
  }, []);

  const probeLocalMcp = useCallback(
    async (
      command: string,
      workspacePath?: string | null,
    ): Promise<LocalMcpProbeResult | null> => {
      try {
        setRemoteNotice(null);
        return await invoke<LocalMcpProbeResult>("mcp_local_probe", {
          command: command.trim(),
          workspace: workspacePath?.trim() || null,
        });
      } catch (e) {
        setError(`local MCP probe failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const callLocalMcp = useCallback(
    async (
      command: string,
      toolName: string,
      argumentsText: string,
      workspacePath?: string | null,
    ): Promise<LocalMcpCallResult | null> => {
      let argumentsValue: unknown = {};
      try {
        argumentsValue = argumentsText.trim() ? JSON.parse(argumentsText) : {};
      } catch {
        setError("local MCP call failed: arguments must be valid JSON");
        return null;
      }
      try {
        return await invoke<LocalMcpCallResult>("mcp_local_call", {
          command: command.trim(),
          workspace: workspacePath?.trim() || null,
          toolName: toolName.trim(),
          arguments: argumentsValue,
        });
      } catch (e) {
        setError(`local MCP call failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const scanSkills = useCallback(
    async (workspacePath?: string | null): Promise<SkillScanSummary | null> => {
      try {
        const result = await invoke<{
          root: string;
          documents: RawSkillDocument[];
          errors: Array<{ path: string; message: string }>;
          scannedAt: number;
        }>("skills_scan", {
          workspace: workspacePath?.trim() || null,
        });
        const parsed = parseSkillDocuments(result.documents);
        const discovered = dedupeDiscoveredSkills(parsed.skills);
        const errors = [
          ...result.errors,
          ...parsed.errors,
        ];
        // Rebuild from persisted overrides on every refresh so removed or
        // renamed documents cannot linger in the active registry.
        setSkills(mergeBuiltinSkills([...loadSkills(), ...discovered]));
        return {
          root: result.root,
          scannedAt: result.scannedAt,
          skills: discovered,
          errors,
        };
      } catch (e) {
        setError(`skills scan failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const registerLocalConnectorByProbe = useCallback(
    (
      name: string,
      command: string,
      tools: ConnectorTool[],
      serverVersion?: string,
    ): boolean => {
      const id = localConnectorIdForName(name);
      const result = registerLocalConnector(connectorsRef.current, {
        id,
        name,
        command,
        tools,
        serverVersion,
      });
      if (result === null) {
        setError("local MCP connector could not be saved: name, command and tools are required");
        return false;
      }
      setConnectors(result.registry);
      return true;
    },
    [],
  );

  const togglePinned = useCallback((sessionId: string) => {
    setSessions((cur) => {
      const current = cur.find((session) => session.session_id === sessionId);
      if (!current) return cur;
      return withPinnedFlag(cur, sessionId, current.pinned !== true);
    });
  }, []);

  const moveConversation = useCallback((sessionId: string, direction: -1 | 1) => {
    setSessions((cur) => moveThreadRow(cur, sessionId, direction));
  }, []);

  // US-3 + US-30 project actions. Creation past MAX_PROJECTS is refused
  // client-side with the explicit quota message in projectError.
  const createProject = useCallback(
    (name: string, workspacePaths?: string[]): Project | null => {
      const res = createProjectRow(projects, { name, workspaces: workspacePaths });
      setProjectError(res.error);
      if (res.project !== null) setProjects(res.projects);
      return res.project;
    },
    [projects],
  );

  const deleteProject = useCallback(
    (id: string) => {
      const res = deleteProjectRow(projects, threadProjects, id);
      setProjects(res.projects);
      setThreadProjects(res.attached);
    },
    [projects, threadProjects],
  );

  const updateProject = useCallback((id: string, patch: { name?: string; instructions?: string; workspace?: string; workspaces?: string[] }) => {
    setProjects((cur) => updateProjectRow(cur, id, patch));
  }, []);

  const attachThread = useCallback(
    (sessionId: string, projectId: string | null) => {
      setThreadProjects((cur) => attachThreadRow(cur, projects, sessionId, projectId));
    },
    [projects],
  );

  const projectForSession = useCallback(
    (sessionId: string): Project | null => {
      const pid = threadProjects[sessionId] ?? null;
      if (pid === null) return null;
      return projects.find((p) => p.id === pid) ?? null;
    },
    [projects, threadProjects],
  );

  const setGlobalSettings = useCallback((patch: Partial<ProjectSettings>) => {
    setGlobalSettingsState((cur) => ({ ...cur, ...patch }));
  }, []);

  const setProjectOverride = useCallback(
    (
      projectId: string,
      key: keyof ProjectSettings,
      value: ProjectSettings[keyof ProjectSettings] | undefined,
    ) => {
      setProjects((cur) => setProjectOverrideRow(cur, projectId, key, value));
    },
    [],
  );

  const settingsFor = useCallback(
    (projectId: string | null): ProjectSettings => {
      const found =
        projectId !== null ? projects.find((p) => p.id === projectId) : undefined;
      return resolveProjectSettings(globalSettings, found?.settings);
    },
    [projects, globalSettings],
  );
  const executeReviewItem = useCallback(
    async (item: ReviewItem, run?: ScheduleRun): Promise<boolean> => {
      const failRun = (message: string, retryable: boolean): void => {
        if (!run) return;
        setScheduleRuns((cur) => {
          const failed = settleRun(cur, run.id, "failed", Date.now(), message);
          return retryable && isRetryableScheduleError(message)
            ? queueRunRetry(failed, run.id, Date.now(), message)
            : failed;
        });
      };
      const knownIds = sessions.map((s) => s.session_id);
      const target = resolveReviewTarget(item.threadReuse, activeId, knownIds);
      if (target === null) {
        const message = "the recorded target thread is gone (discard or re-target)";
        setError(`schedule run failed: ${message}`);
        failRun(message, false);
        return false;
      }
      const targetSession = target === "new"
        ? null
        : sessions.find((session) => session.session_id === target) ?? null;
      // The conversation holds the native `\\?\G:\…` spelling, the schedule the
      // folder as picked: same directory, compared without the prefix.
      if (item.workspace && targetSession && displayPath(targetSession.workspace) !== displayPath(item.workspace)) {
        const message = "the recorded workspace no longer matches the target conversation";
        setError(`schedule run failed: ${message}`);
        failRun(message, false);
        return false;
      }
      if (item.projectId && targetSession && threadProjectsRef.current[target] !== item.projectId) {
        const message = "the recorded project no longer matches the target conversation";
        setError(`schedule run failed: ${message}`);
        failRun(message, false);
        return false;
      }
      const capturedProject = item.projectId
        ? projectsRef.current.find((project) => project.id === item.projectId)
        : undefined;
      const capturedSettings = capturedProject
        ? resolveProjectSettings(globalSettings, capturedProject.settings)
        : globalSettings;
      const applyCapturedContext = async (sessionId: string): Promise<void> => {
        if (item.authorizationMode && item.authorizationMode !== authorizationMode) {
          await invoke("set_approval_mode", { sessionId, mode: item.authorizationMode });
        }
        const model = item.model?.trim() || capturedSettings.model.trim();
        if (model && model !== "default") await setSessionModel(sessionId, model);
      };
      let sessionId: string;
      if (target === "new") {
        const settings = {
          ...capturedSettings,
          ...(item.model?.trim() ? { model: item.model.trim() } : {}),
        };
        const fresh = await startSessionRow(item.workspace, settings);
        if (fresh === null) {
          failRun("could not start target conversation", false);
          return false;
        }
        sessionId = fresh;
        if (item.projectId && capturedProject) {
          setThreadProjects((current) => attachThreadRow(current, projects, sessionId, item.projectId!));
        }
      } else {
        sessionId = target;
      }
      if (run) setScheduleRuns((cur) => markRunStarted(cur, run.id, Date.now(), sessionId));
      try {
        await applyCapturedContext(sessionId);
        const result = await sendInput(sessionId, item.instructions);
        if (result.ok) {
          // `send_input` only acknowledges admission. The run remains
          // running until the host emits a stopped turn status, where the
          // result preview and unread marker are captured.
          if (run && isCompactCommand(item.instructions.trim())) {
            setScheduleRuns((cur) => completeRun(cur, run.id, Date.now(), "Local compaction complete."));
          }
        } else {
          const message = result.error ?? "scheduled dispatch failed";
          failRun(message, true);
        }
        return result.ok;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failRun(message, true);
        setError(`schedule run failed: ${message}`);
        return false;
      }
    },
    [activeId, authorizationMode, globalSettings, projects, sendInput, sessions, setSessionModel, startSessionRow, threadProjects],
  );

  const prepareBrowserContext = useCallback(
    (sessionId: string, context: string): boolean => {
      const target = sessions.find((session) => session.session_id === sessionId);
      const text = context.trim();
      if (target === undefined || text.length === 0) {
        setError("browser context unavailable: open a conversation before inserting it");
        return false;
      }
      setPrefill((current) => (current ? `${current}\n\n${text}` : text));
      return true;
    },
    [sessions],
  );

  const prepareBrowserCapture = useCallback(
    (sessionId: string, capture: BrowserCapture): boolean => {
      const target = sessions.find((session) => session.session_id === sessionId);
      const attachment = browserCaptureAttachment(capture);
      const context = formatBrowserCaptureContext(capture);
      if (target === undefined || attachment === null || context.length === 0) {
        setError("browser capture unavailable: the image or page provenance is invalid");
        return false;
      }
      setPrefill((current) => (current ? `${current}\n\n${context}` : context));
      setPrefillAttachmentState({ sessionId, attachment });
      return true;
    },
    [sessions],
  );

  const prepareDesktopCapture = useCallback(
    (sessionId: string, capture: DesktopCapture): boolean => {
      const target = sessions.find((session) => session.session_id === sessionId);
      const attachment = desktopCaptureAttachment(capture);
      const context = formatDesktopCaptureContext(capture);
      if (target === undefined || attachment === null || context.length === 0) {
        setError("desktop capture unavailable: the image or session is invalid");
        return false;
      }
      setPrefill((current) => (current ? `${current}\n\n${context}` : context));
      setPrefillAttachmentState({ sessionId, attachment });
      return true;
    },
    [sessions],
  );

  const clearPrefillAttachment = useCallback(() => {
    setPrefillAttachmentState(null);
  }, []);

  const applyPersistentMcpProbe = useCallback(
    (id: string, result: LocalMcpProbeResult): boolean => {
      const updated = refreshLocalConnector(
        connectorsRef.current,
        id,
        result.tools,
        Date.now(),
        result.serverVersion,
      );
      if (updated === null) {
        setError("local MCP probe returned no valid tools");
        return false;
      }
      setConnectors(updated.registry);
      return true;
    },
    [],
  );

  const rollbackLocalMcp = useCallback((id: string): boolean => {
    const result = rollbackLocalConnector(connectorsRef.current, id);
    if (result === null) {
      setError("local MCP rollback is unavailable for this connector");
      return false;
    }
    setConnectors(result.registry);
    return true;
  }, []);

  // MCP servers may announce a changed tool catalog while idle. Polling only
  // asks the native registry to drain queued notifications; it performs no
  // work unless `notifications/tools/list_changed` was observed. This keeps
  // the connector registry as the SSOT while avoiding an always-on process
  // or a second client-side tools cache.
  useEffect(() => {
    if (!isTauriRuntime() || mcpRunningIds.length === 0) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (disposed || mcpPollBusyRef.current) return;
      mcpPollBusyRef.current = true;
      try {
        for (const id of mcpRunningIds) {
          const entry = findConnector(connectorsRef.current, id);
          if (entry === null || entry.kind !== "local") continue;
          try {
            const result = await invoke<LocalMcpProbeResult | null>("mcp_local_poll", {
              connectorId: id,
            });
            if (!disposed && result !== null) applyPersistentMcpProbe(id, result);
          } catch (e) {
            if (!disposed) {
              setMcpRunningIds((current) => current.filter((item) => item !== id));
              setError(`local MCP notification refresh failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } finally {
        mcpPollBusyRef.current = false;
      }
    };
    const schedule = () => {
      if (disposed) return;
      timer = setTimeout(() => {
        void poll().catch(() => undefined).finally(schedule);
      }, 5000);
    };
    void poll().catch(() => undefined).finally(schedule);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [applyPersistentMcpProbe, mcpRunningIds]);

  const startLocalMcp = useCallback(
    async (
      id: string,
      workspacePath?: string | null,
    ): Promise<LocalMcpProbeResult | null> => {
      const entry = findConnector(connectorsRef.current, id);
      if (entry === null || entry.kind !== "local" || !entry.command) {
        setError("local MCP start requires a configured command");
        return null;
      }
      try {
        const result = await invoke<LocalMcpProbeResult>("mcp_local_start", {
          connectorId: id,
          command: entry.command,
          workspace: workspacePath?.trim() || null,
        });
        setMcpRunningIds((current) =>
          current.includes(id) ? current : [...current, id],
        );
        applyPersistentMcpProbe(id, result);
        return result;
      } catch (e) {
        setMcpRunningIds((current) => current.filter((item) => item !== id));
        setError(`local MCP start failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [applyPersistentMcpProbe],
  );

  const refreshLocalMcp = useCallback(
    async (
      id: string,
      workspacePath?: string | null,
    ): Promise<LocalMcpProbeResult | null> => {
      const entry = findConnector(connectorsRef.current, id);
      if (entry === null || entry.kind !== "local" || !entry.command) {
        setError("local MCP refresh requires a configured command");
        return null;
      }
      try {
        const result = await invoke<LocalMcpProbeResult>("mcp_local_refresh", {
          connectorId: id,
          command: entry.command,
          workspace: workspacePath?.trim() || null,
        });
        setMcpRunningIds((current) =>
          current.includes(id) ? current : [...current, id],
        );
        applyPersistentMcpProbe(id, result);
        return result;
      } catch (e) {
        setMcpRunningIds((current) => current.filter((item) => item !== id));
        setError(`local MCP refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [applyPersistentMcpProbe],
  );

  const stopLocalMcp = useCallback(async (id: string): Promise<boolean> => {
    try {
      const stopped = await invoke<boolean>("mcp_local_stop", { connectorId: id });
      if (stopped) {
        setMcpRunningIds((current) => current.filter((item) => item !== id));
      }
      return stopped;
    } catch (e) {
      setError(`local MCP stop failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, []);

  const callRegisteredLocalMcp = useCallback(
    async (
      id: string,
      toolName: string,
      argumentsText: string,
    ): Promise<LocalMcpCallResult | null> => {
      let argumentsValue: unknown = {};
      try {
        argumentsValue = argumentsText.trim() ? JSON.parse(argumentsText) : {};
      } catch {
        setError("local MCP call failed: arguments must be valid JSON");
        return null;
      }
      try {
        return await invoke<LocalMcpCallResult>("mcp_local_call_persistent", {
          connectorId: id,
          toolName: toolName.trim(),
          arguments: argumentsValue,
        });
      } catch (e) {
        setMcpRunningIds((current) => current.filter((item) => item !== id));
        setError(`local MCP persistent call failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [],
  );

  const installMcpPackage = useCallback(
    async (file: File): Promise<boolean> => {
      if (!isTauriRuntime()) {
        setError("MCP bundle installation is available in the desktop app.");
        return false;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pkg: ParsedMcpPackage = parseMcpbArchive(bytes, file.name);
        const installed = await invoke<{ installRoot: string }>("mcp_package_install", {
          packageId: pkg.id,
          version: pkg.manifest.version,
          files: pkg.files.map((entry) => ({
            path: entry.path,
            base64Data: bytesToBase64(entry.bytes),
          })),
        });
        const command = buildMcpPackageCommand(pkg, installed.installRoot);
        const probe = await probeLocalMcp(command, workspace);
        if (probe === null || probe.tools.length === 0) {
          await invoke("mcp_package_remove", {
            packageId: pkg.id,
            version: pkg.manifest.version,
          }).catch(() => undefined);
          setError("MCP bundle installed but its server did not return any tools; nothing was registered.");
          return false;
        }
        if (mcpRunningIds.includes(pkg.id)) {
          const stopped = await stopLocalMcp(pkg.id);
          if (!stopped) {
            await invoke("mcp_package_remove", {
              packageId: pkg.id,
              version: pkg.manifest.version,
            }).catch(() => undefined);
            setError("MCP bundle update could not stop the previous server; the existing connector was kept.");
            return false;
          }
        }
        const registered = registerLocalConnector(connectorsRef.current, {
          id: pkg.id,
          name: pkg.manifest.name,
          command,
          tools: probe.tools.map((tool) => ({ name: tool.name, description: tool.description })),
          serverVersion: probe.serverVersion,
          source: "package",
          package: {
            format: "mcpb",
            version: pkg.manifest.version,
            sourceName: pkg.sourceName,
            installRoot: installed.installRoot,
            entryPoint: pkg.manifest.entryPoint,
            runtime: pkg.manifest.runtime,
            installedAt: Date.now(),
          },
        });
        if (registered === null) {
          await invoke("mcp_package_remove", {
            packageId: pkg.id,
            version: pkg.manifest.version,
          }).catch(() => undefined);
          setError("MCP bundle returned an invalid tool catalogue; the existing connector was kept.");
          return false;
        }
        setConnectors(registered.registry);
        return true;
      } catch (error) {
        setError(`MCP bundle installation failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    [mcpRunningIds, probeLocalMcp, stopLocalMcp, workspace],
  );
  scheduledExecutorRef.current = async (item, run) => {
    await executeReviewItem(item, run);
  };

  // US-9 automation actions (create/toggle/delete/run-now/approve/discard).
  const createScheduleCb = useCallback((input: ScheduleInput): string | null => {
    const err = validateScheduleInput(input);
    if (err !== null) {
      setError(err);
      return null;
    }
    if (schedulesRef.current.length >= MAX_SCHEDULES) {
      setError(`too many schedules (cap ${MAX_SCHEDULES})`);
      return null;
    }
    const s = buildSchedule(input, Date.now());
    setSchedules((cur) => [...cur, s]);
    return s.id;
  }, []);

  const setScheduleEnabledCb = useCallback((id: string, enabled: boolean) => {
    setSchedules((cur) => setScheduleEnabled(cur, id, enabled));
  }, []);

  const deleteScheduleCb = useCallback((id: string) => {
    setSchedules((cur) => removeSchedule(cur, id));
  }, []);

  const runScheduleNow = useCallback((id: string) => {
    const res = enqueueRunNow(schedulesRef.current, reviewQueueRef.current, id, Date.now());
    if (res === null) {
      setError(`run-now failed: unknown schedule ${id.slice(0, 8)}`);
      return;
    }
    setSchedules(res.schedules);
    const item = res.added;
    if (item.authorizationMode === "ask") {
      setReviewQueue(res.queue);
      return;
    }
    const run = createScheduleRun({
      scheduleId: item.scheduleId,
      scheduleName: item.scheduleName,
      instructions: item.instructions,
      threadReuse: item.threadReuse,
      ...(item.workspace ? { workspace: item.workspace } : {}),
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.authorizationMode ? { authorizationMode: item.authorizationMode } : {}),
      ...(item.missedPolicy ? { missedPolicy: item.missedPolicy } : {}),
      ...(item.timeZone ? { timeZone: item.timeZone } : {}),
      occurrenceAt: item.occurrenceAt ?? item.createdAt,
      ...(item.occurrenceKey ? { occurrenceKey: item.occurrenceKey } : {}),
    }, Date.now());
    setScheduleRuns((cur) => appendRun(cur, run));
    void executeReviewItem(item, run);
  }, [executeReviewItem]);

  const approveReviewCb = useCallback(
    async (id: string): Promise<void> => {
      const item = pendingReviews(reviewQueueRef.current).find((r) => r.id === id);
      if (!item) {
        setError(`approve failed: review entry ${id.slice(0, 8)} is not pending`);
        return;
      }
      // Settle first: the entry leaves the pending queue even if the send
      // below fails (the error banner then explains; the instructions stay
      // readable in the settled entry).
      const settled = approveReview(reviewQueueRef.current, id);
      if (settled !== null) setReviewQueue(settled.queue);
      await executeReviewItem(item);
    },
    [executeReviewItem],
  );

  const discardReviewCb = useCallback((id: string) => {
    const res = discardReview(reviewQueueRef.current, id);
    if (res !== null) setReviewQueue(res.queue);
  }, []);

  const cancelScheduleRun = useCallback((id: string): void => {
    setScheduleRuns((cur) => cancelRun(cur, id));
  }, []);

  const markScheduleRunRecoveryFailed = useCallback((id: string): void => {
    setScheduleRuns((cur) => markRecoveredRunFailed(cur, id, Date.now()));
  }, []);

  const markScheduleRunRead = useCallback((id: string): void => {
    setScheduleRuns((cur) => markRunRead(cur, id));
  }, []);

  const setScheduleRunArchived = useCallback((id: string, archived: boolean): void => {
    setScheduleRuns((cur) => archived ? archiveRun(cur, id) : restoreRun(cur, id));
  }, []);

  const retryScheduleRunNow = useCallback((id: string): void => {
    setScheduleRuns((cur) => retryRunNow(cur, id, Date.now()));
  }, []);
  // w-collab US-27: explicit share / un-share + mode toggle. Manual mode
  // shares only here; auto additionally refreshes on turn end (see
  // refreshAutoShare); disabled refuses (createShareBundle returns null).
  const setShareMode = useCallback((mode: ShareMode) => {
    setShareState((cur) => setShareModePure(cur, mode));
  }, []);

  const sessionBundles = useCallback(
    (sessionId: string): ShareBundle[] => listSessionBundles(shareState, sessionId),
    [shareState],
  );

  const shareSession = useCallback(
    (sessionId: string, format: BundleFormat): ShareBundle | null => {
      const log = logsRef.current[sessionId] ?? loadLog(sessionId);
      const title =
        sessions.find((s) => s.session_id === sessionId)?.title ?? sessionId;
      const created = createShareBundle(shareState, sessionId, title, log, format);
      if (created === null) {
        if (shareState.mode === "disabled") {
          setError("sharing is disabled (share mode off).");
        }
        return null;
      }
      setShareState(created.state);
      return created.bundle;
    },
    [shareState, sessions],
  );

  const unshareBundle = useCallback((bundleId: string) => {
    setShareState((cur) => revokeBundle(cur, bundleId));
    // A revoked auto snapshot stops being "the live one": the next turn
    // end mints a fresh auto bundle instead of revoking an already-dead id.
    for (const [sid, bid] of Object.entries(autoBundleIds.current ?? {})) {
      if (bid === bundleId) delete (autoBundleIds.current as Record<string, string>)[sid];
    }
  }, []);

  /**
   * w-collab US-27 auto mode: on turn end, refresh this session's single
   * live auto snapshot (revoke the previous, mint a new one). Outcome is
   * one live auto bundle per session; manual bundles are never touched.
   * No-op unless the mode is auto.
   */
  function refreshAutoShare(sessionId: string): void {
    if (!shouldAutoShare(shareState)) return;
    const log = logsRef.current[sessionId] ?? [];
    if (log.length === 0) return;
    const title =
      sessions.find((s) => s.session_id === sessionId)?.title ?? sessionId;
    let next = shareState;
    const prevId = autoBundleIds.current?.[sessionId];
    if (prevId && next.bundles[prevId] && !next.bundles[prevId].revoked) {
      next = revokeBundle(next, prevId);
    }
    const created = createShareBundle(next, sessionId, title, log, "markdown");
    if (created === null) return;
    if (autoBundleIds.current === null) autoBundleIds.current = {};
    autoBundleIds.current[sessionId] = created.bundle.bundleId;
    writeStorageJson(AUTO_MAP_KEY, autoBundleIds.current);
    setShareState(created.state);
  }

  // w-collab US-34: import a config file's text (pasted or picked). The
  // merge is import-only: live sessions and existing rows always win.
  const importConfigText = useCallback(
    (source: string, content: string) => {
      const sum = parseImportPayload(source, content);
      setImportedSessions((cur) =>
        mergeImportedSessions(
          cur,
          sum.sessions,
          sessions.map((s) => s.session_id),
        ),
      );
      setImportNotes((cur) => [...cur, ...sum.notes].slice(-10));
    },
    [sessions],
  );

  const dismissImport = useCallback((id: string) => {
    setImportedSessions((cur) => dismissImportedSession(cur, id));
  }, []);
  // US-20: memory CRUD (blank text is a no-op in addMemory) + SCAN ack.
  // The nudge is derived (not state): due = interval elapsed + non-empty.
  const addMemoryEntry = useCallback((text: string, source: string) => {
    setMemories((cur) => addMemory(cur, text, source, Date.now()));
  }, []);

  const removeMemoryEntry = useCallback((id: string) => {
    setMemories((cur) => removeMemory(cur, id));
  }, []);

  const ackScanNudge = useCallback(() => {
    setLastScan(Date.now());
  }, []);

  const scanNudge =
    shouldScanNudge(memories.length, lastScan, Date.now())
      ? buildScanNudge(memories, Date.now())
      : null;

  const activeLog = (activeId !== null && logs[activeId]) || [];
  const activeApprovals = approvals.filter((a) => a.session_id === activeId);
  const activeInputRequests = inputRequests.filter((r) => r.session_id === activeId);
  // M0-03: retryable sends across sessions (the UI filters by active view;
  // a retry always routes by the entry's own sessionId).
  const pendingSends = failedOutbox(Object.values(outbox).flat());
  // w-settings: provider id selected for the current project (workspace).
  const providerId = providerForProject(providerMap, workspace);

  const answerInput = useCallback(
    async (sessionId: string, inputId: string, answers: InputAnswer[]) => {
      try {
        setError(null);
        await invoke("answer_input", {
          sessionId,
          userInputId: inputId,
          answers,
        });
        // Panel removal arrives via input_settled; on success the turn
        // resumes. On error (-32057) the panel stays for a corrected answer.
        // Drain now so the resumed turn paints from its first tokens.
        // US-10: reflexive placeholder synchronously, same as after send.
        touchStreamActivity(sessionId, "client/input");
        ensurePlaceholder(sessionId);
        markResumePending(sessionId, "input");
        kickPoll();
      } catch (e) {
        setError(`answer_input failed: ${String(e)}`);
      }
    },
    [kickPoll, touchStreamActivity],
  );

  const cancelInput = useCallback(async (sessionId: string, inputId: string) => {
    try {
      setError(null);
      await invoke("cancel_input", { sessionId, userInputId: inputId });
    } catch (e) {
      setError(`cancel_input failed: ${String(e)}`);
    }
  }, []);

  // US-6 sub-agent controls: each method invokes exactly one `subagent/*`
  // Tauri command (one MSP method), then kicks the poll loop so the effect
  // paints from its first events instead of waiting for the next tick.
  const subagentFireAndForget = useCallback(
    async (command: string, sessionId: string, agentId: string, extra?: Record<string, string>) => {
      try {
        setError(null);
        await invoke(command, { sessionId, agentId, ...extra });
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Subagent ${agentId}: ${command} sent.` },
        ]);
        kickPoll();
      } catch (e) {
        setError(`${command} failed: ${String(e)}`);
      }
    },
    [kickPoll],
  );

  const subagentInterrupt = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_interrupt", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentClose = useCallback(
    async (sessionId: string, agentId: string, reason?: string) => {
      if (!isTauriRuntime()) return;
      try {
        await invoke("subagent_close", {
          sessionId,
          agentId,
          ...(reason !== undefined && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        });
      } catch (error) {
        setError(userFacingError(error, "The agent could not be closed."));
      }
    },
    [],
  );

  const subagentReopen = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_reopen", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentStop = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_stop", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentResume = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_resume", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentFollowup = useCallback(
    async (sessionId: string, agentId: string, task: string) => {
      const trimmed = task.trim();
      if (!trimmed) {
        setError("subagent_followup failed: task must not be empty");
        return;
      }
      await subagentFireAndForget("subagent_followup", sessionId, agentId, { task: trimmed });
    },
    [subagentFireAndForget],
  );

  const subagentReadResult = useCallback(
    async (sessionId: string, agentId: string): Promise<string | null> => {
      try {
        setError(null);
        const res = await invoke<unknown>("subagent_read_result", { sessionId, agentId });
        const text = formatSubagentResult(res);
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Subagent ${agentId} result:\n${text}` },
        ]);
        kickPoll();
        return text;
      } catch {
        // The block owns this failure (`failed[entry.id]` in StreamView): a
        // per-block control must not raise the conversation-wide banner.
        return null;
      }
    },
    [kickPoll],
  );

  const subagentDrilldown = useCallback(
    async (sessionId: string, childSessionId: string | undefined): Promise<string | null> => {
      if (!childSessionId) {
        // Never a silent empty view: without an id there is nothing
        // `session/read` could open, and the block says so itself.
        return null;
      }
      try {
        setError(null);
        const res = await invoke<unknown>("subagent_drilldown", {
          sessionId,
          childSessionId,
        });
        const text = formatDrilldown(res);
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Child session ${childSessionId}:\n${text}` },
        ]);
        kickPoll();
        return text;
      } catch {
        // Reported in the block, never in the conversation-wide banner: this
        // failure belongs to one sub-agent entry (see `failed` in StreamView).
        return null;
      }
    },
    [kickPoll],
  );

  const readItemOutput = useCallback(
    async (sessionId: string, entry: LogEntry, offsetBytes = 0): Promise<ItemOutputChunk | null> => {
      if (!entry.itemId || !entry.outputRef) {
        setError("item output is unavailable: this item has no host output reference");
        return null;
      }
      try {
        setError(null);
        const offset = Math.max(0, Math.floor(offsetBytes));
        const result = await invoke<unknown>("read_item_output", {
          sessionId,
          itemId: entry.itemId,
          outputRef: entry.outputRef,
          offsetBytes: offset,
          lengthBytes: 64 * 1024,
        });
        const value = typeof result === "object" && result !== null
          ? result as Record<string, unknown>
          : {};
        const rawContent = typeof value.content === "string" ? value.content : "";
        const encoding = typeof value.encoding === "string" ? value.encoding.toLowerCase() : "";
        let content = rawContent;
        let base64Data: string | undefined;
        if (encoding === "base64" && typeof atob === "function") {
          // Keep binary output opaque. TextDecoder would corrupt images and
          // documents; the stream decides how to preview the media type.
          try {
            atob(rawContent);
            base64Data = rawContent.replace(/\s+/g, "");
            content = "";
          } catch {
            throw new Error("host returned invalid base64 output");
          }
        }
        const returnedOffset = typeof value.offsetBytes === "number" && Number.isFinite(value.offsetBytes)
          ? Math.max(0, value.offsetBytes)
          : offset;
        const inferredBinaryByteLen = base64Data === undefined
          ? undefined
          : Math.max(0, Math.floor(base64Data.length * 3 / 4) - (base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0));
        const byteLen = typeof value.byteLen === "number" && Number.isFinite(value.byteLen)
          ? Math.max(0, value.byteLen)
          : inferredBinaryByteLen ?? new TextEncoder().encode(content).byteLength;
        const eof = value.eof === true;
        return {
          content,
          ...(base64Data === undefined ? {} : { base64Data }),
          offsetBytes: returnedOffset,
          nextOffsetBytes: returnedOffset + byteLen,
          byteLen,
          eof,
          ...(typeof value.mediaType === "string" && value.mediaType.length > 0
            ? { mediaType: value.mediaType }
            : {}),
        };
      } catch (e) {
        setError(`read_item_output failed: ${String(e)}`);
        return null;
      }
    },
    [],
  );

  const beginGitRequest = useCallback((sessionId: string): number => {
    const next = (gitRequestSeq.current[sessionId] ?? 0) + 1;
    gitRequestSeq.current[sessionId] = next;
    setGitReviewBySession((cur) => ({
      ...cur,
      [sessionId]: {
        ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
        loading: true,
        error: null,
      },
    }));
    return next;
  }, []);

  const refreshGitStatus = useCallback(
    async (sessionId: string): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_status", {
          sessionId,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const loadGitDiff = useCallback(
    async (
      sessionId: string,
      scope: GitDiffScope,
      baseRef?: string,
    ): Promise<GitDiffSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const diff = await invoke<GitDiffSnapshot>("git_diff", {
          sessionId,
          scope,
          baseRef: baseRef ?? null,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            diff,
            loading: false,
            error: null,
          },
        }));
        return diff;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const gitReview = useCallback(
    (sessionId: string): GitReviewState =>
      gitReviewBySession[sessionId] ?? EMPTY_GIT_REVIEW,
    [gitReviewBySession],
  );

  const gitTurnSnapshot = useCallback(
    (sessionId: string): GitTurnSnapshot | null =>
      gitTurnSnapshotsBySession[sessionId] ?? null,
    [gitTurnSnapshotsBySession],
  );

  const stageGitFiles = useCallback(
    async (
      sessionId: string,
      paths: string[],
      expected: GitMutationExpectation,
    ): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_stage", {
          sessionId,
          paths,
          expectedHead: expected.head,
          expectedStatus: expected.statusFingerprint,
          expectedPatch: expected.patch,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const restoreGitFiles = useCallback(
    async (
      sessionId: string,
      paths: string[],
      scope: "staged" | "unstaged",
      expected: GitMutationExpectation,
    ): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_restore", {
          sessionId,
          paths,
          scope,
          expectedHead: expected.head,
          expectedStatus: expected.statusFingerprint,
          expectedPatch: expected.patch,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const applyGitHunk = useCallback(
    async (
      sessionId: string,
      path: string,
      scope: "staged" | "unstaged",
      action: "stage" | "unstage" | "discard",
      hunkHeader: string,
      expected: GitMutationExpectation,
    ): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_apply_hunk", {
          sessionId,
          path,
          scope,
          action,
          hunkHeader,
          expectedHead: expected.head,
          expectedStatus: expected.statusFingerprint,
          expectedPatch: expected.patch,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const commitGit = useCallback(
    async (
      sessionId: string,
      message: string,
      expected: GitMutationExpectation,
    ): Promise<GitCommitResult | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const result = await invoke<GitCommitResult>("git_commit", {
          sessionId,
          message,
          expectedHead: expected.head,
          expectedStatus: expected.statusFingerprint,
          expectedPatch: expected.patch,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        let status: GitStatusSnapshot | null = null;
        try {
          status = await invoke<GitStatusSnapshot>("git_status", { sessionId });
        } catch {
          // Commit succeeded; the next explicit refresh will recover status.
        }
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status: status ?? cur[sessionId]?.status ?? null,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return result;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const fetchGit = useCallback(
    async (sessionId: string, remote: string): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_fetch", {
          sessionId,
          remote,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const pullGit = useCallback(
    async (
      sessionId: string,
      remote: string,
      branch: string,
      expectedHead: string | null,
      expectedStatus: string | null,
    ): Promise<GitStatusSnapshot | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const status = await invoke<GitStatusSnapshot>("git_pull", {
          sessionId,
          remote,
          branch,
          expectedHead,
          expectedStatus,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            status,
            diff: null,
            loading: false,
            error: null,
          },
        }));
        return status;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const pushGit = useCallback(
    async (
      sessionId: string,
      remote: string,
      branch: string,
      expectedHead: string | null,
    ): Promise<GitPushResult | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const result = await invoke<GitPushResult>("git_push", {
          sessionId,
          remote,
          branch,
          expectedHead,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: null,
          },
        }));
        return result;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const createGitPr = useCallback(
    async (
      sessionId: string,
      title: string,
      body: string,
      base: string,
      head: string,
    ): Promise<GitPrResult | null> => {
      const request = beginGitRequest(sessionId);
      try {
        const result = await invoke<GitPrResult>("git_create_pr", {
          sessionId,
          title,
          body,
          base,
          head,
        });
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: null,
          },
        }));
        return result;
      } catch (e) {
        if (gitRequestSeq.current[sessionId] !== request) return null;
        setGitReviewBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? EMPTY_GIT_REVIEW),
            loading: false,
            error: String(e),
          },
        }));
        return null;
      }
    },
    [beginGitRequest],
  );

  const terminalForSession = useCallback(
    (sessionId: string): TerminalState | null => terminalsBySession[sessionId] ?? null,
    [terminalsBySession],
  );

  const openTerminal = useCallback(
    async (sessionId: string, cols = 100, rows = 28): Promise<TerminalInfo | null> => {
      const existing = terminalsBySession[sessionId];
      if (existing) return existing.info;
      try {
        const info = await invoke<TerminalInfo>("terminal_open", {
          sessionId,
          cols,
          rows,
        });
        setTerminalsBySession((cur) => ({
          ...cur,
          [sessionId]: { info, output: cur[sessionId]?.output ?? "", done: false },
        }));
        return info;
      } catch (e) {
        setError(`terminal_open failed: ${String(e)}`);
        return null;
      }
    },
    [terminalsBySession],
  );

  const readTerminal = useCallback(async (terminalId: string): Promise<void> => {
    try {
      const result = await invoke<{ terminalId: string; output: string; done: boolean }>(
        "terminal_read",
        { terminalId },
      );
      setTerminalsBySession((cur) => {
        const entry = Object.entries(cur).find(([, state]) => state.info.terminalId === terminalId);
        if (!entry) return cur;
        const [sessionId, state] = entry;
        const output = result.output
          ? `${state.output}${result.output}`.slice(-200_000)
          : state.output;
        return { ...cur, [sessionId]: { ...state, output, done: result.done } };
      });
    } catch (e) {
      // A panel can poll during an explicit close; that race is expected and
      // should not replace the conversation with a global error banner.
      if (!String(e).toLowerCase().includes("unknown terminal")) {
        setError(`terminal_read failed: ${String(e)}`);
      }
    }
  }, []);

  const writeTerminal = useCallback(async (terminalId: string, input: string): Promise<void> => {
    try {
      await invoke("terminal_write", { terminalId, input });
    } catch (e) {
      setError(`terminal_write failed: ${String(e)}`);
    }
  }, []);

  const resizeTerminal = useCallback(async (terminalId: string, cols: number, rows: number): Promise<void> => {
    try {
      const info = await invoke<TerminalInfo>("terminal_resize", { terminalId, cols, rows });
      setTerminalsBySession((cur) => {
        const entry = Object.entries(cur).find(([, state]) => state.info.terminalId === terminalId);
        if (!entry) return cur;
        const [sessionId, state] = entry;
        return { ...cur, [sessionId]: { ...state, info } };
      });
    } catch (e) {
      setError(`terminal_resize failed: ${String(e)}`);
    }
  }, []);

  const closeTerminal = useCallback(async (sessionId: string): Promise<void> => {
    const terminal = terminalsBySession[sessionId];
    if (!terminal) return;
    try {
      await invoke("terminal_close", { terminalId: terminal.info.terminalId });
    } catch (e) {
      setError(`terminal_close failed: ${String(e)}`);
    } finally {
      setTerminalsBySession((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
    }
  }, [terminalsBySession]);

  const prepareTerminalContext = useCallback(
    (sessionId: string): boolean => {
      const terminal = terminalsBySession[sessionId];
      if (!terminal) {
        setError("terminal context unavailable: open a terminal first");
        return false;
      }
      if (!terminal.output.trim()) {
        setError("terminal context unavailable: there is no output to add");
        return false;
      }
      const context = formatTerminalContext(terminal.info, terminal.output);
      setPrefill((current) => (current ? `${current}\n${context}` : context));
      return true;
    },
    [terminalsBySession],
  );

  const userShellAvailableForSession = useCallback(
    (sessionId: string): boolean =>
      grantedCapabilitiesBySession[sessionId]?.some((capability) => capability === "userShell") === true,
    [grantedCapabilitiesBySession],
  );

  /**
   * Whether the host currently has this conversation loaded.
   *
   * `undefined` means the host did not report a status, which must not block an
   * action; only an explicit `false` does.
   */
  const sessionLoadedForSession = useCallback(
    (sessionId: string): boolean | undefined => sessionLoadedBySession[sessionId],
    [sessionLoadedBySession],
  );

  /** M1-06: explicit `!`-style host shell action from the terminal panel. */
  const runUserShell = useCallback(
    async (sessionId: string, command: string): Promise<boolean> => {
      const commandText = command.trim();
      if (!commandText) return false;
      if (!userShellAvailableForSession(sessionId)) {
        setError("The Muse host did not grant the userShell capability for this conversation.");
        return false;
      }
      // `session/userShell` uses the same UUIDv7 idempotency contract as a
      // normal turn. Derive it from a fresh client id so retries and host
      // deduplication keep the protocol-level ordering guarantees.
      const commandId = commandIdFromClientMessageId(newId(), Date.now());
      if (!commandId) {
        setError("user_shell failed: could not allocate a valid command id");
        return false;
      }
      try {
        await invoke("user_shell", { sessionId, commandId, commandText });
        // The host's item/started event supplies the authoritative item id;
        // this local seed makes the command visible immediately after the
        // admission ack and is rebound to that id when the event arrives.
        ensurePlaceholder(sessionId, undefined, undefined, "tool", undefined, `$ ${commandText}`);
        touchStreamActivity(sessionId, "client/userShell");
        return true;
      } catch (e) {
        setError(`user_shell failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [touchStreamActivity, userShellAvailableForSession],
  );

  const filesForSession = useCallback(
    (sessionId: string): FilesBrowserState => filesBySession[sessionId] ?? emptyFilesBrowserState(),
    [filesBySession],
  );

  const listWorkspaceFiles = useCallback(
    async (sessionId: string, path = "."): Promise<void> => {
      const request = (filesRequestSeq.current[sessionId] ?? 0) + 1;
      filesRequestSeq.current[sessionId] = request;
      setFilesBySession((cur) => ({
        ...cur,
        [sessionId]: { ...(cur[sessionId] ?? emptyFilesBrowserState()), loading: true, error: null },
      }));
      try {
        const result = await invoke<{
          root: string;
          path: string;
          entries: WorkspaceFileEntry[];
          truncated: boolean;
          observedAt: number;
        }>("files_list", { sessionId, relativePath: path, limit: 200 });
        if (filesRequestSeq.current[sessionId] !== request) return;
        setFilesBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? emptyFilesBrowserState()),
            path: result.path,
            entries: result.entries,
            truncated: result.truncated,
            selectedPath: null,
            preview: null,
            loading: false,
            error: null,
            observedAt: result.observedAt,
            stale: false,
            changedPaths: [],
          },
        }));
      } catch (e) {
        if (filesRequestSeq.current[sessionId] !== request) return;
        setFilesBySession((cur) => ({
          ...cur,
          [sessionId]: { ...(cur[sessionId] ?? emptyFilesBrowserState()), loading: false, error: String(e) },
        }));
      }
    },
    [],
  );

  const watchWorkspaceFiles = useCallback(async (sessionId: string): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      await invoke("files_watch", { sessionId });
    } catch (e) {
      // A watcher is an enhancement over the explicit Refresh action. Keep
      // the Files surface usable when an older/native host lacks the command.
      setFilesBySession((cur) => ({
        ...cur,
        [sessionId]: {
          ...(cur[sessionId] ?? emptyFilesBrowserState()),
          error: `workspace watcher unavailable: ${String(e)}`,
        },
      }));
    }
  }, []);

  const unwatchWorkspaceFiles = useCallback(async (sessionId: string): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      await invoke("files_unwatch", { sessionId });
    } catch {
      // Teardown is best effort; dropping the native registration is safe
      // even when the renderer is already closing.
    }
  }, []);

  const readWorkspaceFile = useCallback(
    async (sessionId: string, path: string): Promise<void> => {
      const request = (filesRequestSeq.current[sessionId] ?? 0) + 1;
      filesRequestSeq.current[sessionId] = request;
      setFilesBySession((cur) => ({
        ...cur,
        [sessionId]: {
          ...(cur[sessionId] ?? emptyFilesBrowserState()),
          loading: true,
          selectedPath: path,
          error: null,
        },
      }));
      try {
        const preview = await invoke<FileReadResult>("file_read", {
          sessionId,
          path,
          maxChars: 120_000,
        });
        if (filesRequestSeq.current[sessionId] !== request) return;
        setFilesBySession((cur) => ({
          ...cur,
          [sessionId]: (() => {
            const previous = cur[sessionId] ?? emptyFilesBrowserState();
            const changedPaths = previous.changedPaths.filter((changedPath) => changedPath !== path);
            return {
              ...previous,
              selectedPath: path,
              preview,
              loading: false,
              error: null,
              stale: changedPaths.length > 0,
              changedPaths,
            };
          })(),
        }));
      } catch (e) {
        if (filesRequestSeq.current[sessionId] !== request) return;
        setFilesBySession((cur) => ({
          ...cur,
          [sessionId]: {
            ...(cur[sessionId] ?? emptyFilesBrowserState()),
            selectedPath: path,
            loading: false,
            error: String(e),
          },
        }));
      }
    },
    [],
  );

  const prepareWorkspaceFileContext = useCallback(
    (sessionId: string): boolean => {
      const preview = filesBySession[sessionId]?.preview;
      if (preview === undefined || preview === null) {
        setError("file context unavailable: select a text file first");
        return false;
      }
      if (preview.binary || preview.content === null) {
        setError("file context unavailable: this file has no text preview");
        return false;
      }
      const context = formatWorkspaceFileContext(preview);
      if (context.length === 0) {
        setError("file context unavailable: the file preview is empty");
        return false;
      }
      setPrefill((current) => (current ? `${current}\n${context}` : context));
      return true;
    },
    [filesBySession],
  );

  const openWorkspacePath = useCallback(
    async (sessionId: string, path: string): Promise<void> => {
      if (!isTauriRuntime()) {
        setError("Opening workspace files requires the Muse Desktop runtime.");
        return;
      }
      try {
        await invoke("file_open", { sessionId, path });
      } catch (e) {
        setError(`file_open failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [],
  );

  // US-23 search over the stored index (empty unless opted in). Search
  // keeps working while paused — pause only suspends indexing updates.
  const indexResults = searchIndex(indexStore, indexEnabled ? indexQuery : "");
  const indexStatsNow = indexStats(indexStore);
  const index: IndexApi = {
    enabled: indexEnabled,
    paused: indexPaused,
    fileCount: indexStatsNow.files,
    lineCount: indexStatsNow.lines,
    builtAt: indexStore.builtAt,
    lastSummary: indexSummary,
    hasSource: indexFilesRef.current.length > 0,
    query: indexQuery,
    results: indexResults,
    setIndexEnabled,
    setIndexPaused,
    indexPickedFiles,
    rescanIndexFiles,
    rebuildIndex,
    deleteIndex,
    setIndexQuery,
  };

  // Updated every render; the poll loop reads it for cadence.
  runningRef.current = sessions.some((s) => s.running);
  // Latest event handler for the render-detached poll drain.
  handleEventRef.current = handleEvent;
  const activeQueuedTurns = activeId === null ? [] : (queuedTurnsBySession[activeId] ?? []);
  const activeStreamActivity = activeId === null
    ? null
    : (streamActivityBySession[activeId] ?? null);
  const activeRecoveryNotice = activeId === null
    ? null
    : (recoveryNoticeBySession[activeId] ?? null);
  const activeResumePending = activeId === null
    ? null
    : (resumePendingBySession[activeId] ?? null);
  const activeRetryScheduled = activeId === null
    ? null
    : (retryScheduledBySession[activeId] ?? null);
  const activeConnectionState = activeId === null
    ? "disconnected"
    : (connectionBySession[activeId] ?? "disconnected");

  return {
    sessions,
    activeId,
    logs,
    activeLog,
    approvals,
    activeApprovals,
    streamActivityBySession,
    activeStreamActivity,
    recoveryNoticeBySession,
    activeRecoveryNotice,
    resumePendingBySession,
    activeResumePending,
    retryScheduledBySession,
    activeRetryScheduled,
    turnCompletionBySession,
    stoppingBySession,
    connectionBySession,
    activeConnectionState,
    queuedTurns: activeQueuedTurns,
    inputRequests,
    activeInputRequests,
    workspace,
    backendMissing,
    setWorkspace,
    setActive,
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
    createWorktreeForWorkspace,
    inspectWorktree,
    checkWorktreeReadiness,
    runWorktreeSetup,
    cancelWorktreeSetup,
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
    setAllowRuleDecision: setAllowRuleDecisionCb,
    browserAnnotations,
    addBrowserAnnotation: addBrowserAnnotationCb,
    prepareBrowserContext,
    prepareBrowserCapture,
    prepareDesktopCapture,
    removeBrowserAnnotation: removeBrowserAnnotationCb,
    browserPermissions,
    setBrowserAppPermission: setBrowserAppPermissionCb,
    computerUse,
    computerBusy,
    refreshComputerUse,
    setComputerLevel,
    disableComputerUse,
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
    projectForSession,
    globalSettings,
    setGlobalSettings,
    setProjectOverride,
    settingsFor,
    schedules,
    reviewQueue: pendingReviews(reviewQueue),
    scheduleRuns,
    schedulerStatus,
    schedulerWakeupStatus,
    notifications,
    notificationPermission: notificationPermissionState,
    notificationsMuted: notificationPreferences.desktopMuted,
    unreadNotificationCount: countUnreadNotifications(notifications),
    enableNotifications,
    setNotificationsMuted,
    markNotificationRead,
    markAllNotificationsRead,
    createSchedule: createScheduleCb,
    setScheduleEnabled: setScheduleEnabledCb,
    deleteSchedule: deleteScheduleCb,
    runScheduleNow,
    cancelScheduleRun,
    markScheduleRunRecoveryFailed,
    markScheduleRunRead,
    setScheduleRunArchived,
    retryScheduleRunNow,
    approveReview: approveReviewCb,
    discardReview: discardReviewCb,
    shareMode: shareState.mode,
    setShareMode,
    sessionBundles,
    shareSession,
    unshareBundle,
    channelsExperimental,
    importedSessions,
    importNotes,
    importConfigText,
    dismissImport,
    memories,
    scanNudge,
    addMemoryEntry,
    removeMemoryEntry,
    ackScanNudge,
    subagentClose,
    subagentReopen,
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
    registerLocalConnector: registerLocalConnectorByProbe,
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
    compactSession: doCompact,
    usageBySession,
    serverCompactionBySession,
    serverCompact,
    newFromSummary,
    prefill,
    prefillComposer,
    clearPrefill,
    prefillAttachment: prefillAttachmentState?.attachment ?? null,
    prefillAttachmentSessionId: prefillAttachmentState?.sessionId ?? null,
    clearPrefillAttachment,
    artifacts,
    restoreArtifact,
    commentArtifact,
    editArtifact,
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
    error,
    setError: (message) => setError(message),
    evtCount,
    dismissQueuedTurn,
    startupProbe,
    probeStartup,
  };
}
