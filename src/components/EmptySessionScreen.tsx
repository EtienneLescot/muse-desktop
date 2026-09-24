import type { ReactNode } from "react";
import { ProjectPicker } from "./ProjectPicker";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { AuthorizationMode } from "../lib/authorization";
import { ReasoningEffortControl } from "./ReasoningEffortControl";
import type { ReasoningEffort } from "../lib/reasoning";
import {
  folderName,
  projectOptionLabels,
  type ProjectWorkspaceOption,
} from "../lib/projects";
import { AuthorizationModeControl } from "./AuthorizationModeControl";
import { userFacingError } from "../lib/errorCopy";
import { displayPath } from "../lib/paths";
import {
  buildTurnInputParts,
  MAX_ATTACHMENTS,
  readAttachment,
  type ComposerAttachment,
  type TurnInputPart,
} from "../lib/attachments";
import { loadAttachmentDraft, saveAttachmentDraft } from "../lib/attachmentDraft";
import {
  readSessionStorageString,
  removeSessionStorageKey,
  writeSessionStorageString,
} from "../lib/storage";

interface Props {
  /** Default folder for the new thread; null until the user picks one. */
  workspace: string | null;
  /** Creates a project from a chosen folder, and returns its new option id. */
  onCreateProjectFromFolder: (path: string) => Promise<string | null>;
  /** Project roots available as explicit environments on the welcome screen. */
  environmentOptions?: ProjectWorkspaceOption[];
  /** Creates the session and sends the first message right away. */
  onStart: (
    draft: string,
    inputParts?: TurnInputPart[],
    environment?: NewConversationEnvironment,
  ) => Promise<boolean>;
  backendMissing?: boolean;
  /** US-33: explicit sidecar failure rendered instead of the blank screen. */
  sidecarError?: ReactNode | null;
  /**
   * Bumped by the app once a blocking setup step (installing the Muse CLI on
   * macOS) is done: a start the user already asked for is replayed with the
   * same draft, project, attachments and worktree choice.
   */
  resumeStartSignal?: number;
  /** Global tool-authorization posture shown in the first-message composer. */
  authorizationMode: AuthorizationMode;
  onAuthorizationModeChange: (mode: AuthorizationMode) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  /** Model picker for the next conversation; absent until a host lists models. */
  modelControl?: ReactNode;
}

