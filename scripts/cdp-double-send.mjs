#!/usr/bin/env node

/**
 * Submit the same message twice in quick succession and check that only one turn
 * is admitted (M0-03, "double-clic" criterion).
 *
 * The send pipeline has an explicit guard: a second send while one is in flight
 * returns "a send is already in progress for this conversation". This script
 * measures what actually happens rather than assuming the guard fires.
 *
 * Conversation identity is recorded at every step, because an earlier M0-03
 * attempt produced a misleading result by measuring a different conversation
 * than the one it had typed into.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-double-send.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
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

/** Identity, composer state, transcript growth and outbox rows. */
const STATE = `(() => {
  const active = localStorage.getItem("muse-desktop.active.v1");
  const h1 = document.querySelector("h1");
  const field = document.querySelector("textarea");
  const host = document.querySelector("[data-entry-count]");
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean);
  const outboxKeys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.outbox.v1"));
  return {
    activeId: active ? active.replace(/"/g, "") : null,
    title: h1 ? h1.innerText.trim().slice(0, 40) : null,
    entries: host ? Number(host.getAttribute("data-entry-count")) : null,
    composerValue: field ? field.value : null,
    composerDisabled: field ? field.disabled === true : null,
    working: /WORKING/.test(body),
    progressWarnings: /already in progress|not sent|could not be sent/i.test(body),
    retryAffordance: buttons.filter((t) => /^(retry|discard|resend)$/i.test(t)),
    outboxRows: outboxKeys.reduce((sum, k) => {
      try { const p = JSON.parse(localStorage.getItem(k) || "[]"); return sum + (Array.isArray(p) ? p.length : 0); } catch { return sum; }
    }, 0)
  };
})()`;

const MARKER = "DOUBLE-CLICK-PROBE-4187";

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-double-send.v1", marker: MARKER, steps: [] };
  const record = async (label) => { report.steps.push({ label, ...(await evaluate(client, STATE)) }); };
  try {
    // Open the same conversation the earlier M0-03 work used.
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);
    await record("opened");

    // Count the marker before sending, to measure the delta afterwards.
    report.markerBefore = await evaluate(client, `(() => {
      const host = document.querySelector("[data-entry-count]");
      const text = host ? host.innerText : "";
      return { occurrences: (text.match(new RegExp(${JSON.stringify(MARKER)}, "g")) || []).length };
    })()`);

    const typed = await evaluate(client, `(() => {
      const field = document.querySelector("textarea");
      if (!field || field.disabled) return { typed: false };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(MARKER)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true };
    })()`);
    report.typed = typed;

    // Two Enter presses back to back: a double click on the send affordance.
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    for (let press = 0; press < 2; press += 1) {
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      if (press === 0) await sleep(120);
    }
    await sleep(2_000);
    await record("after-double-enter");
    await sleep(6_000);
    await record("after-8s");

    report.markerAfter = await evaluate(client, `(() => {
      const host = document.querySelector("[data-entry-count]");
      const text = host ? host.innerText : "";
      return { occurrences: (text.match(new RegExp(${JSON.stringify(MARKER)}, "g")) || []).length };
    })()`);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
