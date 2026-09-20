#!/usr/bin/env node

/**
 * Minimal Chrome DevTools Protocol driver for the Muse-Desktop webview.
 *
 * The WebView2 accessibility tree does not expose the application's DOM and
 * synthetic keyboard input never reaches the renderer, so UI-level acceptance
 * scenarios cannot be driven through OS input. Launching the dev build with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` exposes
 * a CDP endpoint, and this driver turns it into deterministic DOM control.
 *
 * Dev-only instrumentation: it enables a WebView2 feature, it does not change
 * application code. Never point it at a packaged build.
 *
 * Usage:
 *   node scripts/cdp-drive.mjs eval "<expression>"
 *   node scripts/cdp-drive.mjs snapshot
 *   node scripts/cdp-drive.mjs click "<visible label>"      # matched by text, not CSS
 *   node scripts/cdp-drive.mjs fill "<text>"                # writes into the composer
 */
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const ENDPOINT = `http://127.0.0.1:${PORT}`;

export async function pageTarget() {
  const response = await fetch(`${ENDPOINT}/json/list`);
  if (!response.ok) throw new Error(`CDP list failed: HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(
    (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
  );
  if (!page) throw new Error(`no page target on ${ENDPOINT} (targets: ${targets.length})`);
  return page;
}

/** Open one WebSocket and expose request/response correlation. */
export function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    if (frame.id === undefined) return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${entry.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: timed out`));
        }, 20_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

/** Evaluate an expression and return its JSON value. */
export async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String(error && error.message || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
  }
  const text = result.result?.value;
  if (typeof text !== "string") return null;
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const PAGE_HELPERS = `
  const byText = (label, role) => [...document.querySelectorAll(role || 'button, a, [role="button"], summary, li, div')]
    .filter((node) => (node.innerText || '').trim().toLowerCase().includes(label.toLowerCase()))
    .filter((node) => node.offsetParent !== null);
  const composer = () => document.querySelector('textarea')
    || document.querySelector('[contenteditable="true"]')
    || document.querySelector('input[type="text"]');
`;

async function main() {
  const [command, ...rest] = argv.slice(2);
  if (!command) {
    process.stderr.write("usage: cdp-drive.mjs eval|snapshot|click|fill|keys ...\n");
    exit(1);
  }
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  try {
    if (command === "eval") {
      process.stdout.write(`${JSON.stringify(await evaluate(client, rest.join(" ")), null, 2)}\n`);
      return;
    }
    if (command === "snapshot") {
      const value = await evaluate(client, `(() => {
        ${PAGE_HELPERS}
        const field = composer();
        return {
          url: location.href,
          title: document.title,
          tauri: '__TAURI_INTERNALS__' in window,
          storageKeys: Object.keys(localStorage).filter((key) => key.startsWith('muse')),
          composer: field ? { tag: field.tagName, value: field.value ?? field.innerText, disabled: field.disabled === true } : null,
          buttons: byText('', 'button').map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 40),
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200),
        };
      })()`);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    if (command === "click") {
      const [needle] = rest;
      const value = await evaluate(client, `(() => {
        ${PAGE_HELPERS}
        const matches = byText(${JSON.stringify(needle)});
        if (!matches.length) return { clicked: false, reason: 'no match', needle: ${JSON.stringify(needle)} };
        const node = matches[0];
        node.click();
        return { clicked: true, tag: node.tagName, text: (node.innerText || '').trim().slice(0, 80) };
      })()`);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    if (command === "fill") {
      const [text] = rest;
      const value = await evaluate(client, `(() => {
        ${PAGE_HELPERS}
        const field = composer();
        if (!field) return { filled: false, reason: 'no composer' };
        const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.focus();
        return { filled: true, value: field.value };
      })()`);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    process.stderr.write(`unknown command: ${command}\n`);
    exit(1);
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
