import { useState } from "react";

interface Props {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

/** Prompt composer: Enter sends, Shift+Enter inserts a newline. */
export function Composer({ disabled, running, onSend, onCancel }: Props) {
  const [text, setText] = useState("");

  function send(): void {
    if (text.trim().length === 0 || disabled) return;
    onSend(text);
    setText("");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled}
        rows={3}
        placeholder={
          disabled ? "Pick a workspace and start a session first." : "Type a prompt… (Enter to send)"
        }
        aria-label="Prompt input"
      />
      <div className="composer-actions">
        {running && (
          <button onClick={onCancel} title="Stop the running sidecar">
            Stop
          </button>
        )}
        <button onClick={send} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}
