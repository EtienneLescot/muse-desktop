import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserAppPermission } from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import {
  DESKTOP_KEYS,
  DESKTOP_PERMISSION_APP,
  desktopElementClickPoint,
  desktopWindowLabel,
  desktopElementLabel,
  desktopCaptureAttachment,
  formatDesktopCaptureContext,
  formatDesktopObservation,
  isDesktopControlAllowed,
  isDesktopPointInBounds,
  type DesktopControlStatus,
  type DesktopCapture,
  type DesktopElement,
  type DesktopKey,
  type DesktopWindow,
} from "../lib/desktopControl";
import {
  buildDesktopSkillArguments,
  findDesktopSkill,
  isAdvertisedDesktopSkill,
  type DesktopSkillAction,
} from "../lib/desktopSkills";
import type { HostSkill } from "../lib/hostSkills";
import type { SkillInvocationProgress } from "../lib/skills";

interface Props {
  permissions: BrowserAppPermission[];
  onSetPermission: (app: string, allowed: boolean) => void;
  onInsertCapture: (capture: DesktopCapture) => boolean;
  onInsertContext: (context: string) => boolean;
  hostSkills?: readonly HostSkill[];
  skillProgress?: SkillInvocationProgress;
  onInvokeDesktopSkill?: (selector: string, args: string) => void;
  onCancelDesktopSkill?: () => Promise<void> | void;
}

const WEB_STATUS: DesktopControlStatus = {
  supported: false,
  platform: "web",
  reason: "Desktop control is available only in the installed Muse app",
};

