import { useMemo, useState } from "react";
import { fanoutQueueNote } from "../lib/fanout";
import {
  compareHeadHashes,
  planWorktrees,
  worktreeShellSnippet,
} from "../lib/worktrees";

interface Props {
  /** Agent ids seen as `subagent` entries in the active thread log. */
  agents: string[];
}

/**
 * US-7/US-8 orchestration panel: per-agent git worktree plan + manual
 * setup snippet + pre-flight HEAD-hash compare (report-only). Returns
 * null until at least one subagent entry exists in the active thread.
 */
export function OrchestrationPanel({ agents }: Props) {
  const [baseline, setBaseline] = useState("");
  const [current, setCurrent] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const plans = useMemo(() => planWorktrees(agents), [agents]);
  const snippet = useMemo(() => worktreeShellSnippet(plans), [plans]);
  const queueNote = fanoutQueueNote(plans.length);

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

  return (
    <section className="orchestration" aria-label="Agent worktrees">
      <header className="orchestration-head">
        <strong>Worktrees ({plans.length})</strong>
        <button type="button" onClick={onCopy} title="Copy setup snippet">
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      {queueNote !== null && <p className="muted">{queueNote}</p>}
      <ul className="orchestration-list">
        {plans.map((p) => (
          <li key={p.agent} title={`base ${p.base}`}>
            <code>{p.path}</code>
            <span className="muted">{p.branch}</span>
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
