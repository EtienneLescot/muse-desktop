import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalInfo, TerminalState } from "../hooks/useMuseSessions";
import { parseAnsi } from "../lib/ansi";
import { terminalControlSequence } from "../lib/terminalShortcuts";

/** Mirrors the supervisor's clamps in `terminal.rs`. */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 4;
const MAX_ROWS = 200;

interface Props {
  sessionId: string;
  terminal: TerminalState | null;
  onOpen: (sessionId: string, cols?: number, rows?: number) => Promise<TerminalInfo | null>;
  onRead: (terminalId: string) => Promise<void>;
  onWrite: (terminalId: string, input: string) => Promise<void>;
  onResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  onClose: (sessionId: string) => Promise<void>;
  canRunThroughMuse: boolean;
  /**
   * Whether the host currently holds this conversation in memory.
   *
   * `session/userShell` answers `sessionNotLoaded` on a conversation the host
   * has only read from disk, so the action is disabled until a turn has loaded
   * it rather than failing after the click. `undefined` means the host did not
   * report a status, and the action stays available.
   */
  sessionLoaded?: boolean;
  onRunThroughMuse: (sessionId: string, command: string) => Promise<boolean>;
  onInsertContext: (sessionId: string) => boolean;
}

/**
 * A deliberately small terminal surface for M1-05. The PTY remains in the
 * supervisor when this panel is hidden; reopening simply resumes draining its
 * bounded output tail. ANSI bytes are preserved in the raw stream so a later
 * xterm renderer can be introduced without changing the backend contract.
 */
