#!/usr/bin/env node

/**
 * Queue a second turn, then remove it before it runs (M1-10).
 *
 * Already established: the queued disposition, its persistence in
 * `muse-desktop.queued-turns.v1`, the ordered Queued messages panel, and the
 * queue being consumed after a Stop. What was never measured is the **removal**
 * action: does taking a turn out of the queue actually drop it, in storage and
 * on screen?
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-queue-removal.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const FIRST = "QUEUE-FIRST-5207 count slowly from one to forty, one number per line";
const SECOND = "QUEUE-SECOND-8842 reply with just QUEUED";
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
    close() { try { socket.close(); } catch { /* closed */ } }
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

/** Queued entries in storage plus what the panel shows. */
const STATE = `(() => {
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  let queued = {};
  try { queued = JSON.parse(localStorage.getItem("muse-desktop.queued-turns.v1") || "{}"); } catch { queued = {}; }
  const rows = [];
  for (const [sessionId, list] of Object.entries(queued)) {
    if (Array.isArray(list)) for (const item of list) rows.push({ sessionId: sessionId.slice(-8), text: String(item.text || item.preview || "").slice(0, 40) });
  }
  const removeButtons = [...document.querySelectorAll("button")]
    .map((b) => (b.innerText || "").trim())
    .filter((t) => /remove from queue/i.test(t));
  return {
    queuedRows: rows.length,
    queued: rows,
    panelVisible: /Queued messages/i.test(body),
    removeAffordance: removeButtons.length,
    firstVisible: body.includes("QUEUE-FIRST"),
    secondVisible: body.includes("QUEUE-SECOND"),
    working: /WORKING/.test(body)
  };
})()`;

const typeAndSend = (client, text) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field) return { ok: false, reason: "no textarea" };
  if (field.disabled) return { ok: false, reason: "composer disabled" };
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  return { ok: true };
})()`);

async function pressEnter(client) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-queue-removal.v1", steps: [] };
  const record = async (label) => { report.steps.push({ label, ...(await evaluate(client, STATE)) }); };
  try {
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);
    await record("opened");

    // First turn: long enough that a second send lands while it runs.
    report.first = await typeAndSend(client, FIRST);
    await pressEnter(client);
    await sleep(3_000);
    await record("first-running");

    // Second turn: must be queued, not started.
    report.second = await typeAndSend(client, SECOND);
    await pressEnter(client);
    await sleep(3_000);
    await record("second-queued");

    // The measurement under test: remove it from the queue.
    report.removal = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll("button")].find((b) => /remove from queue/i.test((b.innerText || "")));
      if (!button) return { clicked: false };
      button.click();
      return { clicked: true, label: (button.innerText || "").trim().slice(0, 30) };
    })()`);
    await sleep(2_500);
    await record("after-removal");
    await sleep(4_000);
    await record("after-removal-settled");
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
