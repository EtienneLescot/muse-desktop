import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserAppPermission } from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import {
  DESKTOP_KEYS,
  DESKTOP_PERMISSION_APP,
  desktopWindowLabel,
  isDesktopControlAllowed,
  isDesktopPointInBounds,
  type DesktopControlStatus,
  type DesktopKey,
  type DesktopWindow,
} from "../lib/desktopControl";

interface Props {
  permissions: BrowserAppPermission[];
  onSetPermission: (app: string, allowed: boolean) => void;
}

const WEB_STATUS: DesktopControlStatus = {
  supported: false,
  platform: "web",
  reason: "Desktop control is available only in the installed Muse app",
};

export function DesktopControlPanel({ permissions, onSetPermission }: Props) {
  const [status, setStatus] = useState<DesktopControlStatus>(WEB_STATUS);
  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [key, setKey] = useState<DesktopKey>("Enter");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = isDesktopControlAllowed(permissions);
  const selected = useMemo(
    () => windows.find((window) => window.id === selectedId) ?? null,
    [selectedId, windows],
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
        return;
      }
      const nextWindows = await invoke<DesktopWindow[]>("desktop_windows");
      setWindows(nextWindows);
      setSelectedId((current) =>
        current !== null && nextWindows.some((window) => window.id === current)
          ? current
          : (nextWindows[0]?.id ?? null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

      <label className="desktop-control-consent">
        <input
          type="checkbox"
          checked={allowed}
          onChange={(event) =>
            onSetPermission(DESKTOP_PERMISSION_APP, event.target.checked)
          }
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
                onClick={() => setSelectedId(window.id)}
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

