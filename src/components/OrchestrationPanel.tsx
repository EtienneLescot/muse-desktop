import { useEffect, useMemo, useState } from "react";
import { fanoutQueueNote } from "../lib/fanout";
import { buildHandoffPlan, type HandoffPlan } from "../lib/handoff";
import type { GitStatusSnapshot } from "../lib/git";
import {
  compareHeadHashes,
  MAX_SETUP_COMMAND_CHARS,
  planWorktrees,
  validateSetupCommand,
  worktreeShellSnippet,
  type WorktreePlan,
  type WorktreeRecord,
  type WorktreeInspection,
  type WorktreeSetupResult,
} from "../lib/worktrees";
import { CapabilityBadge } from "./CapabilityBadge";
import {
  loadSetupProfiles,
  removeSetupProfile,
  upsertSetupProfile,
  type SetupProfile,
} from "../lib/setupProfiles";

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
  worktrees: WorktreeRecord[];
  onRemoveWorktree: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<boolean>;
  onInspectWorktree: (
    sessionId: string,
    record: WorktreeRecord,
  ) => Promise<WorktreeInspection | null>;
  onRunSetup: (
    sessionId: string,
    record: WorktreeRecord,
    command: string,
  ) => Promise<WorktreeSetupResult | null>;
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
  worktrees,
  onRemoveWorktree,
  onInspectWorktree,
  onRunSetup,
  sourceStatus,
}: Props) {
  const [baseline, setBaseline] = useState("");
  const [current, setCurrent] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [setupCommand, setSetupCommand] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupRunning, setSetupRunning] = useState<string | null>(null);
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

  useEffect(() => {
    setSetupProfiles(loadSetupProfiles(workspace));
    setSelectedProfileId("");
    setProfileName("");
  }, [workspace]);

  const plans = useMemo(() => planWorktrees(agents), [agents]);
  const snippet = useMemo(() => worktreeShellSnippet(plans), [plans]);
  const queueNote = fanoutQueueNote(plans.length);
  const recordFor = (plan: WorktreePlan): WorktreeRecord | undefined =>
    worktrees.find(
      (record) =>
        record.repoRoot.toLowerCase() === workspace.toLowerCase() &&
        record.branch === plan.branch,
    );

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

  async function runSetup(record: WorktreeRecord): Promise<void> {
    const validation = validateSetupCommand(setupCommand);
    if (validation !== null) {
      setSetupError(validation);
      return;
    }
    setSetupError(null);
    setSetupRunning(record.branch);
    const result = await onRunSetup(sessionId, record, setupCommand);
    if (result !== null) {
      setSetupByBranch((current) => ({ ...current, [record.branch]: result }));
    }
    setSetupRunning(null);
  }

  function saveProfile(): void {
    const result = upsertSetupProfile(workspace, setupProfiles, {
      name: profileName,
      command: setupCommand,
    });
    if (result.profile === null) {
      setSetupError("Profile name and setup command are required.");
      return;
    }
    setSetupProfiles(result.profiles);
    setSelectedProfileId(result.profile.id);
    setProfileName(result.profile.name);
    setSetupError(null);
  }

  function chooseProfile(id: string): void {
    setSelectedProfileId(id);
    const profile = setupProfiles.find((item) => item.id === id);
    if (profile === undefined) {
      setProfileName("");
      return;
    }
    setProfileName(profile.name);
    setSetupCommand(profile.command);
    setSetupError(null);
  }

  function deleteProfile(): void {
    if (selectedProfileId === "") return;
    setSetupProfiles((current) => removeSetupProfile(workspace, current, selectedProfileId));
    setSelectedProfileId("");
    setProfileName("");
  }

  function prepareHandoff(record: WorktreeRecord): void {
    const sourceFiles = sourceStatus?.files ?? [];
    const plan = buildHandoffPlan({
      direction: "local-to-worktree",
      sourceWorkspace: workspace,
      sourceBranch: sourceStatus?.branch ?? null,
      sourceChangedFiles: sourceFiles.length,
      sourceConflictedFiles: sourceFiles.filter((file) => file.conflicted).length,
      sourceStatusObserved: sourceStatus !== null,
      targetPath: record.path,
      targetBranch: record.branch,
      targetExists: true,
    });
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
      </header>
      {queueNote !== null && <p className="muted">{queueNote}</p>}
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
                    if (!record || !window.confirm(`Remove worktree ${record.path}?`)) return;
                    void onRemoveWorktree(sessionId, record);
                  }}
                  title="Remove this worktree from Git"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const record = recordFor(p);
                    if (record) void runSetup(record);
                  }}
                  disabled={setupRunning !== null || setupCommand.trim().length === 0}
                  title="Run the setup command in this worktree"
                >
                  {setupRunning === recordFor(p)?.branch ? "Running…" : "Run setup"}
                </button>
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
                          : "failed"} · {setupByBranch[p.branch].durationMs} ms
                      {setupByBranch[p.branch].exitCode === null
                        ? ""
                        : ` · exit ${setupByBranch[p.branch].exitCode}`}
                    </summary>
                    <pre>{setupByBranch[p.branch].output || "(no output)"}</pre>
                  </details>
                )}
                {handoffByBranch[p.branch] && (
                  <details className="orchestration-handoff">
                    <summary>
                      Handoff plan · {handoffByBranch[p.branch].ready ? "reviewable" : "blocked"}
                    </summary>
                    <ul>
                      {handoffByBranch[p.branch].checks.map((item) => (
                        <li key={item.id} data-status={item.status}>
                          <strong>{item.label}</strong>
                          <span>{item.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <ol>
                      {handoffByBranch[p.branch].steps.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  </details>
                )}
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
                      {inspectionByBranch[p.branch].conflicted ? " · conflicts present" : ""} · observed {new Date(inspectionByBranch[p.branch].observedAt).toLocaleTimeString()}
                    </p>
                  </details>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => void create(p)}
                disabled={creating !== null}
                title="Create this Git worktree"
              >
                {creating === p.agent ? "Creating…" : "Create worktree"}
              </button>
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