export function DesktopControlPanel({
  permissions,
  onSetPermission,
  onInsertCapture,
  onInsertContext,
  hostSkills = [],
  skillProgress,
  onInvokeDesktopSkill,
  onCancelDesktopSkill,
}: Props) {
  const [status, setStatus] = useState<DesktopControlStatus>(WEB_STATUS);
  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [elements, setElements] = useState<DesktopElement[]>([]);
  const [observing, setObserving] = useState(false);
  const [text, setText] = useState("");
  const [key, setKey] = useState<DesktopKey>("Enter");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<DesktopCapture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [stoppingHostSkill, setStoppingHostSkill] = useState(false);
  const allowed = isDesktopControlAllowed(permissions);
  const selected = useMemo(
    () => windows.find((window) => window.id === selectedId) ?? null,
    [selectedId, windows],
  );

  const syncPermission = useCallback(
    async (nextAllowed: boolean): Promise<boolean> => {
      if (!isTauriRuntime()) {
        onSetPermission(DESKTOP_PERMISSION_APP, nextAllowed);
        return true;
      }
      try {
        await invoke("set_desktop_control_permission", { allowed: nextAllowed });
        onSetPermission(DESKTOP_PERMISSION_APP, nextAllowed);
        setError(null);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [onSetPermission],
  );

  const refresh = useCallback(async () => {
    setError(null);
    if (!isTauriRuntime()) {
      setStatus(WEB_STATUS);
      setWindows([]);
      return;
    }
    try {
      const nextStatus = await invoke<DesktopControlStatus>(
        "desktop_control_status",
      );
      setStatus(nextStatus);
      if (!nextStatus.supported) {
        setWindows([]);
        setElements([]);
        return;
      }
      const nextWindows = await invoke<DesktopWindow[]>("desktop_windows");
      setWindows(nextWindows);
      setElements([]);
      setSelectedId((current) =>
        current !== null && nextWindows.some((window) => window.id === current)
          ? current
          : (nextWindows[0]?.id ?? null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const observeSelectedWindow = useCallback(async () => {
    if (!allowed || selected === null || !status.supported || !isTauriRuntime()) {
      setError("Allow desktop control and choose a supported window first.");
      return;
    }
    setObserving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await invoke<DesktopElement[]>("desktop_window_elements", {
        windowId: selected.id,
      });
      setElements(next);
      setMessage(`Observed ${next.length} visible control${next.length === 1 ? "" : "s"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setObserving(false);
    }
  }, [allowed, selected, status.supported]);

  const insertObservation = () => {
    if (selected === null) return;
    const context = formatDesktopObservation(selected, elements);
    if (onInsertContext(context)) setMessage("Desktop observation added to the conversation draft.");
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The persisted renderer preference is the product SSOT. Reassert it into
  // the volatile native gate whenever this panel mounts or the preference
  // changes; a fresh app process must never inherit consent implicitly.
  useEffect(() => {
    void syncPermission(allowed);
  }, [allowed, syncPermission]);

  const run = useCallback(
    async (operation: () => Promise<void>, success: string) => {
      if (!allowed || selected === null) {
        setError("Choose a window and allow desktop control first.");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await operation();
        setMessage(success);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [allowed, selected],
  );

  const sendText = () => {
    if (text.trim().length === 0) {
      setError("Enter text before sending it to the selected window.");
      return;
    }
    void run(
      async () => {
        await invoke("desktop_send_text", {
          windowId: selected?.id,
          text,
        });
      },
      "Text sent",
    );
  };

  const sendClick = () => {
    const pointX = Number(x);
    const pointY = Number(y);
    if (!isDesktopPointInBounds(selected, pointX, pointY)) {
      setError("Coordinates must stay inside the selected window bounds.");
      return;
    }
    void run(
      async () => {
        await invoke("desktop_click", {
          windowId: selected?.id,
          x: pointX,
          y: pointY,
        });
      },
      "Click sent",
    );
  };

  const clickObservedControl = (element: DesktopElement) => {
    const point = desktopElementClickPoint(selected, element);
    if (point === null) {
      setError("This observed control is outside the selected window bounds.");
      return;
    }
    void run(
      async () => {
        await invoke("desktop_click", {
          windowId: selected?.id,
          x: point.x,
          y: point.y,
        });
      },
      "Observed control clicked",
    );
  };

  const captureScreen = async () => {
    if (!allowed) {
      setError("Allow desktop control before capturing a desktop surface.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen capture is unavailable in this desktop runtime.");
      return;
    }
    setCapturing(true);
    setError(null);
    setMessage(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "window" },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No desktop surface was selected");
      const settings = track.getSettings();
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const width = Math.min(8_000, settings.width ?? video.videoWidth);
      const height = Math.min(8_000, settings.height ?? video.videoHeight);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error("The selected desktop surface has no usable dimensions");
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The desktop capture canvas is unavailable");
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const next: DesktopCapture = {
        dataUrl,
        source: "desktop-screen",
        capturedAt: Date.now(),
        width,
        height,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      if (desktopCaptureAttachment(next) === null) {
        throw new Error("The desktop capture exceeded the supported image limit");
      }
      setCapture(next);
      setMessage("Desktop surface captured. Review it before inserting it into the prompt.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setCapturing(false);
    }
  };

  const insertCapture = () => {
    if (capture === null) return;
    if (onInsertCapture(capture)) {
      setCapture(null);
      setMessage("Desktop capture added to the conversation draft.");
    }
  };

  const invokeDesktopSkill = (action: DesktopSkillAction) => {
    const skill = findDesktopSkill(hostSkills, action);
    if (skill === null || onInvokeDesktopSkill === undefined || selected === null) {
      setError("This desktop action is not available from the connected Muse host.");
      return;
    }
    if (action !== "observe" && !allowed) {
      setError("Allow desktop control before asking Muse to act on a window.");
      return;
    }
    const pointX = Number(x);
    const pointY = Number(y);
    onInvokeDesktopSkill(
      skill.selector,
      buildDesktopSkillArguments(action, selected, action === "type" ? text : key, pointX, pointY),
    );
    setMessage(`Asked Muse to ${action} the selected window.`);
  };

  const advertisedDesktopSkills = (Object.keys({
    observe: true,
    focus: true,
    click: true,
    type: true,
    key: true,
    screenshot: true,
  }) as DesktopSkillAction[]).filter((action) => findDesktopSkill(hostSkills, action) !== null);
  const desktopSkillInFlight = skillProgress !== undefined
    && ["preparing", "loading-resources", "sending", "queued", "running", "unknown"].includes(skillProgress.stage)
    && isAdvertisedDesktopSkill(hostSkills, skillProgress.name);
  const stopDesktopSkill = () => {
    if (!desktopSkillInFlight || onCancelDesktopSkill === undefined || stoppingHostSkill) return;
    setStoppingHostSkill(true);
    setMessage("Asking Muse to stop the desktop action…");
    void Promise.resolve(onCancelDesktopSkill())
      .then(() => setMessage("Stop requested. Waiting for Muse to confirm."))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setStoppingHostSkill(false));
  };

  return (
    <section className="desktop-control-panel" aria-label="Desktop control">
      <header className="desktop-control-header">
        <div>
          <p className="eyebrow">COMPUTER USE</p>
          <h2>Desktop control</h2>
          <p className="muted">
            Inspect visible windows and send one explicit action at a time.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          Refresh windows
        </button>
      </header>

      <div className={`desktop-control-status ${status.supported ? "is-ready" : "is-muted"}`} role="status">
        <strong>{status.supported ? "Available" : "Unavailable"}</strong>
        <span>{status.reason}</span>
      </div>

      <div className="desktop-capture-block">
        <div className="desktop-capture-heading">
          <div>
            <strong>Capture a desktop surface</strong>
            <p className="muted">Choose a window or monitor in the OS picker. Nothing is captured automatically.</p>
          </div>
          <button type="button" onClick={() => void captureScreen()} disabled={capturing || !status.supported || !allowed}>
            {capturing ? "Capturing…" : "Capture screen"}
          </button>
        </div>
        {capture && (
          <div className="desktop-capture-preview">
            <img src={capture.dataUrl} alt={`Captured desktop surface ${capture.width} by ${capture.height}`} />
            <div>
              <span className="muted">{formatDesktopCaptureContext(capture).split("\n")[2]}</span>
              <button type="button" onClick={insertCapture}>Add to prompt</button>
              <button type="button" onClick={() => setCapture(null)}>Discard</button>
            </div>
          </div>
        )}
      </div>

      {advertisedDesktopSkills.length > 0 && (
        <div className="desktop-host-actions">
          <div>
            <strong>Host actions</strong>
            <p className="muted">Only actions announced by the connected Muse host appear here.</p>
          </div>
          <div className="desktop-host-action-buttons">
            {advertisedDesktopSkills.map((action) => (
              <button
                type="button"
                key={action}
                onClick={() => invokeDesktopSkill(action)}
                disabled={busy || selected === null || (action !== "observe" && !allowed)}
              >
                {action}
              </button>
            ))}
            {desktopSkillInFlight && (
              <button type="button" onClick={stopDesktopSkill} disabled={stoppingHostSkill}>
                {stoppingHostSkill ? "Stopping…" : "Stop Muse action"}
              </button>
            )}
          </div>
        </div>
      )}

      <label className="desktop-control-consent">
        <input
          type="checkbox"
          checked={allowed}
          onChange={(event) => void syncPermission(event.target.checked)}
          disabled={!status.supported}
        />
        <span>
          <strong>Allow desktop control</strong>
          <small>Required before focus, typing or pointer actions.</small>
        </span>
      </label>

      {error && <p className="error desktop-control-feedback" role="alert">{error}</p>}
      {message && <p className="success desktop-control-feedback" role="status">{message}</p>}

      {windows.length === 0 ? (
        <p className="empty-state">No visible titled windows were found.</p>
      ) : (
        <div className="desktop-control-layout">
          <div className="desktop-window-list" role="listbox" aria-label="Visible windows">
            {windows.map((window) => (
              <button
                type="button"
                role="option"
                aria-selected={window.id === selectedId}
                className={window.id === selectedId ? "is-selected" : ""}
                key={window.id}
                onClick={() => {
                  setSelectedId(window.id);
                  setElements([]);
                }}
              >
                <strong>{window.title}</strong>
                <span>{desktopWindowLabel(window)}</span>
              </button>
            ))}
          </div>

          <div className="desktop-control-actions">
            <p className="muted">
              {selected ? `Selected: ${desktopWindowLabel(selected)}` : "Select a window"}
            </p>
            <button
              type="button"
              onClick={() => void run(async () => {
                await invoke("desktop_focus_window", { windowId: selected?.id });
              }, "Window focused")}
              disabled={busy || !allowed || selected === null}
            >
              Focus window
            </button>

            <div className="desktop-observation-block">
              <div className="desktop-observation-heading">
                <div>
                  <strong>Observe visible controls</strong>
                  <p className="muted">Read-only metadata and safe control values. Password-like values stay hidden; no input is sent.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void observeSelectedWindow()}
                  disabled={observing || busy || !allowed || selected === null}
                >
                  {observing ? "Observing…" : "Observe controls"}
                </button>
              </div>
              {elements.length > 0 && (
                <>
                  <div className="desktop-element-list" role="list" aria-label="Observed desktop controls">
                    {elements.slice(0, 40).map((element) => (
                      <div className="desktop-element-row" role="listitem" key={element.id}>
                        <div className="desktop-element-row-head">
                          <strong>{element.title || element.className || "Unnamed control"}</strong>
                          <button
                            type="button"
                            onClick={() => clickObservedControl(element)}
                            disabled={busy || !allowed || selected === null || !element.enabled || element.offscreen}
                            title="Click the center of this observed control"
                          >
                            Click
                          </button>
                        </div>
                        <span>{desktopElementLabel(element)}</span>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={insertObservation}>Add observation to prompt</button>
                </>
              )}
              {elements.length === 0 && !observing && <span className="muted">No observation captured yet.</span>}
            </div>

            <label>
              <span>Text</span>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value.slice(0, 2000))}
                placeholder="Text to send…"
                rows={3}
                disabled={busy || !allowed || selected === null}
              />
            </label>
            <button type="button" onClick={sendText} disabled={busy || !allowed || selected === null}>
              Send text
            </button>

            <label>
              <span>Key</span>
              <select value={key} onChange={(event) => setKey(event.target.value as DesktopKey)} disabled={busy || !allowed || selected === null}>
                {DESKTOP_KEYS.map((candidate) => <option key={candidate}>{candidate}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void run(async () => {
                await invoke("desktop_press_key", { windowId: selected?.id, key });
              }, `${key} sent`)}
              disabled={busy || !allowed || selected === null}
            >
              Send key
            </button>

            <div className="desktop-control-click">
              <span>Click inside window</span>
              <input aria-label="X coordinate" inputMode="numeric" value={x} onChange={(event) => setX(event.target.value)} />
              <input aria-label="Y coordinate" inputMode="numeric" value={y} onChange={(event) => setY(event.target.value)} />
              <button type="button" onClick={sendClick} disabled={busy || !allowed || selected === null}>
                Click
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="muted desktop-control-footnote">
        Actions are local, bounded and attributable to this panel. Muse never
        controls a desktop window implicitly.
      </p>
    </section>
  );
}
