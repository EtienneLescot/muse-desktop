#!/usr/bin/env node

/**
 * Create one browser annotation and verify its anchor (M4-02).
 * Requires the CDP-enabled dev build and an open Browser panel.
 *
 * Usage: node scripts/cdp-annotate.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error("no CDP page target");
  return page;
}

function connect(url) {
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

async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const HELPERS = `
  const vis = (n) => n && n.offsetParent !== null;
  const nodes = (s) => [...document.querySelectorAll(s)].filter(vis);
  const text = (n) => ((n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim());
  const clickText = (want) => {
    const hit = nodes('button, a, [role="button"], [role="tab"]').find((n) => text(n) === want)
      || nodes('button, a, [role="button"], [role="tab"]').find((n) => text(n).toLowerCase().includes(want.toLowerCase()));
    if (!hit) return false;
    hit.click();
    return true;
  };
  const setInput = (field, value) => {
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.focus();
  };
`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-annotate.v1", steps: {} };
  try {
    report.steps.before = await evaluate(client, `(() => {
      ${HELPERS}
      return {
        annotations: localStorage.getItem('muse-desktop.browser.annotations.v1'),
        tabs: Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs'))
          .map((k) => (localStorage.getItem(k) || '').slice(0, 140))
      };
    })()`);

    report.steps.openBrowser = await evaluate(client, `(() => { ${HELPERS} return { clicked: clickText('Browser') }; })()`);
    await sleep(1_500);

    // Fill the annotation fields that the panel exposes.
    report.steps.fill = await evaluate(client, `(() => {
      ${HELPERS}
      const all = nodes('input, textarea');
      const byPh = (want) => all.find((n) => (n.placeholder || '').toLowerCase().includes(want));
      const comment = byPh('comment');
      const quote = byPh('quoted selection');
      if (!comment) return { filled: false, reason: 'no comment field', fields: all.map((n) => n.placeholder) };
      setInput(comment, 'CDP annotation probe');
      if (quote) setInput(quote, 'example.com');
      return { filled: true, comment: comment.value, quote: quote ? quote.value : null };
    })()`);

    report.steps.actions = await evaluate(client, `(() => {
      ${HELPERS}
      return nodes('button').map((n) => text(n)).filter((t) => t && t.length < 44);
    })()`);

    report.steps.submitAttempts = await evaluate(client, `(() => {
      ${HELPERS}
      const tried = [];
      for (const label of ['Add note', 'Add annotation', 'Save note', 'Save annotation', 'Add comment', 'Save']) {
        if (clickText(label)) tried.push(label);
      }
      return { tried };
    })()`);
    await sleep(2_000);

    report.steps.after = await evaluate(client, `(() => {
      ${HELPERS}
      return {
        annotations: localStorage.getItem('muse-desktop.browser.annotations.v1'),
        bodyTail: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(-320)
      };
    })()`);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
