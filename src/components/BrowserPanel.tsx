import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  browserCaptureAttachment,
  describeBrowserElement,
  IMAGE_GENERATION_NOTE,
  formatBrowserContext,
  formatBrowserCaptureContext,
  normalizeBrowserUrl,
  type BrowserAnnotation,
  type BrowserAppPermission,
  type BrowserCapture,
  type BrowserCaptureRegion,
  type BrowserElementAnchor,
} from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  annotations: BrowserAnnotation[];
  permissions: BrowserAppPermission[];
  onAddAnnotation: (url: string, selection: string, comment: string, element?: BrowserElementAnchor | null) => void;
  onRemoveAnnotation: (id: string) => void;
  onSetPermission: (app: string, allowed: boolean) => void;
  /** Insert a bounded, provenance-labelled page context into the composer. */
  onInsertContext: (context: string) => void;
  /** Insert an explicitly captured visual page as context + image attachment. */
  onInsertCapture: (capture: BrowserCapture) => boolean;
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
  onInsertCapture,
}: Props) {
  const [url, setUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [frameKey, setFrameKey] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [nativeBrowserStatus, setNativeBrowserStatus] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [elementAnchor, setElementAnchor] = useState<BrowserElementAnchor | null>(null);
  const [comment, setComment] = useState("");
  const [appName, setAppName] = useState("");
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const [captureRegion, setCaptureRegion] = useState<BrowserCaptureRegion | null>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const captureImageRef = useRef<HTMLImageElement>(null);
  const captureDragRef = useRef<{ x: number; y: number } | null>(null);
  const selectionCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    selectionCleanupRef.current?.();
    selectionCleanupRef.current = null;
  }, []);

  const normalized = normalizeBrowserUrl(currentUrl);
  const addressNormalized = normalizeBrowserUrl(url);
  const renderable = normalized !== null;
  const pageNotes =
    normalized !== null
      ? annotations.filter((a) => a.url === normalized)
      : [];

  const submitAnnotation = () => {
    if (!renderable || normalized === null || comment.trim().length === 0) return;
    onAddAnnotation(normalized, selection, comment, elementAnchor);
    setSelection("");
    setElementAnchor(null);
    setComment("");
  };

  const handleFrameLoad = () => {
    setFrameError(null);
    // Same-origin previews can provide a real browser selection without
    // asking users to copy/paste it. Cross-origin frames remain usable; the
    // access error is intentionally swallowed because it is a browser rule.
    selectionCleanupRef.current?.();
    selectionCleanupRef.current = null;
    try {
      const document = frameRef.current?.contentDocument;
      if (!document) return;
      const syncSelection = () => {
        try {
          const selected = frameRef.current?.contentWindow?.getSelection()?.toString() ?? "";
          if (selected.trim().length > 0) setSelection(selected.trim());
        } catch {
          // Cross-origin selection is unavailable by design.
        }
      };
      const syncElement = (event: MouseEvent) => {
        try {
          const target = event.target;
          setElementAnchor(
            target && typeof (target as Element).tagName === "string"
              ? describeBrowserElement(target as Element)
              : null,
          );
        } catch {
          // Cross-origin access is unavailable by design.
        }
      };
      document.addEventListener("selectionchange", syncSelection);
      document.addEventListener("mouseup", syncSelection);
      document.addEventListener("click", syncElement, true);
      selectionCleanupRef.current = () => {
        document.removeEventListener("selectionchange", syncSelection);
        document.removeEventListener("mouseup", syncSelection);
        document.removeEventListener("click", syncElement, true);
      };
    } catch {
      // The iframe is cross-origin; the explicit selection field remains the
      // safe fallback and no page script is executed by Muse.
    }
  };

  const captureVisiblePage = async (): Promise<void> => {
    if (!renderable || normalized === null) return;
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
    if (typeof getDisplayMedia !== "function") {
      setCaptureStatus("Visual capture is unavailable in this browser build.");
      return;
    }
    setCaptureStatus("Choose the browser surface to capture…");
    let stream: MediaStream | null = null;
    try {
      stream = await getDisplayMedia.call(navigator.mediaDevices, {
        video: { displaySurface: "browser" },
        audio: false,
      });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("the selected surface could not be read"));
      });
      await video.play();
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (sourceWidth < 1 || sourceHeight < 1) throw new Error("the selected surface has no visible pixels");
      const scale = Math.min(1, 2400 / sourceWidth, 1600 / sourceHeight);
      const width = Math.max(1, Math.floor(sourceWidth * scale));
      const height = Math.max(1, Math.floor(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("the capture surface is unavailable");
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const next: BrowserCapture = {
        dataUrl,
        url: normalized,
        ...(selection.trim() ? { selection: selection.trim() } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(elementAnchor ? { element: elementAnchor } : {}),
        capturedAt: Date.now(),
        width,
        height,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      if (browserCaptureAttachment(next) === null) {
        throw new Error("the captured image exceeds the 5 MB attachment limit");
      }
      setCapture(next);
      setCaptureRegion(null);
      setCaptureStatus("Capture ready. Review it, then add it to the composer.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptureStatus(
        /denied|abort|cancel/i.test(message)
          ? "Visual capture was cancelled."
          : `Visual capture failed: ${userFacingError(message)}`,
      );
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  };

  const addCaptureToPrompt = () => {
    if (capture === null) return;
    if (onInsertCapture(capture)) {
      setCaptureStatus("Screenshot attached to the composer.");
    }
  };

  const capturePoint = (event: ReactPointerEvent<HTMLImageElement>): { x: number; y: number } | null => {
    if (capture === null) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(capture.width, Math.round(((event.clientX - rect.left) / rect.width) * capture.width))),
      y: Math.max(0, Math.min(capture.height, Math.round(((event.clientY - rect.top) / rect.height) * capture.height))),
    };
  };

  const cropCapture = async (): Promise<void> => {
    if (capture === null || captureRegion === null || captureRegion.width < 2 || captureRegion.height < 2) return;
    try {
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = captureRegion.width;
      canvas.height = captureRegion.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("the capture surface is unavailable");
      context.drawImage(
        image,
        captureRegion.x,
        captureRegion.y,
        captureRegion.width,
        captureRegion.height,
        0,
        0,
        captureRegion.width,
        captureRegion.height,
      );
      const next: BrowserCapture = {
        ...capture,
        dataUrl: canvas.toDataURL("image/jpeg", 0.84),
        width: captureRegion.width,
        height: captureRegion.height,
        region: captureRegion,
        sourceWidth: capture.width,
        sourceHeight: capture.height,
      };
      if (browserCaptureAttachment(next) === null) {
        throw new Error("the cropped image exceeds the 5 MB attachment limit");
      }
      setCapture(next);
      setCaptureRegion(null);
      setCaptureStatus("Region cropped. Review it, then add it to the composer.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptureStatus(`Region crop failed: ${userFacingError(message)}`);
    }
  };

  const insertCurrentContext = () => {
    if (!renderable || normalized === null) return;
    const context = formatBrowserContext(normalized, selection, comment, elementAnchor ?? undefined);
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
    setSelection("");
    setElementAnchor(null);
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
            ref={frameRef}
            key={frameKey}
            className="browser-frame"
            title={`Preview of ${normalized}`}
            src={normalized}
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleFrameLoad}
            onError={() => setFrameError("This page could not be loaded in the embedded preview.")}
          />
        )}
        <div className="browser-annotate">
          <div className="muted">Anchor a comment to this page + selection:</div>
          {elementAnchor && (
            <div className="browser-element-anchor" role="status" aria-live="polite">
              <span>Element anchor: <code>{elementAnchor.selector}</code></span>
              <button
                type="button"
                className="quiet"
                onClick={() => setElementAnchor(null)}
                title="Clear the selected element anchor"
              >
                Clear
              </button>
            </div>
          )}
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
          <div className="browser-capture-actions">
            <button
              type="button"
              disabled={!renderable}
              onClick={() => void captureVisiblePage()}
              title="Capture a visible browser surface after explicit system consent"
            >
              Capture visible page
            </button>
            {capture !== null && (
              <>
                <div className="browser-capture-canvas">
                  <img
                    ref={captureImageRef}
                    className="browser-capture-preview"
                    src={capture.dataUrl}
                    alt="Captured browser page preview; drag to select a region"
                    onPointerDown={(event) => {
                      const point = capturePoint(event);
                      if (point === null) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      captureDragRef.current = point;
                      setCaptureRegion({ ...point, width: 0, height: 0 });
                    }}
                    onPointerMove={(event) => {
                      const start = captureDragRef.current;
                      const point = capturePoint(event);
                      if (start === null || point === null) return;
                      setCaptureRegion({
                        x: Math.min(start.x, point.x),
                        y: Math.min(start.y, point.y),
                        width: Math.abs(point.x - start.x),
                        height: Math.abs(point.y - start.y),
                      });
                    }}
                    onPointerUp={(event) => {
                      captureDragRef.current = null;
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                    }}
                  />
                  {captureRegion !== null && captureRegion.width > 1 && captureRegion.height > 1 && (
                    <span
                      className="browser-capture-region"
                      aria-hidden="true"
                      style={{
                        left: `${(captureRegion.x / capture.width) * 100}%`,
                        top: `${(captureRegion.y / capture.height) * 100}%`,
                        width: `${(captureRegion.width / capture.width) * 100}%`,
                        height: `${(captureRegion.height / capture.height) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <span className="muted browser-capture-help">Drag on the preview to crop a region.</span>
                {captureRegion !== null && captureRegion.width > 1 && captureRegion.height > 1 && (
                  <button type="button" onClick={() => void cropCapture()}>
                    Crop to region
                  </button>
                )}
                <button type="button" onClick={addCaptureToPrompt}>
                  Add screenshot to prompt
                </button>
                <button type="button" className="quiet" onClick={() => { setCapture(null); setCaptureRegion(null); }}>
                  Remove capture
                </button>
              </>
            )}
          </div>
          {captureStatus !== null && (
            <div className="muted browser-capture-status" role="status" aria-live="polite">
              {captureStatus}
            </div>
          )}
          {capture !== null && (
            <div className="muted browser-capture-meta">
              {formatBrowserCaptureContext(capture).split("\n").slice(1, 4).join(" · ")}
            </div>
          )}
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
                  onClick={() => onInsertContext(formatBrowserContext(a.url, a.selection, a.comment, a.element))}
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
