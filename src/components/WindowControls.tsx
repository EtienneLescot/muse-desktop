import { useEffect, useState, type MouseEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icon";
import { userFacingError } from "../lib/errorCopy";

export function dragWindow(event: MouseEvent<HTMLElement>) {
  if (!isTauri() || event.button !== 0 ||
    (event.target as HTMLElement).closest("button, input, select, a")) return;
  const window = getCurrentWindow();
  void (event.detail === 2 ? window.toggleMaximize() : window.startDragging())
    .catch(error => console.error("Window interaction failed", error));
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => { void window.isMaximized().then(value => {
      if (!disposed) setMaximized(value);
    }).catch(() => {}); };
    sync();
    void window.onResized(sync).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  if (!isTauri()) return null;
  async function act(action: "minimize" | "toggleMaximize" | "close") {
    try { setError(null); await getCurrentWindow()[action](); }
    catch (error) { setError(userFacingError(`window action failed: ${String(error)}`, "Unable to change the window.")); }
  }
  return <div className="window-controls" aria-label="Window controls">
    <button aria-label="Minimize window" title="Minimize" onClick={() => void act("minimize")}><Icon name="minimize" /></button>
    <button aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void act("toggleMaximize")}><Icon name={maximized ? "restore" : "maximize"} /></button>
    <button className="window-close" aria-label="Close window" title="Close" onClick={() => void act("close")}><Icon name="close" /></button>
    {error && <span className="window-error" role="alert">{error}</span>}
  </div>;
}
