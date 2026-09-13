import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildEnrichedText,
  findMentionAt,
  interpretScopeVerdict,
  outOfScopeMessage,
  resolveMention,
  resolveMentions,
  type MentionToken,
  type ResolvedMention,
} from "../lib/mentions";

interface Props {
  disabled: boolean;
  running: boolean;
  /** Absolute workspace root; null while none is picked. */
  workspace: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
}

interface RecentMention {
  relPath: string;
  absPath: string;
}

const RECENT_KEY = "muse-desktop.mentions.v1";
const RECENT_CAP = 20;

function loadRecents(workspace: string): RecentMention[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const list = obj[workspace];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (r): r is RecentMention =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RecentMention).relPath === "string" &&
          typeof (r as RecentMention).absPath === "string",
      )
      .slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function saveRecents(workspace: string, recents: RecentMention[]): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const obj =
      raw !== null ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj[workspace] = recents.slice(0, RECENT_CAP);
    localStorage.setItem(RECENT_KEY, JSON.stringify(obj));
  } catch {
    // best-effort (private mode, quota): completion still works in-memory
  }
}

/** True when an invoke failure means "no such Tauri command". */
function isMissingCommand(err: unknown): boolean {
  const msg = String(err);
  return /not found|no such|unknown command|no command|unrecognized/i.test(msg);
}

/**
 * Prompt composer: Enter sends, Shift+Enter inserts a newline.
 *
 * `@`-mentions (US-18): typing `@query` opens a workspace-scoped completion;
 * every resolved mention shows as a chip above the input. In-scope mentions
 * are sent enriched (replaced by their absolute path); a mention escaping
 * the workspace asks the backend `check_scope` permission when that command
 * exists (US-22), otherwise the send is blocked with an explicit message.
 */
