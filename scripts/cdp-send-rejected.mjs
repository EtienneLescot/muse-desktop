#!/usr/bin/env node

/**
 * Send with a live host, then kill the host mid-flight, and measure whether the
 * composer text survives (M0-03, "rejected send with a live host").
 *
 * Previous passes only proved the no-host case. This one has a real host, a
 * real send, and an abrupt host death during the send.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-send-rejected.mjs
 *
 * The script never terminates processes itself: it reports the moment the
 * caller should kill the host, then keeps observing.
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const WAIT_BEFORE_KILL_MS = Number(process.env.MUSE_KILL_AFTER_MS ?? 4_000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 60_000);
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

/** Composer state, transcript size, and any visible failure affordance. */
const STATE = `(() => {
  const field = document.querySelector('textarea');
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const buttons = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean);
  return {
    composerValue: field ? field.value : null,
    composerDisabled: field ? field.disabled === true : null,
    connected: /Connected/.test(body),
    disconnected: /Disconnected/.test(body),
    connectionError: /Connection error/.test(body),
    working: /WORKING/.test(body),
    stale: /No recent host update/.test(body),
    composerBlocked: /Open the desktop app to continue/.test(body),
    retryAffordance: buttons.filter((t) => /retry|discard|resend/i.test(t)).slice(0, 4),
    entryCount: (() => { const h = document.querySelector('[data-entry-count]'); return h ? Number(h.getAttribute('data-entry-count')) : null; })(),
    bodyTail: body.slice(-170)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-send-rejected.v1", steps: [] };
  try {
    report.steps.push({ label: "before", ...(await evaluate(client, STATE)) });

    // Type a long turn so the send is still in flight when the host dies.
    const typed = await evaluate(client, `(() => {
      const field = document.querySelector('textarea');
      if (!field) return { typed: false, reason: 'no textarea' };
      if (field.disabled) return { typed: false, reason: 'composer disabled' };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
        field, "Write a 400 word essay about the number seven."
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true, value: field.value.length };
    })()`);
    report.typed = typed;
    report.steps.push({ label: "typed", ...(await evaluate(client, STATE)) });

    // Send with Enter, the documented submission path.
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(1_500);
    report.steps.push({ label: "sent", ...(await evaluate(client, STATE)) });

    // Hand control back so the caller can kill the host, then observe.
    report.killWindowMs = WAIT_BEFORE_KILL_MS;
    const mark = Date.now();
    for (let step = 1; step <= 6; step += 1) {
      await sleep(WAIT_BEFORE_KILL_MS);
      report.steps.push({ label: `observe-${step}`, atMs: Date.now() - mark, ...(await evaluate(client, STATE)) });
    }
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
