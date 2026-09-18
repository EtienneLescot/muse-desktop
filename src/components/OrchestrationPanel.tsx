import { useEffect, useMemo, useRef, useState } from "react";
import { fanoutLanes, fanoutQueueNote } from "../lib/fanout";
import {
  parseWriterPaths,
  planWriterQueue,
  type WriterQueueRow,
  type WriterQueueStatus,
} from "../lib/writerQueue";
import { loadWriterTargets, saveWriterTargets } from "../lib/writerTargets";
import {
  buildWriterPrompt,
  summarizeWriterLog,
  writerDispatchCanStart,
  writerDispatchIsActive,
  type WriterDispatchRecord,
} from "../lib/writerDispatch";
import type { LogEntry } from "../lib/persist";
import {
  buildHandoffPlan,
  isHandoffPlanStale,
  type HandoffInput,
  type HandoffPlan,
} from "../lib/handoff";
import type { GitStatusSnapshot } from "../lib/git";
import {
  compareHeadHashes,
  DEFAULT_SETUP_ENV_NAMES,
  MAX_SETUP_COMMAND_CHARS,
  parseSetupEnvAllowlist,
  planWorktrees,
  summarizeWorktreeInspections,
  validateSetupCommand,
  worktreeShellSnippet,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeInspection,
  type WorktreeSetupResult,
  type WorktreeReadiness,
} from "../lib/worktrees";
import { CapabilityBadge } from "./CapabilityBadge";
import { userFacingError } from "../lib/errorCopy";
import {
  loadSetupProfiles,
  removeSetupProfile,
  upsertSetupProfile,
  type SetupProfile,
} from "../lib/setupProfiles";
import {
  loadWorktreeRetention,
  normalizeRetentionDays,
  retentionDecision,
  saveWorktreeRetention,
  type WorktreeRetentionPolicy,
} from "../lib/worktreeRetention";
import type { WorktreeCleanupIntent } from "../lib/worktreeCleanup";

interface Props {
  /** Agent ids seen as `subagent` entries in the active thread log. */
  agents: string[];
  /** Conversation whose workspace is used as the Git repository root. */
  sessionId: string;
  workspace: string;
  onCreateWorktree: (
    sessionId: string,
    plan: WorktreePlan,
  ) => Promise<WorktreeRecord | null>;
  /** Create the worktree and open its conversation in one guarded operation. */
  onCreateConversationWorktree: (
    plan: WorktreePlan,
  ) => Promise<WorktreeRecord | null>;
  /** Create a worktree, run the explicit setup command, then open it. */
  onCreateSetupConversationWorktree: (
    plan: WorktreePlan,
    command: string,
    envAllowlist: string[],
    onCreated?: (record: WorktreeRecord) => void,
  ) => Promise<WorktreeRecord | null>;
  worktrees: WorktreeRecord[];
  cleanupIntents: WorktreeCleanupIntent[];
  onRemoveWorktree: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<boolean>;
  /** Open a new conversation rooted at a created worktree. */
  onOpenWorktree: (record: WorktreeRecord) => Promise<string | null>;
  /** Explicitly dispatch one admitted writer into its worktree conversation. */
  onDispatchWriter?: (record: WorktreeRecord, prompt: string) => Promise<{ sessionId: string } | null>;
  /** Stop a dispatched writer without changing another conversation. */
  onStopWriter?: (sessionId: string) => Promise<void>;
  /** Open the writer conversation that owns a dispatch result. */
  onOpenWriterConversation?: (sessionId: string) => void;
  /** Latest host running projection, keyed by conversation id. */
  writerSessionRunning?: Readonly<Record<string, boolean>>;
  /** Local transcript projection for dispatched writer conversations. */
  writerLogs?: Readonly<Record<string, readonly LogEntry[]>>;
  /** Objective text captured from the parent sub-agent entry. */
  writerPrompts?: Readonly<Record<string, string>>;
  onInspectWorktree: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<WorktreeInspection | null>;
  onCheckReadiness: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<WorktreeReadiness | null>;
  onRunSetup: (
    sessionId: string,
    record: WorktreeRecord,
    command: string,
    envAllowlist: string[],
  ) => Promise<WorktreeSetupResult | null>;
  onCancelSetup: (sessionId: string, record: WorktreeRecord) => Promise<boolean>;
  sourceStatus: GitStatusSnapshot | null;
}

/**
 * US-7/US-8 orchestration panel: per-agent git worktree plan + manual
 * setup snippet + pre-flight HEAD-hash compare (report-only). Returns
 * null until at least one subagent entry exists in the active thread.
 */
