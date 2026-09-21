import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalInfo, TerminalState } from "../hooks/useMuseSessions";
import { parseAnsi } from "../lib/ansi";
import { terminalControlSequence } from "../lib/terminalShortcuts";

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
                ? "Send a message in this conversation first: the host only runs shell commands for a conversation it has loaded"
                : "Run this command through the Muse host (userShell)"
          }
        >
          Run in Muse
        </button>
      </form>
    </section>
  );
}
