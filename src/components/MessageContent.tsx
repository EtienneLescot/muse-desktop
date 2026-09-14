import { useState } from "react";
import { messageBlocks } from "../lib/messageBlocks";

function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
        .map((part, index) =>
          part.startsWith("`") ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : part.startsWith("**") ? (
            <strong key={index}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </>
  );
}
function CodeBlock({ text, language }: { text: string; language: string }) {
  const [status, setStatus] = useState("Copy");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied");
    } catch {
      setStatus("Copie indisponible");
    }
  }
  return (
    <div className="message-code">
      <header>
        <span>{language || "Code"}</span>
        <button onClick={() => void copy()}>{status}</button>
      </header>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
export function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-content">
      {messageBlocks(text).map((block, index) =>
        block.kind === "code" ? (
          <CodeBlock key={index} text={block.text} language={block.language} />
        ) : (
          <div key={index}>
            {block.text
              .split(/\n\s*\n/)
              .filter(Boolean)
              .map((paragraph, p) => {
                if (/^#{1,3} /.test(paragraph))
                  return (
                    <h3 key={p}>
                      <Inline text={paragraph.replace(/^#{1,3} /, "")} />
                    </h3>
                  );
                const lines = paragraph.split("\n");
                if (lines.every((line) => /^[-*] /.test(line)))
                  return (
                    <ul key={p}>
                      {lines.map((line, l) => (
                        <li key={l}>
                          <Inline text={line.slice(2)} />
                        </li>
                      ))}
                    </ul>
                  );
                return (
                  <p key={p}>
                    <Inline text={paragraph} />
                  </p>
                );
              })}
          </div>
        ),
      )}
    </div>
  );
}
