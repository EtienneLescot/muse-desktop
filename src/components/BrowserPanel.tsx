import { useState } from "react";
import {
  IMAGE_GENERATION_NOTE,
  normalizeBrowserUrl,
  type BrowserAnnotation,
  type BrowserAppPermission,
} from "../lib/browserAnnotate";

interface Props {
  annotations: BrowserAnnotation[];
  permissions: BrowserAppPermission[];
  onAddAnnotation: (url: string, selection: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onSetPermission: (app: string, allowed: boolean) => void;
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
}: Props) {
  const [url, setUrl] = useState("");
  const [selection, setSelection] = useState("");
  const [comment, setComment] = useState("");
  const [appName, setAppName] = useState("");

  const normalized = normalizeBrowserUrl(url);
  const renderable = normalized !== null;
  const pageNotes =
    normalized !== null
      ? annotations.filter((a) => a.url === normalized)
      : [];

  const submitAnnotation = () => {
    if (!renderable || comment.trim().length === 0) return;
    onAddAnnotation(url, selection, comment);
    setSelection("");
    setComment("");
  };

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
        <div className="browser-url-row">
          <input
            className="browser-url"
            type="url"
            placeholder="https://example.com"
            aria-label="Page URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        {url.trim().length > 0 && !renderable && (
          <div className="muted" role="note">
            That URL can&apos;t be shown here (http/https only).
          </div>
        )}
        {renderable && normalized !== null && (
          <iframe
            className="browser-frame"
            title={`Preview of ${normalized}`}
            src={normalized}
            sandbox="allow-scripts allow-same-origin"
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
