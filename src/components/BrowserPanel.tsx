import { useState } from "react";
import {
  IMAGE_GENERATION_NOTE,
  formatBrowserContext,
  normalizeBrowserUrl,
  type BrowserAnnotation,
  type BrowserAppPermission,
} from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  annotations: BrowserAnnotation[];
  permissions: BrowserAppPermission[];
  onAddAnnotation: (url: string, selection: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onSetPermission: (app: string, allowed: boolean) => void;
  /** Insert a bounded, provenance-labelled page context into the composer. */
  onInsertContext: (context: string) => void;
}

/** Apps offered a computer-use toggle (explicit opt-in, default denied). */
const KNOWN_APPS = ["finder", "terminal", "editor"];

/**
 * US-19 in-app browser (scoped): a sandboxed iframe renders the URL, and
 * comments anchor to URL + selection text. Computer-use is a per-app
 * permission toggle (default denied); background operation needs an explicit
 * opt-in per app. Image generation is out of scope (honest note, no UI).
 */
export function BrowserPanel({
  annotations,
  permissions,
  onAddAnnotation,
  onRemoveAnnotation,
  onSetPermission,
  onInsertContext,
}: Props) {
  const [url, setUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [frameKey, setFrameKey] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [nativeBrowserStatus, setNativeBrowserStatus] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [comment, setComment] = useState("");
  const [appName, setAppName] = useState("");

  const normalized = normalizeBrowserUrl(currentUrl);
  const addressNormalized = normalizeBrowserUrl(url);
  const renderable = normalized !== null;
  const pageNotes =
    normalized !== null
      ? annotations.filter((a) => a.url === normalized)
      : [];

  const submitAnnotation = () => {
    if (!renderable || normalized === null || comment.trim().length === 0) return;
    onAddAnnotation(normalized, selection, comment);
    setSelection("");
    setComment("");
  };

  const insertCurrentContext = () => {
    if (!renderable || normalized === null) return;
    const context = formatBrowserContext(normalized, selection, comment);
    if (context.length > 0) onInsertContext(context);
  };

  const navigate = (nextInput: string, record = true) => {
    const next = normalizeBrowserUrl(nextInput);
    if (next === null) {
      setFrameError("That URL can't be shown here (http/https only).");
      return;
    }
    if (record) {
      const base = historyIndex >= 0 ? history.slice(0, historyIndex + 1) : [];
      const nextHistory = base[base.length - 1] === next ? base : [...base, next];
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length - 1);
    }
    setUrl(next);
    setCurrentUrl(next);
    setFrameError(null);
    setNativeBrowserStatus(null);
    setFrameKey((key) => key + 1);
  };

  const goBack = () => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    navigate(history[nextIndex], false);
  };

  const goForward = () => {
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    navigate(history[nextIndex], false);
  };

  async function openNativeBrowser(): Promise<void> {
    if (!renderable || normalized === null) return;
    if (!isTauriRuntime()) {
      setNativeBrowserStatus("The native browser is available in the desktop build.");
      return;
    }
    setNativeBrowserStatus("Opening native browser…");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_native_browser", { url: normalized });
      setNativeBrowserStatus("Opened in the Muse Browser window.");
    } catch (error) {
      setNativeBrowserStatus(
        userFacingError(
          `native browser open failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  const toggleApp = (app: string, allowed: boolean) => {
    onSetPermission(app, allowed);
  };

  const addCustomApp = () => {
    if (appName.trim().length === 0) return;
    onSetPermission(appName.trim(), true);
    setAppName("");
  };

  const isAllowed = (app: string) =>
    permissions.find((p) => p.app === app)?.allowed === true;

  return (
    <section className="browser-panel" aria-label="In-app browser">
      <details open>
        <summary className="browser-title">Browser</summary>
        <form className="browser-url-row" onSubmit={(event) => {
          event.preventDefault();
          navigate(url);
        }}>
          <input
            className="browser-url"
            type="url"
            placeholder="https://example.com"
            aria-label="Page URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" disabled={addressNormalized === null}>Go</button>
        </form>
        <div className="browser-nav-row" aria-label="Browser navigation">
          <button type="button" onClick={goBack} disabled={historyIndex <= 0} aria-label="Back">←</button>
          <button type="button" onClick={goForward} disabled={historyIndex < 0 || historyIndex >= history.length - 1} aria-label="Forward">→</button>
          <button type="button" onClick={() => renderable && setFrameKey((key) => key + 1)} disabled={!renderable}>Reload</button>
          <button
            type="button"
            className="browser-native-open"
            onClick={() => void openNativeBrowser()}
            disabled={!renderable}
            title="Open this page in a native Muse Browser window"
          >
            Open native
          </button>
          {normalized && <span className="browser-current-url" title={normalized}>{normalized}</span>}
        </div>
        {nativeBrowserStatus && (
          <div className="muted browser-native-status" role="status" aria-live="polite">
            {nativeBrowserStatus}
          </div>
        )}
        {url.trim().length > 0 && addressNormalized === null && (
          <div className="muted" role="note">
            That URL can&apos;t be shown here (http/https only).
          </div>
        )}
        {frameError && <div className="browser-frame-error" role="alert">{frameError}</div>}
        {renderable && normalized !== null && (
          <iframe
            key={frameKey}
            className="browser-frame"
            title={`Preview of ${normalized}`}
            src={normalized}
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => setFrameError(null)}
            onError={() => setFrameError("This page could not be loaded in the embedded preview.")}
          />
        )}
        <div className="browser-annotate">
          <div className="muted">Anchor a comment to this page + selection:</div>
          <input
            aria-label="Selection text"
            placeholder="Quoted selection (optional)"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
          />
          <input
            aria-label="Comment"
            placeholder="Comment (required)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button
            type="button"
            disabled={!renderable || comment.trim().length === 0}
            onClick={submitAnnotation}
          >
            Add comment
          </button>
          <button
            type="button"
            disabled={!renderable}
            onClick={insertCurrentContext}
            title="Add the current page URL, selection and comment to the composer"
          >
            Add page context
          </button>
        </div>
        {pageNotes.length > 0 && (
          <ul className="browser-notes">
            {pageNotes.map((a) => (
              <li key={a.id} className="browser-note">
                {a.selection !== "" && (
                  <blockquote title="Anchored selection">“{a.selection}”</blockquote>
                )}
                <span>{a.comment}</span>
                <button
                  type="button"
                  className="browser-note-remove"
                  title="Remove this comment"
                  onClick={() => onRemoveAnnotation(a.id)}
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => onInsertContext(formatBrowserContext(a.url, a.selection, a.comment))}
                  title="Add this annotation to the composer"
                >
                  Add to prompt
                </button>
              </li>
            ))}
          </ul>
        )}
        {annotations.length > pageNotes.length && (
          <div className="muted">
            +{annotations.length - pageNotes.length} comment(s) on other pages
          </div>
        )}
        <div className="browser-perms">
          <div className="muted browser-perms-title">
            Computer-use permissions (default denied — background operation
            needs an explicit opt-in per app)
          </div>
          <ul className="browser-perms-rows">
            {KNOWN_APPS.map((app) => {
              const allowed = isAllowed(app);
              return (
                <li key={app} className="browser-perm-row">
                  <code>{app}</code>
                  <span className="muted">{allowed ? "allowed" : "denied"}</span>
                  <button
                    type="button"
                    aria-pressed={allowed}
                    title={
                      allowed
                        ? `Revoke computer-use for ${app}`
                        : `Allow computer-use for ${app}`
                    }
                    onClick={() => toggleApp(app, !allowed)}
                  >
                    {allowed ? "Revoke" : "Allow"}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="browser-perms-custom">
            <input
              aria-label="Other app name"
              placeholder="Other app…"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
            />
            <button
              type="button"
              disabled={appName.trim().length === 0}
              onClick={addCustomApp}
            >
              Allow app
            </button>
          </div>
          {permissions.filter((p) => !KNOWN_APPS.includes(p.app)).length > 0 && (
            <ul className="browser-perms-rows">
              {permissions
                .filter((p) => !KNOWN_APPS.includes(p.app))
                .map((p) => (
                  <li key={p.app} className="browser-perm-row">
                    <code>{p.app}</code>
                    <span className="muted">{p.allowed ? "allowed" : "denied"}</span>
                    <button
                      type="button"
                      aria-pressed={p.allowed}
                      title={p.allowed ? `Revoke computer-use for ${p.app}` : `Allow computer-use for ${p.app}`}
                      onClick={() => toggleApp(p.app, !p.allowed)}
                    >
                      {p.allowed ? "Revoke" : "Allow"}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="muted" role="note" title="Image generation scope">
          {IMAGE_GENERATION_NOTE}
        </div>
      </details>
    </section>
  );
}
