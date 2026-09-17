import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
// US-20 memory @-mention chips: `@mem/<id>` tokens expand to quoted,
// source+age flagged context (stale flagged, never silent).
import {
  ageLabel,
  expandMemoryMentions,
  findMemoryByPrefix,
  isStale,
  memoryChipLabel,
  parseMemoryMentions,
  type MemoryEntry,
  type MemoryMentionToken,
} from "../lib/memory";
// US-32: composer shortcuts documented in the UI via title attributes.
import { COMPOSER_SHORTCUT_TITLES } from "../lib/a11y";
// M0-03: sends return an explicit result — the draft is cleared only on
// the supervisor's admission ack, never on a failed or ambiguous send.
import type { SendResult } from "../lib/outbox";
import type { AuthorizationMode } from "../lib/authorization";
import { AuthorizationModeControl } from "./AuthorizationModeControl";
import {
  attachmentKey,
  buildTurnInputParts,
  MAX_ATTACHMENTS,
  readAttachment,
  type ComposerAttachment,
  type TurnInputPart,
} from "../lib/attachments";

interface Props {
  sessionId?: string;
  draftKey: string;
  modelControl?: ReactNode;
  disabled: boolean;
  running: boolean;
  /** Absolute workspace root; null while none is picked. */
  workspace: string | null;
  /**
   * M0-03: resolves with an explicit send result. ok=true lets the
   * composer clear the draft; ok=false keeps it (retryable outbox entry).
   */
  onSend: (text: string, inputParts?: TurnInputPart[]) => Promise<SendResult>;
  onSteer?: (text: string, inputParts?: TurnInputPart[]) => Promise<SendResult>;
  onCancel: () => void;
  /** US-4: summary text to load into the box after « New From Summary ». */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  /** US-20: memory entries offered as `@mem/<id>` context chips. */
  memories?: MemoryEntry[];
  /** US-20: one `@mem/…` query to insert (from the memory panel). */
  memoryInsert?: string | null;
  onMemoryInsertConsumed?: () => void;
  /** Global tool-authorization posture shown beside the send controls. */
  authorizationMode: AuthorizationMode;
  onAuthorizationModeChange: (mode: AuthorizationMode) => void;
}

interface RecentMention {
  relPath: string;
  absPath: string;
}

