import { FormEvent, useEffect, useRef, useState } from "react";
import type { TerminalInfo, TerminalState } from "../hooks/useMuseSessions";

interface Props {
  sessionId: string;
  terminal: TerminalState | null;
  onOpen: (sessionId: string, cols?: number, rows?: number) => Promise<TerminalInfo | null>;
  onRead: (terminalId: string) => Promise<void>;
  onWrite: (terminalId: string, input: string) => Promise<void>;
  onResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  onClose: (sessionId: string) => Promise<void>;
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
  onInsertContext,
}: Props) {
  const [command, setCommand] = useState("");
  const [opening, setOpening] = useState(false);
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
    let disposed = false;
    const read = () => {
      if (!disposed) void onRead(terminal.info.terminalId);
    };
    read();
    const timer = window.setInterval(read, 180);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [onRead, terminal]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [terminal?.output]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!terminal || command.length === 0) return;
    void onWrite(terminal.info.terminalId, `${command}\r`);
    setCommand("");
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
          <button type="button" className="terminal-context" onClick={() => onInsertContext(sessionId)}>
            Add output to prompt
          </button>
        </div>
      </header>
      <pre ref={outputRef} className="terminal-output" aria-label="Terminal output">
        {terminal.output || "Connected. Type a command below."}
        {terminal.done ? "\n\n[process exited]" : ""}
      </pre>
      <form className="terminal-input" onSubmit={submit}>
        <span aria-hidden="true">›</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Run a command…"
          aria-label="Terminal command"
          autoComplete="off"
        />
        <button type="submit" disabled={!command}>Send</button>
      </form>
    </section>
  );
}