export function TerminalPanel({
  sessionId,
  terminal,
  onOpen,
  onRead,
  onWrite,
  onResize,
  onClose,
  canRunThroughMuse,
  sessionLoaded,
  onRunThroughMuse,
  onInsertContext,
}: Props) {
  const [command, setCommand] = useState("");
  const [opening, setOpening] = useState(false);
  const [runningThroughMuse, setRunningThroughMuse] = useState(false);
  const attemptedSession = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (terminal || opening || attemptedSession.current === sessionId) return;
    attemptedSession.current = sessionId;
    setOpening(true);
    void onOpen(sessionId).finally(() => setOpening(false));
  }, [onOpen, opening, sessionId, terminal]);

  useEffect(() => {
    if (!terminal) return;
    const terminalId = terminal.info.terminalId;
    let disposed = false;
    let timer: number | null = null;
    const read = () => {
      if (disposed) return;
      void onRead(terminalId).catch(() => undefined).finally(() => {
        if (!disposed) timer = window.setTimeout(read, 180);
      });
    };
    read();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [onRead, terminal?.info.terminalId]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [terminal?.output]);

  // Keep the PTY geometry in step with the pane. Measured on Windows (M1-05):
  // the pane followed the window while `mode con` stayed 28×100 — nothing ever
  // called `terminal_resize`, so the shell kept the size it was opened with.
  // The cell is measured in the rendered font rather than assumed, and the
  // last applied geometry is kept in a ref so observer bursts do not resend
  // the same size.
  const appliedGeometry = useRef<{ cols: number; rows: number } | null>(null);
  useEffect(() => {
    const output = outputRef.current;
    if (!terminal || !output) return;
    appliedGeometry.current = { cols: terminal.info.cols, rows: terminal.info.rows };
    const style = window.getComputedStyle(output);
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(100);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.font = style.font;
    document.body.appendChild(probe);
    const measured = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const cellWidth = measured > 0 ? measured : parseFloat(style.fontSize) * 0.6;
    const lineHeight =
      parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
    let raf: number | null = null;
    const observer = new ResizeObserver((entries) => {
      if (raf !== null) return;
      const entry = entries[entries.length - 1];
      if (!entry) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width <= 0 || height <= 0) return;
        const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(width / cellWidth)));
        const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(height / lineHeight)));
        const applied = appliedGeometry.current;
        if (applied !== null && applied.cols === cols && applied.rows === rows) return;
        appliedGeometry.current = { cols, rows };
        void onResize(terminal.info.terminalId, cols, rows);
      });
    });
    observer.observe(output);
    return () => {
      observer.disconnect();
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [onResize, terminal?.info.terminalId, terminal?.info.cols, terminal?.info.rows]);

  const outputChunks = useMemo(
    () => parseAnsi(terminal?.output ?? ""),
    [terminal?.output],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!terminal || command.length === 0) return;
    void onWrite(terminal.info.terminalId, `${command}\r`);
    setCommand("");
  };

  /**
   * The host only accepts `session/userShell` for a conversation it has loaded,
   * which happens on that conversation's first turn. Disabling here turns a
   * failure that used to arrive *after* the click into a stated precondition.
   * An absent `sessionLoaded` (older host) never blocks the action.
   */
  const sessionReady = sessionLoaded !== false;

  const runThroughMuse = () => {
    if (!canRunThroughMuse || !sessionReady || command.trim().length === 0 || runningThroughMuse) return;
    setRunningThroughMuse(true);
    void onRunThroughMuse(sessionId, command)
      .then((accepted) => {
        if (accepted) setCommand("");
      })
      .finally(() => setRunningThroughMuse(false));
  };

  if (!terminal) {
    return (
      <section className="terminal-panel" aria-live="polite">
        <div className="terminal-empty">
          <strong>{opening ? "Opening terminal…" : "Terminal unavailable"}</strong>
          <span>{opening ? "Starting a shell in this workspace." : "Try opening the panel again."}</span>
        </div>
      </section>
    );
  }

  const adjust = (delta: number) =>
    void onResize(terminal.info.terminalId, terminal.info.cols + delta, terminal.info.rows);

  return (
    <section className="terminal-panel" aria-label="Workspace terminal">
      <header className="terminal-toolbar">
        <div>
          <strong>Terminal</strong>
          <span className="terminal-meta">{terminal.info.shell} · {terminal.info.cwd}</span>
        </div>
        <div className="terminal-actions">
          <button type="button" onClick={() => adjust(-10)} aria-label="Reduce terminal width">−</button>
          <span className="terminal-size">{terminal.info.cols}×{terminal.info.rows}</span>
          <button type="button" onClick={() => adjust(10)} aria-label="Increase terminal width">+</button>
          <button type="button" className="terminal-close" onClick={() => void onClose(sessionId)}>Close</button>
          <button
            type="button"
            className="terminal-context"
            onClick={() => onInsertContext(sessionId)}
          >
            Add output to prompt
          </button>
        </div>
      </header>
      <pre ref={outputRef} className="terminal-output" aria-label="Terminal output">
        {outputChunks.length === 0 ? "Connected. Type a command below." : outputChunks.map((chunk, index) => (
          <span key={`${index}-${chunk.text.slice(0, 8)}`} style={chunk.style}>{chunk.text}</span>
        ))}
        {terminal.done ? "\n\n[process exited]" : ""}
      </pre>
      <form className="terminal-input" onSubmit={submit}>
        <span aria-hidden="true">›</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            const sequence = terminalControlSequence(event.key, event);
            if (!terminal || sequence === null) return;
            event.preventDefault();
            void onWrite(terminal.info.terminalId, sequence);
            if (event.key === "Escape") setCommand("");
          }}
          placeholder="Run a command…"
          aria-label="Terminal command"
          title="Shortcuts: Ctrl+C interrupt · Ctrl+D EOF · Ctrl+L clear · Tab complete · Escape"
          autoComplete="off"
        />
        <button type="submit" disabled={!command}>Send</button>
        <button
          type="button"
          className="terminal-muse"
          onClick={runThroughMuse}
          disabled={!canRunThroughMuse || !sessionReady || !command.trim() || runningThroughMuse}
          title={
            !canRunThroughMuse
              ? "This Muse host did not grant the userShell capability"
              : !sessionReady
                ? "The host has not loaded this conversation yet: reconnect it, or send a message"
                : "Run this command through the Muse host (userShell)"
          }
        >
          Run in Muse
        </button>
      </form>
    </section>
  );
}