export function OrchestrationPanel({
  agents,
  sessionId,
  workspace,
  onCreateWorktree,
  onCreateConversationWorktree,
  onCreateSetupConversationWorktree,
  worktrees,
  cleanupIntents,
  onRemoveWorktree,
  onOpenWorktree,
  onDispatchWriter,
  onStopWriter,
  onOpenWriterConversation,
  writerSessionRunning,
  writerLogs,
  writerPrompts,
  onInspectWorktree,
  onCheckReadiness,
  onRunSetup,
  onCancelSetup,
  sourceStatus,
}: Props) {
  const [baseline, setBaseline] = useState("");
  const [current, setCurrent] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [openingBranch, setOpeningBranch] = useState<string | null>(null);
  const [removingBranch, setRemovingBranch] = useState<string | null>(null);
  const [writerTargets, setWriterTargets] = useState<Record<string, string>>(() =>
    loadWriterTargets(workspace),
  );
  const [writerDispatches, setWriterDispatches] = useState<Record<string, WriterDispatchRecord>>({});
  const writerTargetsWorkspace = useRef(workspace);
  const [setupCommand, setSetupCommand] = useState("");
  const [envAllowlistText, setEnvAllowlistText] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupRunning, setSetupRunning] = useState<string | null>(null);
  const setupAndOpenRecordRef = useRef<WorktreeRecord | null>(null);
  const [setupProfiles, setSetupProfiles] = useState<SetupProfile[]>(() =>
    loadSetupProfiles(workspace),
  );
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [setupByBranch, setSetupByBranch] = useState<
    Record<string, WorktreeSetupResult>
  >({});
  const [handoffByBranch, setHandoffByBranch] = useState<
    Record<string, HandoffPlan>
  >({});
  const [inspectionByBranch, setInspectionByBranch] = useState<
    Record<string, WorktreeInspection>
  >({});
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [readinessByBranch, setReadinessByBranch] = useState<Record<string, WorktreeReadiness>>({});
  const [checkingReadiness, setCheckingReadiness] = useState<string | null>(null);
  const [retentionPolicy, setRetentionPolicy] = useState<WorktreeRetentionPolicy>(() =>
    loadWorktreeRetention(workspace),
  );
  const retentionWorkspace = useRef(workspace);

  useEffect(() => {
    // The declaration is workspace-scoped. On a workspace switch, hydrate
    // first and skip the write pass so the previous workspace cannot leak
    // into the new one.
    if (writerTargetsWorkspace.current !== workspace) {
      writerTargetsWorkspace.current = workspace;
      setWriterTargets(loadWriterTargets(workspace));
      return;
    }
    saveWriterTargets(workspace, writerTargets);
  }, [workspace, writerTargets]);

  useEffect(() => {
    setSetupProfiles(loadSetupProfiles(workspace));
    setSelectedProfileId("");
    setProfileName("");
    setEnvAllowlistText("");
    retentionWorkspace.current = workspace;
    setRetentionPolicy(loadWorktreeRetention(workspace));
  }, [workspace]);

  useEffect(() => {
    if (retentionWorkspace.current === workspace) saveWorktreeRetention(workspace, retentionPolicy);
  }, [retentionPolicy, workspace]);

  const plans = useMemo(() => planWorktrees(agents), [agents]);
  const snippet = useMemo(() => worktreeShellSnippet(plans), [plans]);
  const recordFor = (plan: WorktreePlan): WorktreeRecord | undefined =>
    worktrees.find(
      (record) =>
        record.repoRoot.toLowerCase() === workspace.toLowerCase() &&
        record.branch === plan.branch,
    );
  const createdRecords = plans
    .map((plan) => recordFor(plan))
    .filter((record): record is WorktreeRecord => record !== undefined);
  const inspectionSummary = summarizeWorktreeInspections(createdRecords, inspectionByBranch);
  const queueNote = fanoutQueueNote(plans.length);
  const writerQueue = useMemo(
    () =>
      planWriterQueue(
        plans.map((plan) => {
          const record = recordFor(plan);
          return {
            agent: plan.agent,
            worktreePath: record?.path ?? plan.path,
            hasWorktree: record !== undefined,
            targetPaths: parseWriterPaths(writerTargets[plan.agent] ?? "").paths,
          };
        }),
        fanoutLanes(),
      ),
    [plans, worktrees, workspace, writerTargets],
  );
  const activeWriterDispatches = Object.values(writerDispatches).filter((dispatch) =>
    writerDispatchIsActive(dispatch.status),
  ).length;

  useEffect(() => {
    if (writerSessionRunning === undefined) return;
    setWriterDispatches((current) => {
      let next = current;
      let changed = false;
      for (const [agent, dispatch] of Object.entries(current)) {
        const observedResult = dispatch.sessionId === null
          ? null
          : summarizeWriterLog(writerLogs?.[dispatch.sessionId] ?? []);
        if (
          dispatch.status === "running" &&
          dispatch.sessionId !== null &&
          writerSessionRunning[dispatch.sessionId] === false
        ) {
          if (!changed) next = { ...current };
          next[agent] = {
            ...dispatch,
            status: "complete",
            result: observedResult,
          };
          changed = true;
        } else if (
          dispatch.status === "complete" &&
          observedResult !== null &&
          dispatch.result?.entryCount !== observedResult.entryCount
        ) {
          if (!changed) next = { ...current };
          next[agent] = { ...dispatch, result: observedResult };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [writerLogs, writerSessionRunning]);

  async function dispatchWriter(row: WriterQueueRow): Promise<void> {
    if (onDispatchWriter === undefined) return;
    const plan = plans.find((item) => item.agent === row.agent);
    const record = plan === undefined ? undefined : recordFor(plan);
    if (
      record === undefined ||
      !writerDispatchCanStart(row.status, activeWriterDispatches, writerQueue.lanes)
    ) {
      return;
    }
    const prompt = buildWriterPrompt(
      row.agent,
      row.targetPaths,
      writerPrompts?.[row.agent],
    );
    setWriterDispatches((current) => ({
      ...current,
      [row.agent]: {
        agent: row.agent,
        sessionId: null,
        status: "starting",
        prompt,
        error: null,
        result: null,
      },
    }));
    try {
      const result = await onDispatchWriter(record, prompt);
      setWriterDispatches((current) => ({
        ...current,
        [row.agent]: result === null
          ? {
              agent: row.agent,
              sessionId: null,
              status: "failed",
              prompt,
              error: "The writer conversation could not be started.",
              result: null,
            }
          : {
              agent: row.agent,
              sessionId: result.sessionId,
              status: "running",
              prompt,
              error: null,
              result: null,
            },
      }));
    } catch (error) {
      setWriterDispatches((current) => ({
        ...current,
        [row.agent]: {
          agent: row.agent,
          sessionId: null,
          status: "failed",
          prompt,
          error: userFacingError(error, "The writer dispatch failed."),
          result: null,
        },
      }));
    }
  }

  async function stopWriter(agent: string): Promise<void> {
    const dispatch = writerDispatches[agent];
    if (
      dispatch === undefined ||
      dispatch.sessionId === null ||
      dispatch.status !== "running" ||
      onStopWriter === undefined
    ) {
      return;
    }
    const writerSessionId = dispatch.sessionId;
    setWriterDispatches((current) => ({
      ...current,
      [agent]: { ...dispatch, status: "stopping" },
    }));
    try {
      await onStopWriter(writerSessionId);
      setWriterDispatches((current) => {
        const latest = current[agent];
        return latest?.sessionId === writerSessionId
          ? {
              ...current,
              [agent]: {
                ...latest,
                status: "complete",
                result: summarizeWriterLog(writerLogs?.[writerSessionId] ?? []),
              },
            }
          : current;
      });
    } catch (error) {
      setWriterDispatches((current) => ({
        ...current,
        [agent]: {
          ...dispatch,
          status: "failed",
          error: userFacingError(error, "The writer could not be stopped."),
        },
      }));
    }
  }

  if (plans.length === 0) return null;

  function onCompare(): void {
    setReport(compareHeadHashes(baseline, current).report);
  }

  function onCopy(): void {
    try {
      void navigator.clipboard?.writeText(snippet).then(() => setCopied(true));
    } catch {
      setCopied(false);
    }
  }

  async function create(plan: WorktreePlan): Promise<void> {
    if (creating !== null || recordFor(plan) !== undefined) return;
    setCreating(plan.agent);
    await onCreateWorktree(sessionId, plan);
    setCreating(null);
  }

  async function createAndOpen(plan: WorktreePlan): Promise<void> {
    if (creating !== null || recordFor(plan) !== undefined) return;
    setCreating(plan.agent);
    await onCreateConversationWorktree(plan);
    setCreating(null);
  }

  async function createSetupAndOpen(plan: WorktreePlan): Promise<void> {
    if (creating !== null || recordFor(plan) !== undefined) return;
    const validation = validateSetupCommand(setupCommand);
    if (validation !== null) {
      setSetupError(validation);
      return;
    }
    const env = parseSetupEnvAllowlist(envAllowlistText);
    if (env.error !== null) {
      setSetupError(env.error);
      return;
    }
    setSetupError(null);
    setCreating(plan.agent);
    setSetupRunning(null);
    setupAndOpenRecordRef.current = null;
    await onCreateSetupConversationWorktree(
      plan,
      setupCommand.trim(),
      env.names,
      (record) => {
        setupAndOpenRecordRef.current = record;
        setSetupRunning(plan.branch);
      },
    );
    setupAndOpenRecordRef.current = null;
    setSetupRunning(null);
    setCreating(null);
  }

  async function cancelSetupAndOpen(): Promise<void> {
    const record = setupAndOpenRecordRef.current;
    if (record === null || setupRunning === null) return;
    setSetupError(null);
    await onCancelSetup(sessionId, record);
  }

  async function runSetup(record: WorktreeRecord): Promise<void> {
    const validation = validateSetupCommand(setupCommand);
    if (validation !== null) {
      setSetupError(validation);
      return;
    }
    const env = parseSetupEnvAllowlist(envAllowlistText);
    if (env.error !== null) {
      setSetupError(env.error);
      return;
    }
    setSetupError(null);
    setSetupRunning(record.branch);
    const result = await onRunSetup(sessionId, record, setupCommand, env.names);
    if (result !== null) {
      setSetupByBranch((current) => ({ ...current, [record.branch]: result }));
    }
    setSetupRunning(null);
  }

  async function cancelSetup(record: WorktreeRecord): Promise<void> {
    if (setupRunning !== record.branch) return;
    setSetupError(null);
    await onCancelSetup(sessionId, record);
  }

  function saveProfile(): void {
    const env = parseSetupEnvAllowlist(envAllowlistText);
    if (env.error !== null) {
      setSetupError(env.error);
      return;
    }
    const result = upsertSetupProfile(workspace, setupProfiles, {
      name: profileName,
      command: setupCommand,
      envAllowlist: env.names,
    });
    if (result.profile === null) {
      setSetupError("Profile name and setup command are required.");
      return;
    }
    setSetupProfiles(result.profiles);
    setSelectedProfileId(result.profile.id);
    setProfileName(result.profile.name);
    setEnvAllowlistText(result.profile.envAllowlist.join(", "));
    setSetupError(null);
  }

  function chooseProfile(id: string): void {
    setSelectedProfileId(id);
    const profile = setupProfiles.find((item) => item.id === id);
    if (profile === undefined) {
      setProfileName("");
      setEnvAllowlistText("");
      return;
    }
    setProfileName(profile.name);
    setSetupCommand(profile.command);
    setEnvAllowlistText(profile.envAllowlist.join(", "));
    setSetupError(null);
  }

  function deleteProfile(): void {
    if (selectedProfileId === "") return;
    setSetupProfiles((current) => removeSetupProfile(workspace, current, selectedProfileId));
    setSelectedProfileId("");
    setProfileName("");
    setEnvAllowlistText("");
  }

  function handoffInputFor(record: WorktreeRecord): HandoffInput {
    const sourceFiles = sourceStatus?.files ?? [];
    const inspection = inspectionByBranch[record.branch];
    return {
      direction: "local-to-worktree",
      sourceWorkspace: workspace,
      sourceBranch: sourceStatus?.branch ?? null,
      sourceChangedFiles: sourceFiles.length,
      sourceConflictedFiles: sourceFiles.filter((file) => file.conflicted).length,
      sourceStatusObserved: sourceStatus !== null,
      targetPath: record.path,
      targetBranch: record.branch,
      targetExists: true,
      targetDirty: inspection === undefined ? undefined : !inspection.clean,
      targetIgnoredFiles: inspection?.ignoredFileCount,
      targetBranchInUse: inspection?.branchReferencedElsewhere,
    };
  }

  function prepareHandoff(record: WorktreeRecord): void {
    const plan = buildHandoffPlan(handoffInputFor(record));
    setHandoffByBranch((current) => ({ ...current, [record.branch]: plan }));
  }

  async function inspect(record: WorktreeRecord): Promise<void> {
    if (inspecting !== null) return;
    setInspecting(record.branch);
    const result = await onInspectWorktree(sessionId, record);
    if (result !== null) {
      setInspectionByBranch((current) => ({ ...current, [record.branch]: result }));
    }
    setInspecting(null);
  }

  async function inspectAll(): Promise<void> {
    if (inspecting !== null || createdRecords.length === 0) return;
    setInspecting("__all__");
    const results = await Promise.all(
      createdRecords.map(async (record) => ({
        branch: record.branch,
        inspection: await onInspectWorktree(sessionId, record),
      })),
    );
    setInspectionByBranch((current) => {
      const next = { ...current };
      for (const result of results) {
        if (result.inspection !== null) next[result.branch] = result.inspection;
      }
      return next;
    });
    setInspecting(null);
  }

  async function openWorktree(record: WorktreeRecord): Promise<void> {
    if (openingBranch !== null) return;
    setOpeningBranch(record.branch);
    await onOpenWorktree(record);
    setOpeningBranch(null);
  }

  async function removeWorktree(record: WorktreeRecord): Promise<void> {
    if (removingBranch !== null) return;
    setRemovingBranch(record.branch);
    await onRemoveWorktree(sessionId, record);
    setRemovingBranch(null);
  }

  async function checkReadiness(record: WorktreeRecord): Promise<void> {
    if (checkingReadiness !== null) return;
    setCheckingReadiness(record.branch);
    const result = await onCheckReadiness(sessionId, record);
    if (result !== null) {
      setReadinessByBranch((current) => ({ ...current, [record.branch]: result }));
    }
    setCheckingReadiness(null);
  }

  return (
    <section className="orchestration" aria-label="Agent worktrees">
      <header className="orchestration-head">
        <strong>Worktrees ({plans.length})</strong>
        <CapabilityBadge
          status="manual"
          reason="The plan and setup commands are prepared locally; worktrees are created when you run the commands."
        />
        <button type="button" onClick={onCopy} title="Copy setup snippet">
          {copied ? "Copied" : "Copy"}
        </button>
        {createdRecords.length > 1 && (
          <button
            type="button"
            onClick={() => void inspectAll()}
            disabled={inspecting !== null}
            title="Inspect every created worktree before reviewing retention"
          >
            {inspecting === "__all__" ? "Inspecting…" : "Inspect all"}
          </button>
        )}
      </header>
      {createdRecords.length > 0 && (
        <p className="orchestration-inspection-summary" aria-live="polite">
          {inspectionSummary.inspected}/{inspectionSummary.total} inspected · {inspectionSummary.clean} clean · {inspectionSummary.changed} with changes
          {inspectionSummary.conflicted > 0 ? ` · ${inspectionSummary.conflicted} conflicted` : ""}
        </p>
      )}
      {queueNote !== null && <p className="muted">{queueNote}</p>}
      <details className="orchestration-writers" open>
        <summary>
          Writer coordination · {writerQueue.ready} ready · {writerQueue.queued} queued
          {writerQueue.blocked > 0 ? ` · ${writerQueue.blocked} blocked` : ""}
        </summary>
        <p className="muted">
          Declare the files each writer may change. Writers without a worktree or with overlapping paths stay blocked; extra writers queue FIFO after {writerQueue.lanes} lanes.
        </p>
        <ul>
          {writerQueue.rows.map((row) => {
            const parsed = parseWriterPaths(writerTargets[row.agent] ?? "");
            const plan = plans.find((item) => item.agent === row.agent);
            const record = plan === undefined ? undefined : recordFor(plan);
            const dispatch = writerDispatches[row.agent];
            const statusLabel: Record<WriterQueueStatus, string> = {
              blocked: "Create its worktree first",
              needsPaths: "Declare target files",
              conflict: `Blocked · overlaps ${row.conflictsWith.join(", ")}`,
              ready: `Ready · lane ${row.lane}`,
              queued: `Queued · position ${row.queuePosition}`,
            };
            return (
              <li key={row.agent} data-status={row.status}>
                <label>
                  <strong>{row.agent}</strong>
                  <input
                    value={writerTargets[row.agent] ?? ""}
                    onChange={(event) =>
                      setWriterTargets((current) => ({
                        ...current,
                        [row.agent]: event.target.value,
                      }))
                    }
                    placeholder="Files, e.g. src/App.tsx, src/lib/foo.ts"
                    aria-label={`Target files for ${row.agent}`}
                    spellCheck={false}
                  />
                </label>
                <span>
                  {statusLabel[row.status]}
                  {dispatch?.status === "starting" ? ` · Starting…` : ""}
                  {dispatch?.status === "running" ? ` · Running` : ""}
                  {dispatch?.status === "stopping" ? ` · Stopping…` : ""}
                  {dispatch?.status === "complete" ? ` · Complete` : ""}
                  {dispatch?.status === "failed" ? ` · Failed` : ""}
                </span>
                {dispatch?.result !== null && dispatch?.result !== undefined && (
                  <details className="orchestration-writer-result">
                    <summary>Observed writer result</summary>
                    <p>
                      {dispatch.result.entryCount} transcript entries · {dispatch.result.assistantMessages} assistant messages · {dispatch.result.toolEvents} tool events
                      {dispatch.result.failures > 0 ? ` · ${dispatch.result.failures} failure${dispatch.result.failures === 1 ? "" : "s"}` : ""}
                    </p>
                    {dispatch.result.lastAssistantOutput !== null && (
                      <blockquote>{dispatch.result.lastAssistantOutput}</blockquote>
                    )}
                    <small>Extracted from the local writer transcript; the host did not provide a structured result.</small>
                  </details>
                )}
                {parsed.invalid.length > 0 && (
                  <small>Ignored invalid paths: {parsed.invalid.join(", ")}</small>
                )}
                {onDispatchWriter !== undefined && record !== undefined &&
                  (row.status === "ready" || row.status === "queued") && (
                    <button
                      type="button"
                      disabled={!writerDispatchCanStart(row.status, activeWriterDispatches, writerQueue.lanes) || dispatch?.status === "starting" || dispatch?.status === "running" || dispatch?.status === "stopping"}
                      onClick={() => void dispatchWriter(row)}
                    >
                      {dispatch?.status === "complete" || dispatch?.status === "failed"
                        ? "Dispatch again"
                        : dispatch?.status === "starting"
                          ? `Starting…`
                          : "Dispatch writer"}
                    </button>
                  )}
                {dispatch?.sessionId !== null && dispatch?.sessionId !== undefined &&
                  onOpenWriterConversation !== undefined && (
                    <button
                      type="button"
                      onClick={() => onOpenWriterConversation(dispatch.sessionId as string)}
                    >
                      Open conversation
                    </button>
                  )}
                {dispatch?.sessionId !== null && dispatch?.sessionId !== undefined &&
                  dispatch.status === "running" && onStopWriter !== undefined && (
                    <button type="button" onClick={() => void stopWriter(row.agent)}>
                      Stop writer
                    </button>
                  )}
                {dispatch?.error !== null && dispatch?.error !== undefined && (
                  <small role="alert">{dispatch.error}</small>
                )}
              </li>
            );
          })}
        </ul>
      </details>
      <div className="orchestration-setup">
        <div className="orchestration-profiles">
          <label htmlFor="worktree-setup-profile">Profile</label>
          <select
            id="worktree-setup-profile"
            value={selectedProfileId}
            onChange={(event) => chooseProfile(event.target.value)}
            aria-label="Saved setup profile"
          >
            <option value="">No saved profile</option>
            {setupProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
          <input
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder="Profile name"
            aria-label="Setup profile name"
          />
          <button type="button" onClick={saveProfile} title="Save this setup command for the workspace">
            Save profile
          </button>
          <button
            type="button"
            onClick={deleteProfile}
            disabled={selectedProfileId === ""}
            title="Delete the selected setup profile"
          >
            Delete
          </button>
          <span className="muted">Profiles are workspace-scoped and never run automatically.</span>
        </div>
        <label htmlFor="worktree-setup-command">Setup command</label>
        <input
          id="worktree-setup-command"
          value={setupCommand}
          onChange={(event) => {
            setSetupCommand(event.target.value);
            setSetupError(null);
          }}
          maxLength={MAX_SETUP_COMMAND_CHARS}
          placeholder="e.g. npm install"
          spellCheck={false}
        />
        <span className="muted">
          Runs only after you click Run setup, inside the selected worktree.
        </span>
        <label htmlFor="worktree-setup-env">Extra environment names</label>
        <input
          id="worktree-setup-env"
          value={envAllowlistText}
          onChange={(event) => {
            setEnvAllowlistText(event.target.value);
            setSetupError(null);
          }}
          placeholder="e.g. NODE_ENV, RUSTUP_HOME"
          spellCheck={false}
          aria-describedby="worktree-setup-env-help"
        />
        <span className="muted" id="worktree-setup-env-help">
          Only these extra names are passed. Safe defaults always include {DEFAULT_SETUP_ENV_NAMES.slice(0, 4).join(", ")}.
        </span>
        <div className="orchestration-retention">
          <label htmlFor="worktree-retention-days">Retention</label>
          <select
            id="worktree-retention-days"
            aria-label="Worktree retention"
            value={retentionPolicy.maxAgeDays ?? ""}
            onChange={(event) => setRetentionPolicy({ maxAgeDays: normalizeRetentionDays(event.target.value) })}
          >
            <option value="">Keep until removed</option>
            <option value="7">Suggest cleanup after 7 days</option>
            <option value="14">Suggest cleanup after 14 days</option>
            <option value="30">Suggest cleanup after 30 days</option>
            <option value="90">Suggest cleanup after 90 days</option>
          </select>
          <span className="muted">Only clean, inspected worktrees become eligible; removal is always explicit.</span>
        </div>
        {setupError !== null && <span className="orchestration-setup-error">{setupError}</span>}
      </div>
      <ul className="orchestration-list">
        {plans.map((p) => (
          <li key={p.agent} title={`base ${p.base}`}>
            <div className="orchestration-plan">
              <code>{p.path}</code>
              <span className="muted">{p.branch}</span>
            </div>
            {recordFor(p) ? (
              <>
                <span
                  className="orchestration-created"
                  title={recordFor(p)?.path}
                >
                  Created
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (record) void inspect(record);
                  }}
                  disabled={inspecting !== null}
                  title="Inspect Git status before cleanup"
                >
                  {inspecting === recordFor(p)?.branch ? "Inspecting…" : "Inspect"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (record) void openWorktree(record);
                  }}
                  disabled={openingBranch !== null}
                  title="Open a new conversation in this worktree"
                >
                  {openingBranch === recordFor(p)?.branch ? "Opening…" : "Open conversation"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (record) void checkReadiness(record);
                  }}
                  disabled={checkingReadiness !== null}
                  title="Check project manifests and local tools without running setup"
                >
                  {checkingReadiness === recordFor(p)?.branch ? "Checking…" : "Check readiness"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (!record || !window.confirm(`Remove worktree ${record.path}?`)) return;
                    void removeWorktree(record);
                  }}
                  disabled={removingBranch !== null}
                  title={cleanupIntents.some((intent) => intent.path === recordFor(p)?.path)
                    ? "Retry the interrupted worktree cleanup"
                    : "Remove this worktree from Git"}
                >
                  {removingBranch === recordFor(p)?.branch
                    ? "Cleaning…"
                    : cleanupIntents.some((intent) => intent.path === recordFor(p)?.path)
                      ? "Retry cleanup"
                      : "Remove"}
                </button>
                {cleanupIntents
                  .filter((intent) => intent.path === recordFor(p)?.path)
                  .map((intent) => (
                    <span className="orchestration-cleanup-status" key={`${intent.repoRoot}:${intent.path}`}>
                      {intent.status === "pending" ? "Cleanup pending after restart" : `Cleanup failed · attempt ${intent.attempts}`}
                      {intent.error ? ` · ${userFacingError(intent.error)}` : ""}
                    </span>
                  ))}
                {setupRunning === recordFor(p)?.branch ? (
                  <button
                    type="button"
                    onClick={() => {
                      const record = recordFor(p);
                      if (record) void cancelSetup(record);
                    }}
                    title="Cancel the running setup command"
                  >
                    Cancel setup
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const record = recordFor(p);
                      if (record) void runSetup(record);
                    }}
                    disabled={setupRunning !== null || setupCommand.trim().length === 0}
                    title="Run the setup command in this worktree"
                  >
                    Run setup
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (record) prepareHandoff(record);
                  }}
                  title="Prepare a read-only handoff plan"
                >
                  Prepare handoff
                </button>
                {setupByBranch[p.branch] && (
                  <details className="orchestration-setup-output">
                    <summary>
                      Setup {setupByBranch[p.branch].status === "ready"
                        ? "ready"
                        : setupByBranch[p.branch].status === "timedOut"
                          ? "timed out"
                          : setupByBranch[p.branch].status === "cancelled"
                            ? "cancelled"
                            : "failed"} · {setupByBranch[p.branch].durationMs} ms
                      {setupByBranch[p.branch].exitCode === null
                        ? ""
                        : ` · exit ${setupByBranch[p.branch].exitCode}`}
                      {(setupByBranch[p.branch].environmentKeys?.length ?? 0) > 0
                        ? ` · env ${setupByBranch[p.branch].environmentKeys?.length ?? 0} keys`
                        : " · no inherited env"}
                    </summary>
                    <pre>{setupByBranch[p.branch].output || "(no output)"}</pre>
                  </details>
                )}
                {handoffByBranch[p.branch] && (() => {
                  const plan = handoffByBranch[p.branch];
                  const stale = isHandoffPlanStale(plan, handoffInputFor(recordFor(p)!));
                  return (
                  <details className="orchestration-handoff">
                    <summary>
                      Handoff plan · {stale ? "refresh required" : plan.ready ? "reviewable" : "blocked"}
                    </summary>
                    {stale && (
                      <p className="orchestration-handoff-stale" role="status">
                        Git or inspection inputs changed since this plan was prepared. Prepare the handoff again before relying on these checks.
                      </p>
                    )}
                    <ul>
                      {plan.checks.map((item) => (
                        <li key={item.id} data-status={item.status}>
                          <strong>{item.label}</strong>
                          <span>{item.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <ol>
                      {plan.steps.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                    <small className="muted">Prepared {new Date(plan.createdAt).toLocaleTimeString()}</small>
                  </details>
                  );
                })()}
                {inspectionByBranch[p.branch] && (
                  <details className="orchestration-inspection">
                    <summary>
                      {inspectionByBranch[p.branch].clean ? "Clean worktree" : "Changes detected"}
                      {inspectionByBranch[p.branch].branch
                        ? ` · ${inspectionByBranch[p.branch].branch}`
                        : ""}
                    </summary>
                    <p>
                      {inspectionByBranch[p.branch].fileCount} changed file(s)
                      {(inspectionByBranch[p.branch].ignoredFileCount ?? 0) > 0
                        ? ` · ${inspectionByBranch[p.branch].ignoredFileCount} ignored file(s)`
                        : ""}
                      {inspectionByBranch[p.branch].conflicted ? " · conflicts present" : ""}
                      {(inspectionByBranch[p.branch].activeSignals?.length ?? 0) > 0
                        ? ` · ${inspectionByBranch[p.branch].activeSignals?.join(", ")}`
                        : ""}
                      {inspectionByBranch[p.branch].branchReferencedElsewhere
                        ? " · branch checked out elsewhere"
                        : ""}
                      {` · observed ${new Date(inspectionByBranch[p.branch].observedAt).toLocaleTimeString()}`}
                    </p>
                  </details>
                )}
                {readinessByBranch[p.branch] && (
                  <details className="orchestration-readiness" open>
                    <summary>
                      Readiness · {readinessByBranch[p.branch].status === "ready"
                        ? "ready"
                        : readinessByBranch[p.branch].status === "blocked"
                          ? "missing tool"
                          : "needs setup"}
                    </summary>
                    <p>
                      {readinessByBranch[p.branch].projectFiles.length > 0
                        ? `Detected: ${readinessByBranch[p.branch].projectFiles.join(", ")}.`
                        : "No recognized project manifest was found."}
                    </p>
                    {readinessByBranch[p.branch].tools.length > 0 && (
                      <ul>
                        {readinessByBranch[p.branch].tools.map((tool) => (
                          <li key={tool.name} data-status={tool.available ? "available" : "missing"}>
                            <strong>{tool.name}</strong>
                            <span>{tool.available ? "available on PATH" : "missing from PATH"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
                {(() => {
                  const record = recordFor(p);
                  if (!record) return null;
                  const decision = retentionDecision(record, inspectionByBranch[p.branch], retentionPolicy);
                  return (
                    <span className="orchestration-retention-status" data-eligible={decision.eligible}>
                      {decision.reason}
                    </span>
                  );
                })()}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void (setupRunning === p.branch ? cancelSetupAndOpen() : createSetupAndOpen(p))}
                  disabled={setupRunning !== p.branch && (creating !== null || setupCommand.trim().length === 0)}
                  title={setupRunning === p.branch
                    ? "Cancel setup and remove the new worktree"
                    : "Create the worktree, run the explicit setup command, and open its conversation"}
                >
                  {setupRunning === p.branch ? "Cancel setup & open" : creating === p.agent ? "Setting up & opening…" : "Setup & open"}
                </button>
                <button
                  type="button"
                  onClick={() => void createAndOpen(p)}
                  disabled={creating !== null}
                  title="Create this Git worktree and open its conversation"
                >
                  {creating === p.agent ? "Creating & opening…" : "Create & open"}
                </button>
                <button
                  type="button"
                  onClick={() => void create(p)}
                  disabled={creating !== null}
                  title="Create this Git worktree"
                >
                  Create worktree
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <pre className="orchestration-snippet">{snippet}</pre>
      <div className="orchestration-compare">
        <input
          value={baseline}
          onChange={(e) => setBaseline(e.target.value)}
          placeholder="Baseline HEAD hash"
          aria-label="Baseline HEAD hash"
          spellCheck={false}
        />
        <input
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current HEAD hash"
          aria-label="Current HEAD hash"
          spellCheck={false}
        />
        <button type="button" onClick={onCompare} title="Pre-flight HEAD compare (report-only)">
          Check HEAD
        </button>
      </div>
      {report !== null && <p className="muted">{report}</p>}
    </section>
  );
}
