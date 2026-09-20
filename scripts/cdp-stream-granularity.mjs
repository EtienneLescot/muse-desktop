#!/usr/bin/env node

/**
 * How often does a real turn write the transcript log?
 *
 * The round-41 benchmark measured the *cost* of one append (~1.2 ms at the
 * 2000-entry cap) but not how many appends a real turn performs, so the per-turn
 * cost was a calculation rather than an observation. This script supplies the
 * missing number by counting `localStorage.setItem` calls on the log key while a
 * genuine model turn streams.
 *
 * The counter is installed by wrapping `localStorage.setItem` in the page at
 * runtime. Nothing in the application is modified.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-stream-granularity.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const PROMPT = "Count slowly from one to thirty, one number per line.";
const MAX_WAIT_MS = Number(process.env.MUSE_STREAM_WAIT_MS ?? 180_000);
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

/**
 * Wrap setItem and record, per log key: call count, total serialized bytes, and
 * the largest payload. `__museAppendProbe` makes the install idempotent.
 */
const INSTALL_PROBE = `(() => {
  if (window.__museAppendProbe) { window.__museAppendProbe.reset(); return { installed: true, reused: true }; }
  const probe = {
    logWrites: 0,
    logBytes: 0,
    maxWriteBytes: 0,
    otherWrites: 0,
    samples: [],
    reset() { this.logWrites = 0; this.logBytes = 0; this.maxWriteBytes = 0; this.otherWrites = 0; this.samples = []; }
  };
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    const text = String(value);
    if (typeof key === "string" && key.startsWith("muse-desktop.log.v1.")) {
      probe.logWrites += 1;
      probe.logBytes += text.length;
      if (text.length > probe.maxWriteBytes) probe.maxWriteBytes = text.length;
      if (probe.samples.length < 12) probe.samples.push(Math.round(text.length / 1024));
    } else {
      probe.otherWrites += 1;
    }
    return original.call(this, key, value);
  };
  window.__museAppendProbe = probe;
  return { installed: true, reused: false };
})()`;

const READ_PROBE = `(() => {
  const p = window.__museAppendProbe;
  if (!p) return { installed: false };
  const active = (localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, "");
  let logEntries = null;
  try { logEntries = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + active) || "[]").length; } catch { logEntries = null; }
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    installed: true,
    logWrites: p.logWrites,
    logKbWritten: Math.round(p.logBytes / 1024),
    maxWriteKb: Math.round(p.maxWriteBytes / 1024),
    otherWrites: p.otherWrites,
    firstWritesKb: p.samples,
    logEntries,
    working: /WORKING/.test(body)
  };
})()`;

const type = (client, text) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field || field.disabled) return { ok: false };
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  return { ok: true };
})()`);

const submit = (client) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field || field.disabled) return { submitted: false };
  field.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    field.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  return { submitted: true, remaining: field.value.length };
})()`);

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-stream-granularity.v1", samples: [] };
  try {
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);

    report.install = await evaluate(client, INSTALL_PROBE);
    report.before = await evaluate(client, READ_PROBE);

    const typed = await type(client, PROMPT);
    const submitted = await submit(client);
    report.typed = typed;
    report.submitted = submitted;

    // Sample until the turn stops working, with a hard ceiling.
    const deadline = Date.now() + MAX_WAIT_MS;
    let sawWorking = false;
    while (Date.now() < deadline) {
      await sleep(4_000);
      const snap = await evaluate(client, READ_PROBE);
      report.samples.push(snap);
      if (snap.working) sawWorking = true;
      // Stop a few samples after activity ceased.
      if (sawWorking && !snap.working) break;
      if (report.samples.length > 4 && !sawWorking && snap.logWrites > 0 && !snap.working) break;
    }
    report.after = await evaluate(client, READ_PROBE);
    report.sawWorking = sawWorking;
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
