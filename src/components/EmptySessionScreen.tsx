import type { ReactNode } from "react";
import { WorkspacePicker } from "./WorkspacePicker";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { AuthorizationMode } from "../lib/authorization";
import { AuthorizationModeControl } from "./AuthorizationModeControl";

interface Props {
  /** Default folder for the new thread; null until the user picks one. */
  workspace: string | null;
  onPickWorkspace: (path: string) => void;
  /** Creates the session and sends the first message right away. */
  onStart: (draft: string) => Promise<boolean>;
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
  const canStart = workspace !== null && !backendMissing && !starting;
  async function start() {
    if (!canStart) return;
    setStarting(true);
    try {
      const sent = await onStart(draft);
      if (sent) {
        try { sessionStorage.removeItem("muse-desktop.welcome-draft"); } catch { /* Best effort. */ }
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
      <div className="welcome-draft">
        <textarea
          aria-label="Your first message"
          placeholder="Describe what you want to build…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="welcome-draft-actions">
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
