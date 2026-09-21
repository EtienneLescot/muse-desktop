import type { LiveModel } from "../lib/settings";

interface Props {
  /** The live host catalog, or null when it has not been read yet. */
  models: LiveModel[] | null;
  /** The model id currently in effect for this conversation, when known. */
  value: string | null;
  onSelect: (modelId: string) => void;
  /** Shown when neither the catalog nor the session names a model. */
  fallbackLabel?: string;
  compact?: boolean;
}

/**
 * Model picker for the composer, mirroring `ReasoningEffortControl`.
 *
 * It replaces a button that opened the whole Settings panel: choosing a model is
 * a per-conversation control that belongs next to the other composer controls,
 * not a detour through settings. The markup deliberately matches the reasoning
 * control — `<details>` + `<summary>` + a listbox popover — so the two controls
 * behave and read the same way, including keyboard dismissal via Escape, which
 * `<details>` provides natively.
 */
export function ModelControl({ models, value, onSelect, fallbackLabel = "Model", compact = false }: Props) {
  // The label falls back through what is actually known, most specific first:
  // the catalog's active row, the session's own id, the catalog's declared
  // default, and only then a bare "Model".
  //
  // The last step matters. Measured on this build: the renderer receives
  // `value: null` (the session carries no `modelId`) *and* the catalog marks no
  // row `isActive`, while it does mark `muse-spark-1.3-contributor` as
  // `isDefault`. Without this fallback the trigger read "Model" next to a picker
  // listing four real models — a label that tells the user nothing when the
  // effective model is in fact known.
  const activeRow = models?.find((model) => model.isActive);
  const selectedRow = models?.find((model) => model.modelId === value);
  const defaultRow = models?.find((model) => model.isDefault);
  const activeLabel =
    activeRow?.displayLabel ?? selectedRow?.displayLabel ?? value ?? defaultRow?.displayLabel ?? fallbackLabel;

  // Which row the picker marks as chosen. `isActive` is authoritative, then the
  // session value, then the declared default so the list never shows a choice
  // neither confirmed nor defaulted.
  const chosenId = activeRow?.modelId ?? selectedRow?.modelId ?? defaultRow?.modelId ?? null;

  // An unread or empty catalog cannot offer choices. The trigger stays visible
  // and says so rather than silently doing nothing when clicked.
  const hasChoices = models !== null && models.length > 0;

  return (
    <details className={`model-control${compact ? " model-control-compact" : ""}`} data-popover>
      <summary
        className="model-trigger"
        aria-label={`Model: ${activeLabel}`}
        title={
          hasChoices
            ? "Choose the model for this conversation"
            : "The host catalog is unavailable"
        }
        aria-disabled={hasChoices ? undefined : true}
      >
        <strong>{activeLabel}</strong>
        <span className="model-chevron" aria-hidden="true" />
      </summary>
      {hasChoices && (
        <div className="model-popover" role="listbox" aria-label="Model">
          {models.map((model) => {
            const selected = model.modelId === chosenId;
            return (
              <button
                key={model.modelId}
                type="button"
                role="option"
                aria-selected={selected}
                className="model-option"
                data-selected={selected}
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  onSelect(model.modelId);
                }}
              >
                <span className="model-option-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span>
                  <strong>{model.displayLabel}</strong>
                  <small>
                    {model.modelId}
                    {model.isDefault ? " · default" : ""}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </details>
  );
}
