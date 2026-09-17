import { useState } from "react";
import {
  getSkillDetail,
  skillInvocationStageLabel,
  type Skill,
  type SkillInvocationProgress,
  type SkillSuggestion,
} from "../lib/skills";
import type { SkillScanSummary } from "../lib/skillDiscovery";
import type { HostSkill } from "../lib/hostSkills";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  skills: Skill[];
  hostSkills: HostSkill[];
  skillProgress?: SkillInvocationProgress;
  workspace: string | null;
  onRefreshHost: () => Promise<HostSkill[] | null>;
  onScan: () => Promise<SkillScanSummary | null>;
  onToggle: (name: string, enabled: boolean) => void;
  /** Invoke `/name` with no args (slash in the composer passes args). */
  onInvoke: (name: string) => void;
  /**
   * Compute suggestions for a draft AND trace them into the active
   * session log; returns the list for inline display.
   */
  onTraceSuggest: (text: string) => SkillSuggestion[];
}

/**
 * US-25 skills panel: slash-invokable skills, auto-suggest traced to the
 * log, progressive disclosure (view-only shows description only).
 */
export function SkillPanel({ skills, hostSkills, skillProgress, workspace, onRefreshHost, onScan, onToggle, onInvoke, onTraceSuggest }: Props) {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [scan, setScan] = useState<SkillScanSummary | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);

  return (
    <section className="integration-panel" aria-label="Skills">
      <div className="integration-panel-head">
        <span>
          <h3>Skills</h3>
          <small className="muted">{workspace ? "Workspace discovery" : "Select a workspace to discover skills"}</small>
        </span>
        <button
          type="button"
          className="integration-action"
          disabled={!workspace || scanBusy}
          onClick={() => {
            setScanBusy(true);
            setScanError(null);
            void onScan()
              .then(setScan)
              .catch((error) => setScanError(userFacingError(`skills scan failed: ${String(error)}`)))
              .finally(() => setScanBusy(false));
          }}
        >
          {scanBusy ? "Scanning…" : "Scan workspace"}
        </button>
      </div>
      {skillProgress && (
        <div
          className={`skill-invocation-progress is-${skillProgress.stage}`}
          role="status"
          aria-live="polite"
        >
          <span className="skill-progress-dot" aria-hidden="true" />
          <span className="skill-progress-copy">
            <strong>/{skillProgress.name}</strong>
            <span>{skillInvocationStageLabel(skillProgress.stage)}</span>
            {skillProgress.detail && <small>{skillProgress.detail}</small>}
          </span>
        </div>
      )}
      {scan !== null && (
        <div className="skill-scan-result" role="status">
          <small>{scan.skills.length} discovered · {scan.root}</small>
          {scan.errors.length > 0 && (
            <ul className="skill-scan-errors">
              {scan.errors.map((error) => <li key={`${error.path}:${error.message}`}>{error.path}: {error.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {scanError !== null && <p className="error" role="alert">{scanError}</p>}
      <div className="integration-panel-head" style={{ marginTop: "1rem" }}>
        <span>
          <h4>Host skills</h4>
          <small className="muted">Provided by the connected Muse runtime</small>
        </span>
        <button
          type="button"
          className="integration-action"
          disabled={hostBusy}
          onClick={() => {
            setHostBusy(true);
            void onRefreshHost().finally(() => setHostBusy(false));
          }}
        >
          {hostBusy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {hostSkills.length > 0 ? (
        <ul className="integration-list">
          {hostSkills.map((skill) => (
            <li key={skill.selector} className="integration-row">
              <span className="integration-main">
                <strong>/{skill.selector}</strong>
                <small>{skill.description || skill.displayName}</small>
                {skill.argumentHint && <small className="muted">{skill.argumentHint}</small>}
              </span>
              <button type="button" onClick={() => onInvoke(skill.selector)}>Run</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No host skills reported for this conversation.</p>
      )}
      <ul className="integration-list">
        {skills.map((s) => {
          const view = getSkillDetail(s, false);
          return (
            <li key={s.name} className="integration-row">
              <span className="integration-main">
                <strong>
                  /{s.name}
                  <small> ({s.source})</small>
                </strong>
                <small>{view.description}</small>
                {s.path && <small className="muted skill-path" title={s.path}>{s.path}</small>}
                {s.viewOnly && <small className="muted">view-only</small>}
              </span>
              <label className="integration-toggle" title={s.enabled ? "Disable" : "Enable"}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(ev) => onToggle(s.name, ev.target.checked)}
                />
              </label>
              <button type="button" onClick={() => onInvoke(s.name)} disabled={!s.enabled}>
                Run
              </button>
            </li>
          );
        })}
      </ul>
      <h4>Suggestions (recorded in activity)</h4>
      <form
        className="integration-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          setSuggestions(onTraceSuggest(draft));
        }}
      >
        <input
          type="text"
          placeholder="Draft to check…"
          aria-label="Draft to check for suggestions"
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
        />
        <button type="submit">Suggest</button>
      </form>
      {suggestions.length > 0 && (
        <ul className="integration-list">
          {suggestions.map((s) => (
            <li key={s.skillName} className="integration-row">
              <span className="integration-main">
                <strong>/{s.skillName}</strong>
                <small className="muted">{s.reason}</small>
              </span>
              <button type="button" onClick={() => onInvoke(s.skillName)}>
                Run
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
