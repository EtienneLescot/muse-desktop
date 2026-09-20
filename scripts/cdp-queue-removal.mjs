#!/usr/bin/env node

/**
 * Queue a second turn, then remove it before it runs (M1-10).
 *
 * The previous attempt produced nothing because it never verified that the
 * first turn was actually running before sending the second one, so nothing was
 * ever queued and the removal button never existed. This version **waits for
 * each precondition** instead of assuming it:
 *
 *   1. the composer is present, enabled, and empty on a connected conversation;
 *   2. after the first send, the composer clears AND `working` becomes true;
 *   3. after the second send, `queuedRows >= 1` before looking for the button.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-queue-removal.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const FIRST = "Count slowly from one to forty, one number per line.";
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

/** Everything the preconditions need, in one read. */
const STATE = `(() => {
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0] || null;
  let queued = {};
  try { queued = JSON.parse(localStorage.getItem("muse-desktop.queued-turns.v1") || "{}"); } catch { queued = {}; }
  const rows = [];
  for (const [sessionId, list] of Object.entries(queued)) {
    if (Array.isArray(list)) for (const item of list) rows.push({ sessionId: sessionId.slice(-8), text: String(item.text || item.preview || "").slice(0, 44) });
  }
  return {
    activeId: (localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, ""),
    title: document.querySelector("h1") ? document.querySelector("h1").innerText.trim().slice(0, 40) : null,
    composerPresent: Boolean(field),
    composerEnabled: field ? field.disabled !== true : null,
    composerLength: field ? field.value.length : null,
    working: /WORKING/.test(body),
    connected: /Connected/.test(body),
    entryCount: (() => { const h = document.querySelector("[data-entry-count]"); return h ? Number(h.getAttribute("data-entry-count")) : null; })(),
    queuedRows: rows.length,
    queued: rows,
    panelVisible: /Queued messages/i.test(body),
    removeButtons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter((t) => /remove from queue/i.test(t)).length,
    secondInComposer: field ? field.value.includes("QUEUE-SECOND-8842") : null
  };
})()`;

const readState = (client) => evaluate(client, STATE);

async function waitFor(client, label, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readState(client);
    if (predicate(last)) return { label, ok: true, state: last };
    await sleep(1_200);
  }
  return { label, ok: false, state: last };
}

/**
 * Submit from the page context.
 *
 * Dispatching `Input.dispatchKeyEvent` and not awaiting the reply proved
 * unreliable here: the composer kept its 52 characters and the send never
 * happened. The previous campaigns submitted successfully with `Input.insertText`
 * (awaited), so this helper does the equivalent locally and returns the result.
 */
const submit = (client) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field) return { submitted: false, reason: "no composer" };
  if (field.disabled) return { submitted: false, reason: "composer disabled" };
  field.focus();
  const before = field.value.length;
  for (const type of ["keydown", "keypress", "keyup"]) {
    field.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  return { submitted: true, before, after: field.value.length };
})()`);

const type = (client, text) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field) return { ok: false, reason: "no composer" };
  if (field.disabled) return { ok: false, reason: "composer disabled" };
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  return { ok: true, length: field.value.length };
})()`);

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-queue-removal.v1", preconditions: [], steps: [] };
  try {
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);

    report.preconditions.push(await waitFor(client, "composer prÃªt et vide",
      (s) => s.composerPresent && s.composerEnabled === true && s.composerLength === 0 && s.connected));

    report.firstType = await type(client, FIRST);
    report.submitFirst = await submit(client);
    report.preconditions.push(await waitFor(client, "premier envoi acceptÃ© (composer vidÃ©)",
      (s) => s.composerLength === 0, 20_000));
    report.preconditions.push(await waitFor(client, "premier tour en cours",
      (s) => s.working === true, 30_000));

    report.secondType = await type(client, SECOND);
    report.submitSecond = await submit(client);
    report.preconditions.push(await waitFor(client, "second tour mis en file",
      (s) => s.queuedRows >= 1, 30_000));

    report.steps.push({ label: "queued", ...(await readState(client)) });

    report.removal = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll("button")].find((b) => /remove from queue/i.test((b.innerText || "")));
      if (!button) return { clicked: false, queueButtons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter((t) => /queue/i.test(t)).slice(0, 6) };
      button.click();
      return { clicked: true, label: (button.innerText || "").trim().slice(0, 30) };
    })()`);
    await sleep(2_500);
    report.steps.push({ label: "after-removal", ...(await readState(client)) });
    await sleep(4_000);
    report.steps.push({ label: "after-removal-settled", ...(await readState(client)) });
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
