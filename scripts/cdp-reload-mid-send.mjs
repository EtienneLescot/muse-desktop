#!/usr/bin/env node

/**
 * Reload the webview mid-send and check nothing the user typed is lost (M0-03,
 * "fermeture/rechargement" criterion).
 *
 * The durable outbox is supposed to survive a reload: an entry in `sending`
 * state must be recovered as failed (ambiguous) rather than silently dropped,
 * and the transcript must keep what was already accepted.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-reload-mid-send.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const MARKER = "RELOAD-MID-SEND-7391";
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

/** Durable state after a reload: log, outbox, recovered drafts, session list. */
const DURABLE = `(() => {
  const active = localStorage.getItem("muse-desktop.active.v1");
  const id = active ? active.replace(/"/g, "") : null;
  const logKey = id ? "muse-desktop.log.v1." + id : null;
  let log = [];
  try { log = JSON.parse((logKey && localStorage.getItem(logKey)) || "[]"); } catch { log = []; }
  const outboxKeys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.outbox.v1"));
  const outboxes = outboxKeys.map((k) => {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(k) || "[]"); } catch { rows = []; }
    return { key: k.slice(-12), rows: Array.isArray(rows) ? rows.map((r) => ({ state: r.state, error: r.error, ambiguous: r.ambiguous === true, text: (r.text || "").slice(0, 30) })) : [] };
  });
  const field = document.querySelector("textarea");
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    activeId: id,
    logEntries: log.length,
    markerInLog: log.filter((e) => (e.text || "").includes(${JSON.stringify(MARKER)})).length,
    outboxRows: outboxes.reduce((s, o) => s + o.rows.length, 0),
    outboxes: outboxes.filter((o) => o.rows.length > 0),
    composerValue: field ? field.value : null,
    composerHasMarker: field ? field.value.includes(${JSON.stringify(MARKER)}) : null,
    working: /WORKING/.test(body),
    retryAffordance: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter((t) => /^(retry|discard|resend)$/i.test(t)),
    sentCopyPresent: /could not be sent|not sent|unsent/i.test(body)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-reload-mid-send.v1", marker: MARKER, steps: [] };
  const record = async (label) => { const s = await evaluate(client, DURABLE); report.steps.push({ label, ...s }); return s; };
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

    // Type WITHOUT sending first, to check the draft survives a reload.
    const typed = await evaluate(client, `(() => {
      const field = document.querySelector("textarea");
      if (!field || field.disabled) return { typed: false };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(MARKER)} + " draft that must survive");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true };
    })()`);
    report.typed = typed;
    await record("typed-draft");

    // Reload with the draft still in the composer.
    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(12_000);
    await record("after-reload-draft");

    // Now send, then reload while the turn is in flight.
    const retyped = await evaluate(client, `(() => {
      const field = document.querySelector("textarea");
      if (!field || field.disabled) return { typed: false };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(MARKER)} + " send then reload");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true };
    })()`);
    report.retyped = retyped;
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(1_200);
    await record("sent");

    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(12_000);
    await record("after-reload-mid-send");
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
