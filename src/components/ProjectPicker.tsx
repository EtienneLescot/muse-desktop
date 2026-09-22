import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { folderName, type ProjectWorkspaceOption } from "../lib/projects";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  /** Every project root, in project order. */
  options: ProjectWorkspaceOption[];
  /** Collision-safe labels, parallel to `options`. */
  labels: string[];
  /** Selected `optionId`, or `"default"` when no project is chosen. */
  value: string;
  onChange: (optionId: string) => void;
  /** Creates a project from a folder and returns its new option id. */
  onCreateFromFolder: (path: string) => Promise<string | null>;
}

/**
 * One entry for "where does this conversation run".
 *
 * The welcome screen used to show two controls side by side: a folder chip
 * ("Change folder · openscreen") and a project selector ("Project · openscreen").
 * Both answered the same question, both displayed the same word, and nothing
 * said which one won. The folder chip is gone.
 *
 * A project *is* its folder — that is the CLI's model, where `muse init` writes
 * rules into the directory and no project entity exists at all — so the single
 * entry is the project, and choosing a folder when no project matches is how a
 * project gets created. The name comes from the folder, as `muse init` does it.
 */
export function ProjectPicker({
  options,
  labels,
  value,
  onChange,
  onCreateFromFolder,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selectedIndex = options.findIndex((option) => option.optionId === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedLabel = selectedIndex >= 0 ? labels[selectedIndex] ?? selected?.projectName : null;

  async function createFromFolder(): Promise<void> {
    setError(null);
    if (!("__TAURI_INTERNALS__" in window)) {
      setError("Choosing a folder is available in the desktop app.");
      return;
    }
    setBusy(true);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string" || picked.trim().length === 0) return;
      const optionId = await onCreateFromFolder(picked.trim());
      if (optionId === null) {
        setError("This project could not be created.");
        return;
      }
      onChange(optionId);
      detailsRef.current?.removeAttribute("open");
    } catch (e) {
      setError(userFacingError(`folder picker failed: ${String(e)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-picker">
      <span className="project-picker-label" id="welcome-project-label">
        Project
      </span>
      <details className="project-picker-control" data-popover ref={detailsRef}>
        <summary className="project-trigger" aria-labelledby="welcome-project-label">
          <span className="project-trigger-name">
            {selectedLabel ?? "Choose a project"}
          </span>
          {/* The folder is shown only once a project is chosen: on its own it
              read as a second answer to the same question ("Choose a project ·
              openscreen"), which is the duplication this control replaced. */}
          {selected !== null && (
            <span className="project-trigger-folder">{folderName(selected.workspace)}</span>
          )}
          <span className="project-chevron" aria-hidden="true" />
        </summary>
        <div className="project-popover" role="listbox" aria-label="Projects">
          {options.length === 0 && (
            <p className="project-popover-empty">
              No project yet. Choose a folder: a project is a folder, and its name
              comes from it.
            </p>
          )}
          {options.map((option, index) => {
            const isSelected = option.optionId === value;
            return (
              <button
                key={option.optionId}
                type="button"
                role="option"
                aria-selected={isSelected}
                className="project-option"
                data-selected={isSelected}
                onClick={() => {
                  onChange(option.optionId);
                  detailsRef.current?.removeAttribute("open");
                }}
              >
                <span className="project-option-check" aria-hidden="true">
                  {isSelected ? "✓" : ""}
                </span>
                <span>
                  <strong>{labels[index] ?? option.projectName}</strong>
                  <small>{option.workspace}</small>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className="project-option-new"
            onClick={() => void createFromFolder()}
            disabled={busy}
          >
            {busy ? "Choosing…" : "New project from a folder…"}
          </button>
          {error !== null && (
            <p className="project-popover-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
