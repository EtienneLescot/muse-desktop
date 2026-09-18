import {
  REASONING_EFFORTS,
  reasoningEffortDescription,
  reasoningEffortLabel,
  type ReasoningEffort,
} from "../lib/reasoning";

interface Props {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  compact?: boolean;
}

/** Shared reasoning selector for the welcome and active conversation composers. */
export function ReasoningEffortControl({ value, onChange, compact = false }: Props) {
  return (
    <details className={`reasoning-effort-control${compact ? " reasoning-effort-control-compact" : ""}`}>
      <summary
        className="reasoning-effort-trigger"
        aria-label={`Reasoning effort: ${reasoningEffortLabel(value)}`}
        title={reasoningEffortDescription(value)}
      >
        <span className="reasoning-effort-glyph" aria-hidden="true">✦</span>
        <span className="reasoning-effort-prefix">Effort</span>
        <strong>{reasoningEffortLabel(value)}</strong>
        <span className="reasoning-effort-chevron" aria-hidden="true" />
      </summary>
      <div className="reasoning-effort-popover" role="listbox" aria-label="Reasoning effort">
        {REASONING_EFFORTS.map((candidate) => {
          const selected = candidate === value;
          return (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={selected}
              className="reasoning-effort-option"
              data-selected={selected}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onChange(candidate);
              }}
            >
              <span className="reasoning-effort-option-check" aria-hidden="true">
                {selected ? "✓" : ""}
              </span>
              <span>
                <strong>{reasoningEffortLabel(candidate)}</strong>
                <small>{reasoningEffortDescription(candidate)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
