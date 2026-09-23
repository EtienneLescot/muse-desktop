import { useEffect, useRef, useState } from "react";
import {
  createBrowserTab,
  formatBrowserContext,
  loadBrowserTabs,
  MAX_BROWSER_TABS,
  normalizeBrowserUrl,
  saveBrowserTabs,
  type BrowserTab,
} from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import { userFacingError } from "../lib/errorCopy";

interface Props {
  /** Conversation identity; tabs and history never leak across sessions. */
  sessionId: string;
  /** Insert the current page, labelled with its URL, into the composer. */
  onInsertContext: (context: string) => void;
}

function tabTitle(url: string): string {
  if (url === "") return "New tab";
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return url;
  }
}

/**
 * The in-app browser, laid out like one: tabs, a toolbar with back, forward,
 * reload and the address bar, and the page filling the rest. Its main use is
 * previewing the project (a local dev server); most public sites refuse to be
 * framed, so "Open in window" hands the page to Muse's own browser window.
 */
export function BrowserPanel({ sessionId, onInsertContext }: Props) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => {
    const stored = loadBrowserTabs(sessionId);
    return stored.length > 0 ? stored : [createBrowserTab()];
  });
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id);
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const [address, setAddress] = useState(active.url);
  const [frameKey, setFrameKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveBrowserTabs(tabs, sessionId);
  }, [sessionId, tabs]);

  const page = normalizeBrowserUrl(active.url);

  const showTab = (tab: BrowserTab) => {
    setActiveTabId(tab.id);
    setAddress(tab.url);
    setNotice(null);
  };

  const updateActive = (patch: Partial<BrowserTab>) => {
    setTabs((cur) => cur.map((tab) => (tab.id === active.id ? { ...tab, ...patch } : tab)));
  };

  const go = (input: string, index?: number) => {
    const next = normalizeBrowserUrl(input);
    if (next === null) {
      setNotice("Enter an http or https address, or a local server such as localhost:5173.");
      return;
    }
    setNotice(null);
    setAddress(next);
    setFrameKey((key) => key + 1);
    if (index !== undefined) {
      updateActive({ url: next, historyIndex: index });
      return;
    }
    const base = active.historyIndex >= 0 ? active.history.slice(0, active.historyIndex + 1) : [];
    const history = base[base.length - 1] === next ? base : [...base, next];
    updateActive({ url: next, history, historyIndex: history.length - 1 });
  };

  const canBack = active.historyIndex > 0;
  const canForward = active.historyIndex >= 0 && active.historyIndex < active.history.length - 1;

  const newTab = () => {
    if (tabs.length >= MAX_BROWSER_TABS) return;
    const tab = createBrowserTab();
    setTabs((cur) => [...cur, tab]);
    showTab(tab);
    requestAnimationFrame(() => addressRef.current?.focus());
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) {
      const blank = createBrowserTab();
      setTabs([blank]);
      showTab(blank);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    setTabs(rest);
    if (id === active.id) showTab(rest[Math.min(index, rest.length - 1)]);
  };

  async function openInWindow(): Promise<void> {
    if (page === null) return;
    if (!isTauriRuntime()) {
      setNotice("The browser window is available in the desktop app.");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_native_browser", { url: page, sessionId });
    } catch (error) {
      setNotice(userFacingError(`Could not open the browser window: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  return (
    <section className="browser" aria-label="In-app browser">
      <div className="browser-tabstrip" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className="browser-tab" data-active={tab.id === active.id}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active.id}
              className="browser-tab-label"
              title={tab.url || "New tab"}
              onClick={() => showTab(tab)}
            >
              {tabTitle(tab.url)}
            </button>
            <button
              type="button"
              className="browser-tab-close"
              aria-label={`Close ${tabTitle(tab.url)}`}
              onClick={() => closeTab(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browser-tab-new"
          aria-label="New tab"
          disabled={tabs.length >= MAX_BROWSER_TABS}
          onClick={newTab}
        >
          +
        </button>
      </div>

      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          go(address);
        }}
      >
        <button type="button" aria-label="Back" disabled={!canBack} onClick={() => go(active.history[active.historyIndex - 1], active.historyIndex - 1)}>
          ←
        </button>
        <button type="button" aria-label="Forward" disabled={!canForward} onClick={() => go(active.history[active.historyIndex + 1], active.historyIndex + 1)}>
          →
        </button>
        <button type="button" aria-label="Reload" disabled={page === null} onClick={() => setFrameKey((key) => key + 1)}>
          ↻
        </button>
        <input
          ref={addressRef}
          className="browser-address"
          aria-label="Address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.target.select()}
          placeholder="Search or enter an address, e.g. localhost:5173"
          spellCheck={false}
        />
        <button
          type="button"
          aria-label="Add this page to the prompt"
          title="Add this page to the prompt"
          disabled={page === null}
          onClick={() => page !== null && onInsertContext(formatBrowserContext(page))}
        >
          @
        </button>
        <button
          type="button"
          aria-label="Open in a browser window"
          title="Open in a browser window (for sites that cannot be shown here)"
          disabled={page === null}
          onClick={() => void openInWindow()}
        >
          ⧉
        </button>
      </form>

      {notice !== null && <p className="browser-notice" role="status">{notice}</p>}

      <div className="browser-viewport">
        {page !== null ? (
          <iframe
            key={`${active.id}-${frameKey}`}
            title={`Page ${page}`}
            src={page}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="browser-empty">
            <p>Preview your app or open a page.</p>
            <p className="muted">
              Type an address above, for example <code>localhost:5173</code>. Sites that refuse to be
              embedded open in a browser window with ⧉.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
