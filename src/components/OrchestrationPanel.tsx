import { useMemo, useState } from "react";
import { fanoutQueueNote } from "../lib/fanout";
import {
  compareHeadHashes,
  planWorktrees,
  worktreeShellSnippet,
  type WorktreePlan,
  type WorktreeRecord,
} from "../lib/worktrees";
import { CapabilityBadge } from "./CapabilityBadge";

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
}: Props) {
  const [baseline, setBaseline] = useState("");
  const [current, setCurrent] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);

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
                    if (!record || !window.confirm(`Remove worktree ${record.path}?`)) return;
                    void onRemoveWorktree(sessionId, record);
                  }}
                  title="Remove this worktree from Git"
                >
                  Remove
                </button>
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
