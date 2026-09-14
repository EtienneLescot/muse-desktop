import { useState } from "react";
import {
  getSkillDetail,
  type Skill,
  type SkillSuggestion,
} from "../lib/skills";

interface Props {
  skills: Skill[];
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
export function SkillPanel({ skills, onToggle, onInvoke, onTraceSuggest }: Props) {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);

  return (
    <section className="integration-panel" aria-label="Skills">
      <h3>Skills</h3>
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
