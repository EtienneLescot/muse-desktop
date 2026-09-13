import { useState } from "react";
import {
  ageLabel,
  isStale,
  memoryChipLabel,
  memoryMentionQuery,
  type MemoryEntry,
} from "../lib/memory";

interface Props {
  memories: MemoryEntry[];
  /** Epoch ms clock (Date.now() from the caller; prop keeps this dumb). */
  now: number;
  scanNudge: string | null;
  onAdd: (text: string, source: string) => void;
  onRemove: (id: string) => void;
  onAckScan: () => void;
  /** Insert `@mem/<id>` into the composer (mention chip path). */
  onMention: (query: string) => void;
}

const SOURCES = ["user", "slack", "notion", "docs", "codebase"];

/**
 * US-20 memory panel: dated/sourced entries with age badges, stale
 * warnings (never a silent override), add/remove, and the periodic SCAN
 * review nudge (lightweight, dismissible — never an auto-rewrite).
 */
export function MemoryPanel({
  memories,
  now,
  scanNudge,
  onAdd,
  onRemove,
  onAckScan,
  onMention,
}: Props) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("user");
  const [open, setOpen] = useState(false);

  function submit(): void {
    if (text.trim().length === 0) return;
    onAdd(text, source);
    setText("");
  }

  return (
    <section className="memory-panel" aria-label="Memory">
      <button
        type="button"
        className="memory-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Mémoire</span>
        <span className="memory-count" aria-label={`${memories.length} entries`}>
          {memories.length}
        </span>
        {scanNudge !== null && (
          <span className="memory-scan-dot" title="SCAN review due">
            SCAN
          </span>
        )}
      </button>
      {open && (
        <div className="memory-body">
          {scanNudge !== null && (
            <div className="memory-nudge" role="status">
              <span>{scanNudge}</span>
              <button type="button" onClick={onAckScan} title="Mark reviewed">
                Revoir
              </button>
            </div>
          )}
          {memories.length === 0 ? (
            <p className="muted">Aucune entrée — la mémoire se remplit ici.</p>
          ) : (
            <ul className="memory-list">
              {memories.map((m) => {
                const stale = isStale(m, now);
                return (
                  <li
                    key={m.id}
                    className={stale ? "memory-item memory-item-stale" : "memory-item"}
                    title={`${m.text} — ${m.source}`}
                  >
                    <button
                      type="button"
                      className="memory-chip-link"
                      title={`Mention as @${memoryMentionQuery(m)}`}
                      onClick={() => onMention(memoryMentionQuery(m))}
                    >
                      @{memoryMentionQuery(m)}
                    </button>
                    <span className="memory-item-text">{memoryChipLabel(m)}</span>
                    <span className="memory-item-source">{m.source}</span>
                    <span
                      className={
                        stale ? "memory-age memory-age-stale" : "memory-age"
                      }
                      title={stale ? "Stale: verify before use" : "Entry age"}
                    >
                      {ageLabel(m, now)}
                    </span>
                    <button
                      type="button"
                      className="memory-remove"
                      aria-label={`Forget memory ${memoryChipLabel(m)}`}
                      onClick={() => onRemove(m.id)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="memory-add">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Remember this… (Enter to save)"
              aria-label="New memory text"
              maxLength={1000}
            />
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              aria-label="Memory source"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={submit}
              disabled={text.trim().length === 0}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
