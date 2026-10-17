import { createContext, useContext, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [status, setStatus] = useState("Copy");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied");
    } catch {
      setStatus("Copy unavailable");
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

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

// GitHub-flavoured Markdown, rendered as React elements: raw HTML stays text
// (react-markdown never uses innerHTML) and unsafe URLs are dropped by its
// default transform. An unclosed fence renders as code while streaming.
/**
 * What a click on a link in a message does. The webview has no tabs, so a
 * plain `target="_blank"` link did nothing at all: a file the agent names
 * (`review.md`) never opened, nor did a web page. The app supplies the
 * handler; without one a click is still swallowed rather than navigating the
 * app window away.
 */
export const LinkOpenerContext = createContext<((href: string) => void) | null>(null);

function MessageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const open = useContext(LinkOpenerContext);
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) open?.(href);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = {
  pre: ({ children }) => {
    const code = Array.isArray(children) ? children[0] : children;
    const props = (code as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
    const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? "";
    return <CodeBlock text={textOf(props.children).replace(/\n$/, "")} language={language} />;
  },
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  table: ({ children }) => (
    <div className="message-table">
      <table>{children}</table>
    </div>
  ),
};

export function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-content">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
