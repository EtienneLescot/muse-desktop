#!/usr/bin/env node

/**
 * One bounded acceptance scenario for the group-1 tickets, driven through CDP.
 *
 * Requires the dev build launched with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
 *
 * Usage: node scripts/cdp-scenario.mjs [--live]
 *
 * Without `--live` it only inspects state and spends no model tokens.
 */
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const LIVE = argv.includes("--live");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function pageTarget() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await response.json();
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error("no CDP page target");
  return page;
}

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
    try { frame = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

export async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", {
    expression: wrapped, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const HELPERS = `
  const vis = (node) => node && node.offsetParent !== null;
  const nodes = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const labelled = (label, tag) => nodes(tag || 'button, a, [role="button"]')
    .filter((node) => (node.innerText || node.getAttribute('aria-label') || '').trim().toLowerCase().includes(label.toLowerCase()));
  const composer = () => nodes('textarea, [contenteditable="true"]')[0] || null;
`;

const appState = (client) => evaluate(client, `(() => {
  ${HELPERS}
  const field = composer();
  const queue = JSON.parse(localStorage.getItem('muse-desktop.queued-turns.v1') || '{}');
  const sessions = JSON.parse(localStorage.getItem('muse-desktop.sessions.v1') || '[]');
  const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    composer: field ? { disabled: field.disabled === true, value: field.value ?? '' } : null,
    queueKeys: Object.keys(queue),
    queueSize: JSON.stringify(queue).length,
    sessionCount: sessions.length,
    active: localStorage.getItem('muse-desktop.active.v1'),
    connected: /Connected/.test(body),
    disconnected: /Disconnected/.test(body),
    connectionError: /Connection error/.test(body),
    working: /WORKING/.test(body),
    stale: /No recent host update/.test(body),
    stopping: /Stopping Muse/.test(body),
    resuming: /Muse is resuming/.test(body),
    thinking: /thinking…|\\(thinking\\)/.test(body),
    completed: /Completed/.test(body),
    bodyTail: body.slice(-320)
  };
})()`);

const fill = (client, text) => evaluate(client, `(() => {
  ${HELPERS}
  const field = composer();
  if (!field) return { filled: false, reason: 'no composer' };
  if (field.disabled) return { filled: false, reason: 'composer disabled' };
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
  return { filled: true, value: field.value };
})()`);

/**
 * Submit whatever the composer is attached to. The home screen exposes a
 * "Start conversation" button, an open conversation exposes an icon-only send
 * button whose accessible name varies, so both are tried before Enter.
 */
const submit = (client) => evaluate(client, `(() => {
  ${HELPERS}
  const byLabel = labelled('start conversation')[0] || labelled('send')[0];
  if (byLabel) { byLabel.click(); return { via: 'labelled button', text: (byLabel.innerText||'').trim().slice(0,40) }; }
  const field = composer();
  const scope = field ? (field.closest('form') || field.parentElement?.parentElement || document) : document;
  const submitType = scope ? [...scope.querySelectorAll('button[type="submit"]')].filter(vis)[0] : null;
  if (submitType) { submitType.click(); return { via: 'submit button' }; }
  if (field) {
    const form = field.closest('form');
    if (form) { try { form.requestSubmit(); return { via: 'requestSubmit' }; } catch { /* fall through */ } }
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { via: 'enter key' };
  }
  return { via: null, reason: 'no composer' };
})()`);

const click = (client, label) => evaluate(client, `(() => {
  ${HELPERS}
  const matches = labelled(${JSON.stringify(label)});
  if (!matches.length) return { clicked: false, reason: 'no match' };
  const node = matches[0];
  node.click();
  return { clicked: true, text: (node.innerText || '').trim().slice(0, 60) };
})()`);

async function waitFor(client, predicate, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await appState(client);
    if (predicate(last)) return { reached: label, state: last };
    await sleep(1_000);
  }
  return { reached: null, wanted: label, state: last };
}

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-scenario.v1", live: LIVE, steps: {} };
  try {
    report.steps.initial = await appState(client);

    // Fresh conversation so the composer is enabled.
    await click(client, "New conversation");
    await sleep(1_500);
    report.steps.home = await appState(client);

    if (!LIVE) {
      report.steps.fill = await fill(client, "cdp dry run");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    report.steps.fill = await fill(client, "count slowly from one to fifty, one number per line");
    report.steps.submit = await submit(client);
    report.steps.started = await waitFor(client, (s) => s.working || s.thinking, "turn running", 30_000);

    // Second send while the turn runs: the host should queue it.
    await sleep(2_000);
    report.steps.queueFill = await fill(client, "second turn: reply with just QUEUED-ACK");
    report.steps.queueSubmit = await submit(client);
    report.steps.queued = await waitFor(client, (s) => s.queueSize > 2, "queue entry recorded", 30_000);

    // Interrupt the running turn.
    report.steps.stopClick = await click(client, "Stop");
    report.steps.stopping = await waitFor(client, (s) => s.stopping || !s.working, "stop acknowledged", 30_000);
    report.steps.afterStop = await appState(client);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`${(error && error.message) || error}\n`);
    exit(1);
  });
}