/** Same folder whatever the spelling: native `\\?\` prefix, separators, case. */
function sameFolder(a: string, b: string): boolean {
  const norm = (path: string) => displayPath(path).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export interface NewConversationEnvironment {
  /** Project id when this conversation should inherit a project. */
  projectId: string | null;
  /** Workspace that the new session must use. */
  workspace: string | null;
  /** True when the conversation must start in a fresh worktree of that folder. */
  worktree?: boolean;
}

/**
 * Empty session screen shown when no session is active. Codex-like: the
 * folder/environment is chosen here, per thread, at creation time — there is
 * no global folder lock in the sidebar. Starting sends the typed message
 * immediately; nothing waits in the composer.
 */
export function EmptySessionScreen({
  workspace,
  onCreateProjectFromFolder,
  environmentOptions = [],
  onStart,
  backendMissing,
  sidecarError,
  resumeStartSignal = 0,
  authorizationMode,
  onAuthorizationModeChange,
  reasoningEffort,
  onReasoningEffortChange,
  modelControl = null,
}: Props) {
  const welcomeDraftKey = "muse-desktop.welcome-draft";
  const [draft, setDraft] = useState(() => readSessionStorageString(welcomeDraftKey));
  useEffect(() => {
    writeSessionStorageString(welcomeDraftKey, draft);
  }, [draft]);
  const [starting, setStarting] = useState(false);
  const startAttempted = useRef(false);
  const [worktree, setWorktree] = useState(false);
  const [initialAttachmentDraft] = useState(() => loadAttachmentDraft("welcome"));
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    initialAttachmentDraft.attachments,
  );
  const [attachmentRecovery] = useState(
    initialAttachmentDraft.truncated ||
      initialAttachmentDraft.attachments.some((attachment) => attachment.missing === true),
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceAttachmentId = useRef<string | null>(null);
  useEffect(() => {
    saveAttachmentDraft("welcome", attachments);
  }, [attachments]);
  const [environmentId, setEnvironmentId] = useState("default");
  const selectedEnvironment = environmentOptions.find(
    (option) => option.optionId === environmentId,
  );
  const selectedWorkspace = selectedEnvironment?.workspace ?? workspace;
  // Computed as a set: a folder is appended only where it distinguishes the row.
  const projectLabels = projectOptionLabels(environmentOptions);
  useEffect(() => {
    if (environmentId !== "default" && selectedEnvironment === undefined) {
      setEnvironmentId("default");
    }
  }, [environmentId, selectedEnvironment]);
  // Preselect the project of the current folder, as Codex reopens the last
  // project: otherwise the picker read "Choose a project" right above "Runs in
  // openscreen", two answers to the same question.
  const currentProject = workspace === null
    ? undefined
    : environmentOptions.find((option) => sameFolder(option.workspace, workspace));
  useEffect(() => {
    if (environmentId === "default" && currentProject !== undefined) {
      setEnvironmentId(currentProject.optionId);
    }
    // Only on arrival: a later explicit choice must stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.optionId]);
  // A conversation starts with a message, as in Claude Code and Codex: an
  // empty start only left "New conversation" rows with nothing in them.
  const canStart = selectedWorkspace !== null && !backendMissing && !starting
    && (draft.trim() !== "" || attachments.length > 0);

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
    startAttempted.current = true;
    const missing = attachments.filter((attachment) => attachment.missing === true);
    if (missing.length > 0) {
      setAttachmentError(`Reselect ${missing.map((attachment) => attachment.name).join(", ")} before starting.`);
      return;
    }
    setStarting(true);
    try {
      const sent = await onStart(
        draft,
        buildTurnInputParts(draft, attachments),
        {
          projectId: selectedEnvironment?.projectId ?? null,
          workspace: selectedWorkspace,
          // The choice is made here, before the conversation exists: starting in
          // a worktree is a decision about the next conversation, not a move of
          // an existing one.
          worktree,
        },
      );
      if (sent) {
        // The state too, not only the stored copy: a sent message came back
        // in the next conversation's composer and was sent twice.
        setDraft("");
        removeSessionStorageKey(welcomeDraftKey);
        setAttachments([]);
      }
    } finally {
      setStarting(false);
    }
  }

  async function replaceAttachment(id: string, files: FileList | File[]): Promise<void> {
    const file = Array.from(files)[0];
    replaceAttachmentId.current = null;
    if (file === undefined || starting) return;
    try {
      const replacement = await readAttachment(file);
      setAttachments((current) => current.map((attachment) => attachment.id === id ? replacement : attachment));
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(`${file.name}: ${userFacingError(error, "This attachment could not be read.")}`);
    }
  }
  useEffect(() => {
    if (resumeStartSignal > 0 && startAttempted.current && !starting) void start();
    // Only the signal replays a start; `start` is read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeStartSignal]);

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
      <div className="welcome-project-row">
        <ProjectPicker
          options={environmentOptions}
          labels={projectLabels}
          value={environmentId}
          onChange={setEnvironmentId}
          onCreateFromFolder={onCreateProjectFromFolder}
        />
        {/* The worktree choice is one bit, so it is a switch beside the picker it
            qualifies. Its consequence is spelled out in the note below, where the
            folder is already being explained, rather than in a banner of its own. */}
        <label className="welcome-worktree" title="Start this conversation in a copy of the folder, on its own branch">
          <input
            type="checkbox"
            role="switch"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
            disabled={selectedWorkspace === null}
          />
          <span>Worktree</span>
        </label>
      </div>
      <p className="welcome-project-note">
        {selectedWorkspace === null
          ? "Choose a project folder: a project is a folder, and its name comes from it."
          : worktree
            ? `Runs in a copy of ${folderName(selectedWorkspace)} on a new branch, leaving it untouched.`
            : selectedEnvironment
              ? `Runs in ${folderName(selectedEnvironment.workspace)}. The agent reads the rules of that folder.`
              : `Runs in ${folderName(selectedWorkspace)} with the global settings. The agent reads that folder's rules.`}
      </p>
      <div className="welcome-suggestions">
        {([
          [
            "Build an interface",
            "Create a landing page using this project's components.",
            "grid",
          ],
          [
            "Explore the project",
            "Explain the project structure and its main components.",
            "search",
          ],
          [
            "Review code",
            "Analyze the changes and provide a code review.",
            "code",
          ],
        ] as const).map(([title, prompt, icon]) => (
          <button key={title} onClick={() => setDraft(prompt)}>
            <Icon name={icon} />
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
                {attachment.missing === true && (
                  <>
                    <span className="attachment-missing">Reselect to restore</span>
                    <button
                      type="button"
                      className="attachment-reselect"
                      onClick={() => {
                        replaceAttachmentId.current = attachment.id;
                        fileInputRef.current?.click();
                      }}
                    >
                      Reselect
                    </button>
                  </>
                )}
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
        {attachmentRecovery && attachments.some((attachment) => attachment.missing === true) && attachmentError === null && (
          <div className="attachment-recovery" role="status">
            Some attachments were restored as metadata. Reselect them before starting.
          </div>
        )}
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
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*,.md,.mdx,.ts,.tsx,.js,.jsx,.json,.css,.html,.rs,.py,.go,.java,.sh,.yaml,.yml,.toml"
              multiple
              disabled={backendMissing || starting || attachments.length >= MAX_ATTACHMENTS}
              onChange={(event) => {
                const files = event.currentTarget.files ?? [];
                const replacementId = replaceAttachmentId.current;
                if (replacementId !== null) void replaceAttachment(replacementId, files);
                else void addFiles(files);
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
          <ReasoningEffortControl
            value={reasoningEffort}
            onChange={onReasoningEffortChange}
            compact
          />
          {modelControl}
          {(backendMissing || !selectedWorkspace) && (
            <small>
              {backendMissing ? "Available in the desktop app" : "Choose a folder to get started."}
            </small>
          )}
          <button
            className="welcome-send"
            aria-label="Start conversation"
            title="Start conversation · Enter"
            onClick={() => void start()}
            disabled={!canStart}
          >
            {starting ? "…" : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}
