import type { ReactNode } from "react";
import { WorkspacePicker } from "./WorkspacePicker";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { AuthorizationMode } from "../lib/authorization";
import { AuthorizationModeControl } from "./AuthorizationModeControl";
import { userFacingError } from "../lib/errorCopy";
import {
  buildTurnInputParts,
  MAX_ATTACHMENTS,
  readAttachment,
  type ComposerAttachment,
  type TurnInputPart,
} from "../lib/attachments";

interface Props {
  /** Default folder for the new thread; null until the user picks one. */
  workspace: string | null;
  onPickWorkspace: (path: string) => void;
  /** Creates the session and sends the first message right away. */
  onStart: (draft: string, inputParts?: TurnInputPart[]) => Promise<boolean>;
  backendMissing?: boolean;
  /** US-33: explicit sidecar failure rendered instead of the blank screen. */
  sidecarError?: ReactNode | null;
  /** Global tool-authorization posture shown in the first-message composer. */
  authorizationMode: AuthorizationMode;
  onAuthorizationModeChange: (mode: AuthorizationMode) => void;
}

/**
 * Empty session screen shown when no session is active. Codex-like: the
 * folder is chosen here, per thread, at creation time — there is no
 * global folder lock in the sidebar. Starting sends the typed message
 * immediately; nothing waits in the composer.
 */
export function EmptySessionScreen({
  workspace,
  onPickWorkspace,
  onStart,
  backendMissing,
  sidecarError,
  authorizationMode,
  onAuthorizationModeChange,
}: Props) {
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem("muse-desktop.welcome-draft") ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("muse-desktop.welcome-draft", draft);
    } catch {
      /* Best effort. */
    }
  }, [draft]);
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const canStart = workspace !== null && !backendMissing && !starting;

  async function addFiles(files: FileList | File[]): Promise<void> {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setAttachmentError(null);
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (room === 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const next: ComposerAttachment[] = [];
    const failures: string[] = [];
    for (const file of incoming.slice(0, room)) {
      if (attachments.some((attachment) => attachment.name === file.name && attachment.size === file.size)) continue;
      try {
        next.push(await readAttachment(file));
      } catch (error) {
        failures.push(`${file.name}: ${userFacingError(error, "This attachment could not be read.")}`);
      }
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
    if (failures.length > 0) setAttachmentError(failures.join(" · "));
  }

  async function start() {
    if (!canStart) return;
    setStarting(true);
    try {
      const sent = await onStart(draft, buildTurnInputParts(draft, attachments));
      if (sent) {
        try { sessionStorage.removeItem("muse-desktop.welcome-draft"); } catch { /* Best effort. */ }
        setAttachments([]);
      }
    } finally {
      setStarting(false);
    }
  }
  if (sidecarError) {
    return <div className="empty-session wide">{sidecarError}</div>;
  }
  return (
    <div className="empty-session">
      <span className="muse-logo">
        <img src="muse-logo.png" alt="Muse logo" />
      </span>
      <h2>
        Your ideas.
        <br />
        A little further.
      </h2>
      <p>Build, explore, and ship with Muse.</p>
      <WorkspacePicker workspace={workspace} onPick={onPickWorkspace} />
      <div className="welcome-suggestions">
        {[
          [
            "Build an interface",
            "Create a landing page using this project's components.",
          ],
          [
            "Explore the project",
            "Explain the project structure and its main components.",
          ],
          [
            "Review code",
            "Analyze the changes and provide a code review.",
          ],
        ].map(([title, prompt]) => (
          <button key={title} onClick={() => setDraft(prompt)}>
            <Icon name="code" />
            {title}
            <small>Start with Muse ↗</small>
          </button>
        ))}
      </div>
      <div
        className="welcome-draft"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <ul className="attachment-chips" aria-label="Attached files">
            {attachments.map((attachment) => (
              <li className="attachment-chip" key={attachment.id}>
                <span className="attachment-kind" aria-hidden="true">{attachment.kind === "image" ? "▧" : "▤"}</span>
                <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove attachment ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachmentError !== null && <div className="attachment-error" role="alert">{attachmentError}</div>}
        <textarea
          autoFocus
          aria-label="Your first message"
          placeholder="Describe what you want to build…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (images.length === 0) return;
            event.preventDefault();
            void addFiles(images);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="welcome-draft-actions">
          <label className="composer-attach" title="Attach text files or images">
            <input
              type="file"
              accept="image/*,text/*,.md,.mdx,.ts,.tsx,.js,.jsx,.json,.css,.html,.rs,.py,.go,.java,.sh,.yaml,.yml,.toml"
              multiple
              disabled={backendMissing || starting || attachments.length >= MAX_ATTACHMENTS}
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
          <small>
            {backendMissing
              ? "Available in the desktop app"
              : workspace
                ? draft.trim() === ""
                  ? "Press start to open the conversation."
                  : "Your message is sent as soon as you start."
                : "Choose a folder to get started."}
          </small>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={!canStart}
          >
            {starting ? "Starting…" : "Start conversation"}
            <Icon name="arrow-right" />
          </button>
        </div>
      </div>
    </div>
  );
}