export function Composer({ disabled, running, workspace, onSend, onCancel }: Props) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [selIndex, setSelIndex] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentMention[]>(() =>
    workspace !== null ? loadRecents(workspace) : [],
  );
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setRecents(workspace !== null ? loadRecents(workspace) : []);
    setBlocked(null);
  }, [workspace]);

  const mentions: ResolvedMention[] = useMemo(
    () => (workspace !== null ? resolveMentions(workspace, text) : []),
    [workspace, text],
  );

  const active: MentionToken | null = useMemo(
    () => findMentionAt(text, caret),
    [text, caret],
  );

  const candidates: ResolvedMention[] = useMemo(() => {
    if (workspace === null || active === null) return [];
    const q = active.query.toLowerCase();
    const seen = new Set<string>();
    const out: ResolvedMention[] = [];
    for (const r of recents) {
      if (q !== "" && !r.relPath.toLowerCase().includes(q)) continue;
      const m = { ...resolveMention(workspace, r.relPath), start: active.start, end: active.end };
      if (seen.has(m.absPath)) continue;
      seen.add(m.absPath);
      out.push(m);
    }
    if (active.query !== "") {
      const literal = { ...resolveMention(workspace, active.query), start: active.start, end: active.end };
      if (!seen.has(literal.absPath)) out.push(literal);
    }
    return out.slice(0, 8);
  }, [workspace, active, recents]);

  useEffect(() => {
    setSelIndex(0);
    setDismissedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const activeKey = active !== null ? `${active.start}-${active.end}-${active.query}` : null;
  const dropdownOpen =
    active !== null && candidates.length > 0 && !disabled && dismissedKey !== activeKey;

  function syncCaret(el: HTMLTextAreaElement): void {
    setCaret(el.selectionStart ?? el.value.length);
  }

  function applyCandidate(m: ResolvedMention): void {
    if (active === null) return;
    const insert = `@${m.inScope ? m.relPath : m.absPath} `;
    const next = text.slice(0, active.start) + insert + text.slice(active.end);
    const nextCaret = active.start + insert.length;
    setText(next);
    setCaret(nextCaret);
    setBlocked(null);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  function removeMention(m: ResolvedMention): void {
    const after = text.slice(m.end, m.end + 1) === " " ? m.end + 1 : m.end;
    const next = text.slice(0, m.start) + text.slice(after);
    setText(next);
    setCaret(m.start);
    setBlocked(null);
  }

  async function send(): Promise<void> {
    if (text.trim().length === 0 || disabled || checking) return;
    if (workspace === null || mentions.length === 0) {
      setBlocked(null);
      onSend(text);
      setText("");
      setCaret(0);
      return;
    }
    const outScoped = mentions.filter((m) => !m.inScope);
    if (outScoped.length > 0) {
      // Permission path: prefer the backend check_scope verdict (US-22);
      // without that command, fall back to blocking the send explicitly.
      setChecking(true);
      try {
        for (const m of outScoped) {
          const granted = await invoke<unknown>("check_scope", {
            path: m.absPath,
          });
          if (!interpretScopeVerdict(granted)) {
            setBlocked(
              `Workspace permission denied for ${m.absPath}: the send was blocked.`,
            );
            return;
          }
        }
      } catch (e) {
        setBlocked(
          isMissingCommand(e)
            ? outOfScopeMessage(mentions)
            : `Scope check failed (${String(e)}): the send was blocked.`,
        );
        return;
      } finally {
        setChecking(false);
      }
    }
    const { text: enriched } = buildEnrichedText(workspace, text);
    const fresh: RecentMention[] = [];
    for (const m of mentions) {
      if (!m.inScope) continue;
      if (fresh.some((r) => r.absPath === m.absPath)) continue;
      fresh.push({ relPath: m.relPath, absPath: m.absPath });
    }
    if (fresh.length > 0) {
      setRecents((cur) => {
        const next = [...fresh, ...cur.filter((r) => !fresh.some((f) => f.absPath === r.absPath))].slice(
          0,
          RECENT_CAP,
        );
        saveRecents(workspace, next);
        return next;
      });
    }
    setBlocked(null);
    onSend(enriched);
    setText("");
    setCaret(0);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (dropdownOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSelIndex((i) => (i + d + candidates.length) % candidates.length);
      return;
    }
    if (dropdownOpen && (e.key === "Enter" || e.key === "Tab")) {
      const c = candidates[selIndex] ?? candidates[0];
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        applyCandidate(c);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyCandidate(c);
        return;
      }
    }
    if (e.key === "Escape" && active !== null) {
      e.preventDefault();
      setDismissedKey(activeKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="composer">
      <div className="composer-main">
        {mentions.length > 0 && (
          <ul className="mention-chips" aria-label="Resolved mentions">
            {mentions.map((m, i) => (
              <li
                key={`${m.start}-${m.end}-${i}`}
                className={m.inScope ? "mention-chip" : "mention-chip mention-chip-out"}
                title={m.absPath}
              >
                <span className="mention-chip-path">{m.inScope ? m.relPath : m.absPath}</span>
                {!m.inScope && <span className="mention-chip-flag">hors-scope</span>}
                <button
                  type="button"
                  className="mention-chip-remove"
                  aria-label={`Remove mention ${m.query}`}
                  onClick={() => removeMention(m)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {dropdownOpen && (
          <ul className="mention-list" role="listbox" aria-label="Mention completions">
            {candidates.map((c, i) => (
              <li
                key={c.absPath}
                role="option"
                aria-selected={i === selIndex}
                className={i === selIndex ? "mention-item mention-item-active" : "mention-item"}
                onMouseDown={(e) => {
                  // Select before the textarea loses focus/caret.
                  e.preventDefault();
                  applyCandidate(c);
                }}
              >
                <span className="mention-item-path">{c.inScope ? c.relPath : c.absPath}</span>
                {c.inScope ? (
                  <span className="mention-item-scope">workspace</span>
                ) : (
                  <span className="mention-item-scope mention-item-scope-out">hors-scope</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
          onSelect={(e) => syncCaret(e.currentTarget)}
          disabled={disabled}
          rows={3}
          placeholder={
            disabled
              ? "Pick a workspace and start a session first."
              : "Type a prompt… (Enter to send, @ for files)"
          }
          aria-label="Prompt input"
          aria-expanded={dropdownOpen}
          aria-autocomplete="list"
        />
        {blocked !== null && (
          <div className="mention-error" role="alert">
            {blocked}
          </div>
        )}
      </div>
      <div className="composer-actions">
        {running && (
          <button onClick={onCancel} title="Stop the running sidecar">
            Stop
          </button>
        )}
        <button onClick={() => void send()} disabled={disabled || text.trim().length === 0 || checking}>
          {checking ? "Checking…" : "Send"}
        </button>
      </div>
    </div>
  );
}
