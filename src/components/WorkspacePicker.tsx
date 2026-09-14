import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  workspace: string | null;
  onPick: (path: string) => void;
}

/**
 * Folder picker for the *default* workspace of new threads (Codex-like:
 * there is no global lock — each thread records its own folder at
 * creation, shown in its topbar; this default only pre-fills creation).
 */
export function WorkspacePicker({ workspace, onPick }: Props) {
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    try {
      setError(null);
      if (!("__TAURI_INTERNALS__" in window)) {
        setError(
          "Le sélecteur de dossier est disponible dans l’application desktop.",
        );
        return;
      }
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string" && dir.length > 0) onPick(dir);
    } catch (e) {
      setError(`folder picker failed: ${String(e)}`);
    }
  }

  return (
    <div className="workspace-picker">
      <button className="workspace-button" onClick={pick}>
        Choisir un dossier
      </button>
      <span className="workspace-path" title={workspace ?? ""}>
        {workspace ?? "Aucun dossier sélectionné"}
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
