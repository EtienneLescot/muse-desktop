import { useRef, useState } from "react";
import { KNOWN_CONFIG_PATHS, type ResumableSession } from "../lib/importConfig";

interface Props {
  imported: ResumableSession[];
  notes: string[];
  onImportText: (source: string, content: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * US-34 import panel: lists the well-known CLI/IDE config paths, accepts
 * a pasted or picked config file, and surfaces resumable sessions.
 * Import-only: existing threads are never overwritten (merge by id).
 */
export function ImportPanel({ imported, notes, onImportText, onDismiss }: Props) {
  const [source, setSource] = useState<string>(KNOWN_CONFIG_PATHS[0]);
  const [pasted, setPasted] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((text) => onImportText(f.name, text));
  };

  return (
    <section className="collab-panel" aria-label="Import CLI/IDE config">
      <header className="collab-head">
        <strong>Import config</strong>
      </header>
      <label className="collab-mode">
        Known source{" "}
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Known config path">
          {KNOWN_CONFIG_PATHS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="collab-paste"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="Paste the contents of a config file here…"
        aria-label="Config file content"
        rows={3}
      />
      <div className="collab-actions">
        <button type="button" onClick={() => { onImportText(source, pasted); setPasted(""); }} disabled={pasted.trim().length === 0}>
          Import text
        </button>
        <button type="button" onClick={() => fileRef.current?.click()}>
          Choose a file…
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }}
        />
      </div>
      {notes.length > 0 && (
        <ul className="collab-list">
          {notes.map((n, i) => (
            // index key: notes are an append-only ephemeral feed
            <li key={i} className="muted">{n}</li>
          ))}
        </ul>
      )}
      {imported.length === 0 ? (
        <p className="muted">No imported conversations yet.</p>
      ) : (
        <ul className="collab-list">
          {imported.map((s) => (
            <li key={s.id} className="collab-row">
              <span title={s.id}>{s.title}</span>
              <span className="muted">{s.source}</span>
              <button type="button" onClick={() => onDismiss(s.id)} title="Remove from the resume list">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
