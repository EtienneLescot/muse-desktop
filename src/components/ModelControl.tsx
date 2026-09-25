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
  // the conversation's own id (its truth, see below), the catalog's active row,
  // the catalog's declared default, and only then a bare "Model".
  //
  // The last step matters. Measured on this build: the renderer receives
  // `value: null` (the session carries no `modelId`) *and* the catalog marks no
  // row `isActive`, while it does mark `muse-spark-1.3-contributor` as
  // `isDefault`. Without this fallback the trigger read "Model" next to a picker
  // listing four real models — a label that tells the user nothing when the
  // effective model is in fact known.
  //
  // The first step matters just as much. `models` is one shared catalog, and
  // its `isActive` row belongs to whichever conversation was refreshed last —
  // reading it first made the trigger announce the model of the *previous*
  // conversation on a switch (M1-11). The session's own `value` is updated by
  // every successful `set_model` and by `resume_session` hydration, so it is
  // the per-conversation truth and wins; `isActive` only breaks ties for a
  // conversation that never named a model (the host default).
  const selectedRow = models?.find((model) => model.modelId === value);
  const activeRow = models?.find((model) => model.isActive);
  const defaultRow = models?.find((model) => model.isDefault);
  const activeLabel =
    selectedRow?.displayLabel ?? value ?? activeRow?.displayLabel ?? defaultRow?.displayLabel ?? fallbackLabel;

  // Which row the picker marks as chosen. The conversation value is
  // authoritative, then the catalog's active row, then the declared default so
  // the list never shows a choice neither confirmed nor defaulted.
  const chosenId = selectedRow?.modelId ?? activeRow?.modelId ?? defaultRow?.modelId ?? null;

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
                  {/* The id is shown only when it says more than the label. */}
                  {(model.modelId !== model.displayLabel || model.isDefault) && (
                    <small>
                      {[model.modelId !== model.displayLabel ? model.modelId : null, model.isDefault ? "default" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </details>
  );
}