const RECENT_KEY = "muse-desktop.mentions.v1";
const RECENT_CAP = 20;

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
export function Composer({
  sessionId,
  draftKey,
  modelControl,
  disabled,
  running,
  workspace,
  onSend,
  onSteer,
  onCancel,
  prefill,
  onPrefillConsumed,
  memories,
  memoryInsert,
  onMemoryInsertConsumed,
  authorizationMode,
  onAuthorizationModeChange,
}: Props) {
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(`muse-desktop.draft.${draftKey}`) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`muse-desktop.draft.${draftKey}`, text);
    } catch {
      /* Draft stays in memory. */
    }
  }, [draftKey, text]);
  const [caret, setCaret] = useState(0);
  const [selIndex, setSelIndex] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // M0-03: one send in flight per composer — double Enter/click waits
  // instead of firing a second identical turn.
  const [sending, setSending] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentMention[]>(() =>
    workspace !== null ? loadRecents(workspace) : [],
  );
  // Keep the latest editable draft available to the async send completion.
  // A user can continue typing while the supervisor acknowledges a turn.
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (area) {
      area.style.height = "auto";
      area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
    }
  }, [text]);

  useEffect(() => {
    setRecents(workspace !== null ? loadRecents(workspace) : []);
    setBlocked(null);
  }, [workspace]);

  // US-4: a fresh thread from a summary arrives with its text pre-filled.
  // Loaded once per prefill value, then released back to the hook.
  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    setText(prefill);
    setCaret(prefill.length);
    setBlocked(null);
    onPrefillConsumed?.();
    const el = areaRef.current;
    if (el !== null) {
      el.focus();
      el.setSelectionRange(prefill.length, prefill.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const mentions: ResolvedMention[] = useMemo(
    () => (workspace !== null ? resolveMentions(workspace, text) : []),
    [workspace, text],
  );

  // US-20: `@mem/<id>` tokens in the text, resolved against the entries.
  const memTokens: (MemoryMentionToken & { entry: MemoryEntry | null })[] =
    useMemo(
      () =>
        parseMemoryMentions(text).map((t) => ({
          ...t,
          entry:
            memories !== undefined
              ? findMemoryByPrefix(memories, t.idPrefix)
              : null,
        })),
      [text, memories],
    );

  // US-20: insert one `@mem/…` token from the panel or the completion.
  useEffect(() => {
    if (memoryInsert === null || memoryInsert === undefined) return;
    const sep =
      text === "" || text.endsWith(" ") || text.endsWith("\n") ? "" : " ";
    const insert = `${sep}@${memoryInsert} `;
    const next = text + insert;
    setText(next);
    setCaret(next.length);
    setBlocked(null);
    onMemoryInsertConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryInsert]);

  function applyMemoryCandidate(m: MemoryEntry): void {
    if (active === null) return;
    const insert = `@mem/${m.id.slice(0, 8)} `;
    const next = text.slice(0, active.start) + insert + text.slice(active.end);
    const nextCaret = active.start + insert.length;
    setText(next);
    setCaret(nextCaret);
    setBlocked(null);
  }

  function removeMemToken(t: MemoryMentionToken): void {
    const after = text.slice(t.end, t.end + 1) === " " ? t.end + 1 : t.end;
    const next = text.slice(0, t.start) + text.slice(after);
    setText(next);
    setCaret(t.start);
    setBlocked(null);
  }

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
      const m = {
        ...resolveMention(workspace, r.relPath),
        start: active.start,
        end: active.end,
      };
      if (seen.has(m.absPath)) continue;
      seen.add(m.absPath);
      out.push(m);
    }
    if (active.query !== "") {
      const literal = {
        ...resolveMention(workspace, active.query),
        start: active.start,
        end: active.end,
      };
      if (!seen.has(literal.absPath)) out.push(literal);
    }
    return out.slice(0, 8);
  }, [workspace, active, recents]);

  // US-20: memory completion while typing `@mem…` (mouse-pick; the panel
  // `@mem` button inserts directly, so keyboard send is untouched).
  const memCandidates: MemoryEntry[] = useMemo(() => {
    if (memories === undefined || active === null) return [];
    if (!(active.query === "mem/" || active.query.startsWith("mem/")))
      return [];
    const rest = active.query.slice(4).toLowerCase();
    return memories
      .filter(
        (m) =>
          rest === "" ||
          m.id.toLowerCase().startsWith(rest) ||
          memoryChipLabel(m).toLowerCase().includes(rest),
      )
      .slice(0, 5);
  }, [memories, active]);

  useEffect(() => {
    setSelIndex(0);
    setDismissedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const activeKey =
    active !== null ? `${active.start}-${active.end}-${active.query}` : null;
  const dropdownOpen =
    active !== null &&
    candidates.length > 0 &&
    !disabled &&
    dismissedKey !== activeKey;
  const memDropdownOpen =
    memCandidates.length > 0 && !disabled && dismissedKey !== activeKey;

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
    if ((text.trim().length === 0 && attachmentsRef.current.length === 0) || disabled || checking || sending) return;
    const draftAtSend = text;
    const attachmentsAtSend = attachmentsRef.current;
    const attachmentsAtSendKey = attachmentKey(attachmentsAtSend);
    // US-20: expand `@mem/` tokens first (works even without a workspace:
    // memories are global). Unknown ids block explicitly, never silently.
    const memExpanded = expandMemoryMentions(text, memories ?? [], Date.now());
    if (memExpanded.missing.length > 0) {
      setBlocked(
        `Unknown memory reference(s) (${memExpanded.missing.map((p) => `@mem/${p}`).join(", ")}): remove or re-pick them from the memory panel.`,
      );
      return;
    }
    let toSend: string;
    if (workspace === null || mentions.length === 0) {
      toSend = memExpanded.text;
    } else {
      const outScoped = mentions.filter((m) => !m.inScope);
      if (outScoped.length > 0) {
        // Permission path: prefer the backend check_scope verdict (US-22);
        // without that command, fall back to blocking the send explicitly.
        setChecking(true);
        try {
          for (const m of outScoped) {
            const granted = await invoke<unknown>("check_scope", {
              path: m.absPath,
              sessionId,
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
      // US-20: file mentions enrich first, then memory blocks are expanded
      // on the enriched text (stale entries flagged, never silent).
      const { text: enriched } = buildEnrichedText(workspace, memExpanded.text);
      const fresh: RecentMention[] = [];
      for (const m of mentions) {
        if (!m.inScope) continue;
        if (fresh.some((r) => r.absPath === m.absPath)) continue;
        fresh.push({ relPath: m.relPath, absPath: m.absPath });
      }
      if (fresh.length > 0) {
        setRecents((cur) => {
          const next = [
            ...fresh,
            ...cur.filter((r) => !fresh.some((f) => f.absPath === r.absPath)),
          ].slice(0, RECENT_CAP);
          saveRecents(workspace, next);
          return next;
        });
      }
      toSend = enriched;
    }
    setBlocked(null);
    // M0-03: clear the draft only on the supervisor's admission ack. A
    // refusal (or ambiguous timeout) keeps the text in the box and in
    // sessionStorage — the message stays recoverable and retryable.
    setSending(true);
    try {
      const res = await onSend(toSend, buildTurnInputParts(toSend, attachmentsAtSend));
      // Do not erase text typed while the async send was in flight. The
      // admission ack belongs to the captured draft only.
      if (res.ok && textRef.current === draftAtSend) {
        setText("");
        setCaret(0);
        if (attachmentKey(attachmentsRef.current) === attachmentsAtSendKey) {
          setAttachments([]);
        }
      } else {
        setBlocked(res.error ?? "The message was not sent.");
      }
    } finally {
      setSending(false);
    }
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    if (disabled) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setAttachmentError(null);
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    if (room === 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const next: ComposerAttachment[] = [];
    const failures: string[] = [];
    for (const file of incoming.slice(0, room)) {
      if (attachmentsRef.current.some((attachment) => attachment.name === file.name && attachment.size === file.size)) {
        continue;
      }
      try {
        next.push(await readAttachment(file));
      } catch (error) {
        failures.push(`${file.name}: ${String(error).replace(/^Error:\s*/, "")}`);
      }
    }
    if (next.length > 0) {
      setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
    }
    if (failures.length > 0) setAttachmentError(failures.join(" · "));
  }

  async function steer(): Promise<void> {
    if (
      onSteer === undefined ||
      (text.trim().length === 0 && attachmentsRef.current.length === 0) ||
      disabled ||
      checking ||
      sending
    ) return;
    const draftAtSend = text;
    const attachmentsAtSend = attachmentsRef.current;
    const attachmentsAtSendKey = attachmentKey(attachmentsAtSend);
    setSending(true);
    try {
      const res = await onSteer(
        draftAtSend,
        buildTurnInputParts(draftAtSend, attachmentsAtSend),
      );
      if (res.ok && textRef.current === draftAtSend) {
        setText("");
        setCaret(0);
        if (attachmentKey(attachmentsRef.current) === attachmentsAtSendKey) {
          setAttachments([]);
        }
      } else if (!res.ok) {
        setBlocked(res.error ?? "The guidance was not sent.");
      }
    } finally {
      setSending(false);
    }
  }

  function removeAttachment(id: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing) return;
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
    <div className="composer-wrap" id="composer">
      <div
        className="composer"
        onDragOver={(event) => {
          if (!disabled) event.preventDefault();
        }}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
      >
        <div className="composer-main">
          {mentions.length > 0 && (
            <ul className="mention-chips" aria-label="Resolved mentions">
              {mentions.map((m, i) => (
                <li
                  key={`${m.start}-${m.end}-${i}`}
                  className={
                    m.inScope ? "mention-chip" : "mention-chip mention-chip-out"
                  }
                  title={m.absPath}
                >
                  <span className="mention-chip-path">
                    {m.inScope ? m.relPath : m.absPath}
                  </span>
                  {!m.inScope && (
                    <span className="mention-chip-flag">out of scope</span>
                  )}
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
          {memTokens.length > 0 && (
            <ul className="mention-chips" aria-label="Memory context">
              {memTokens.map((t, i) => {
                const stale = t.entry !== null && isStale(t.entry, Date.now());
                return (
                  <li
                    key={`${t.start}-${t.end}-${i}`}
                    className={
                      t.entry === null
                        ? "mention-chip mention-chip-out"
                        : stale
                          ? "mention-chip mention-chip-mem mention-chip-stale"
                          : "mention-chip mention-chip-mem"
                    }
                    title={
                      t.entry === null
                        ? `Unknown memory @mem/${t.idPrefix}`
                        : `${t.entry.text} — ${t.entry.source}`
                    }
                  >
                    <span className="mention-chip-path">
                      {t.entry === null
                        ? `@mem/${t.idPrefix}?`
                        : memoryChipLabel(t.entry)}
                    </span>
                    {t.entry !== null && (
                      <span className="mention-chip-flag">
                        {ageLabel(t.entry, Date.now())}
                      </span>
                    )}
                    <button
                      type="button"
                      className="mention-chip-remove"
                      aria-label={`Remove memory mention ${t.idPrefix}`}
                      onClick={() => removeMemToken(t)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {dropdownOpen && (
            <ul
              className="mention-list"
              role="listbox"
              aria-label="Mention completions"
            >
              {candidates.map((c, i) => (
                <li
                  key={c.absPath}
                  role="option"
                  aria-selected={i === selIndex}
                  className={
                    i === selIndex
                      ? "mention-item mention-item-active"
                      : "mention-item"
                  }
                  onMouseDown={(e) => {
                    // Select before the textarea loses focus/caret.
                    e.preventDefault();
                    applyCandidate(c);
                  }}
                >
                  <span className="mention-item-path">
                    {c.inScope ? c.relPath : c.absPath}
                  </span>
                  {c.inScope ? (
                    <span className="mention-item-scope">workspace</span>
                  ) : (
                    <span className="mention-item-scope mention-item-scope-out">
                      out of scope
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {memDropdownOpen && (
            <ul
              className="mention-list"
              role="listbox"
              aria-label="Memory completions"
            >
              {memCandidates.map((m) => (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={false}
                  className="mention-item"
                  onMouseDown={(e) => {
                    // Select before the textarea loses focus/caret.
                    e.preventDefault();
                    applyMemoryCandidate(m);
                  }}
                >
                  <span className="mention-item-path">
                    {memoryChipLabel(m)}
                  </span>
                  <span
                    className={
                      isStale(m, Date.now())
                        ? "mention-item-scope mention-item-scope-out"
                        : "mention-item-scope"
                    }
                  >
                    memory · {m.source} · {ageLabel(m, Date.now())}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {attachments.length > 0 && (
            <ul className="attachment-chips" aria-label="Attached files">
              {attachments.map((attachment) => (
                <li className="attachment-chip" key={attachment.id}>
                  <span className={`attachment-kind attachment-kind-${attachment.kind}`} aria-hidden="true">
                    {attachment.kind === "image" ? "▧" : "▤"}
                  </span>
                  <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
                  <span className="attachment-size">{formatAttachmentSize(attachment.size)}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    aria-label={`Remove attachment ${attachment.name}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachmentError !== null && (
            <div className="attachment-error" role="alert">{attachmentError}</div>
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
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
              if (images.length === 0) return;
              event.preventDefault();
              void addFiles(images);
            }}
            disabled={disabled}
            rows={3}
            placeholder={
              disabled
                ? "Open the desktop app to continue."
                : "Ask Muse to continue…"
            }
            aria-label="Message Muse"
            aria-expanded={dropdownOpen || memDropdownOpen}
            aria-autocomplete="list"
            title={COMPOSER_SHORTCUT_TITLES.textarea}
          />
          {blocked !== null && (
            <div className="mention-error" role="alert">
              {blocked}
            </div>
          )}
        </div>
        <div className="composer-actions">
          <div className="composer-context">
            <label className="composer-attach" title="Attach text files or images">
              <input
                type="file"
                accept="image/*,text/*,.md,.mdx,.ts,.tsx,.js,.jsx,.json,.css,.html,.rs,.py,.go,.java,.sh,.yaml,.yml,.toml"
                multiple
                disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
                onChange={(event) => {
                  void addFiles(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                }}
              />
              <span aria-hidden="true">＋</span>
              <span>Attach</span>
            </label>
            <AuthorizationModeControl
              mode={authorizationMode}
              onChange={onAuthorizationModeChange}
              compact
            />
            <div className="composer-model">{modelControl}</div>
          </div>
          {running && (
            <button onClick={onCancel} title={COMPOSER_SHORTCUT_TITLES.stop}>
              Stop
            </button>
          )}
          {running && onSteer !== undefined && (
            <button
              onClick={() => void steer()}
              disabled={
                disabled ||
                (text.trim().length === 0 && attachments.length === 0) ||
                checking ||
                sending
              }
              title="Guide the current turn without starting a new one"
            >
              Guide
            </button>
          )}
          <button
            className="send"
            aria-label="Send message"
            title={COMPOSER_SHORTCUT_TITLES.send}
            onClick={() => void send()}
            disabled={
              disabled ||
              (text.trim().length === 0 && attachments.length === 0) ||
              checking ||
              sending
            }
          >
            {checking || sending ? "…" : "↑"}
          </button>
        </div>
      </div>
      <p
        className="composer-hint"
        title="Enter sends, Shift+Enter inserts a newline, Escape dismisses completions"
      >
        Enter to send · Shift + Enter for a new line · @ for
        context
      </p>
    </div>
  );
}
