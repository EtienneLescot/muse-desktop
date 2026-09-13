import { useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  workspace: string | null;
  onPick: (path: string) => void;
  /** Lets the sidebar profile button forward a click to the picker. */
  pickButtonRef?: RefObject<HTMLButtonElement>;
}

/** Workspace folder picker: locks the sidecar cwd + persistence root. */
export function WorkspacePicker({ workspace, onPick, pickButtonRef }: Props) {
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    try {
      setError(null);
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === "string" && dir.length > 0) onPick(dir);
    } catch (e) {
      setError(`folder picker failed: ${String(e)}`);
    }
  }

  return (
    <div className="workspace-picker">
      <button ref={pickButtonRef} className="primary" onClick={pick}>
        Choose workspace folder
      </button>
      <span className="workspace-path" title={workspace ?? ""}>
        {workspace ?? "no workspace selected"}
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
