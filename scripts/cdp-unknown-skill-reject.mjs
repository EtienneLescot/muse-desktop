#!/usr/bin/env node

/**
 * Trigger a *deterministic* rejected send and measure whether the text survives
 * (M0-03). Previous attempts only reached the no-host case.
 *
 * The rejection used here is a local one: an unknown skill command. The send
 * pipeline validates skills before it reaches the harness and returns
 * "unknown skill /<name>", so no host behaviour is involved and the outcome is
 * reproducible.
 *
 * Conversation identity is verified before and after every step, because an
 * earlier attempt produced a misleading result by measuring a different
 * conversation than the one it had typed into.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-unknown-skill-reject.mjs
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const SKILL = process.env.MUSE_UNKNOWN_SKILL ?? "definitelynotaskill";
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

/** Identity of the displayed conversation, plus composer and outbox state. */
const STATE = `(() => {
  const active = localStorage.getItem("muse-desktop.active.v1");
  const h1 = document.querySelector("h1");
  const field = document.querySelector("textarea");
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean);
  const outboxKeys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.outbox.v1"));
  const outbox = outboxKeys.map((k) => {
    let parsed = [];
    try { parsed = JSON.parse(localStorage.getItem(k) || "[]"); } catch { parsed = []; }
    return { key: k.slice(-12), rows: Array.isArray(parsed) ? parsed.map((r) => ({ state: r.state, error: r.error, ambiguous: r.ambiguous === true })) : null };
  });
  return {
    activeId: active ? active.replace(/"/g, "") : null,
    title: h1 ? h1.innerText.trim().slice(0, 46) : null,
    composerValue: field ? field.value : null,
    composerDisabled: field ? field.disabled === true : null,
    outbox,
    outboxRows: outbox.reduce((sum, o) => sum + (o.rows ? o.rows.length : 0), 0),
    retryAffordance: buttons.filter((t) => /^(retry|discard|resend)$/i.test(t)),
    failureCopy: /unknown skill|could not be sent|not sent|failed to send/i.test(body),
    bodyTail: body.slice(-200)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-unknown-skill-reject.v1", skill: SKILL, steps: [] };
  try {
    // Open a conversation so the composer exists and a session is bound.
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);
    report.steps.push({ label: "opened", ...(await evaluate(client, STATE)) });

    const typed = await evaluate(client, `(() => {
      const field = document.querySelector("textarea");
      if (!field) return { typed: false, reason: "no textarea" };
      if (field.disabled) return { typed: false, reason: "composer disabled" };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
        field, "/" + ${JSON.stringify(SKILL)} + " this command names a skill that does not exist"
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true, len: field.value.length };
    })()`);
    report.typed = typed;
    report.steps.push({ label: "typed", ...(await evaluate(client, STATE)) });

    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(4_000);
    report.steps.push({ label: "submitted", ...(await evaluate(client, STATE)) });

    await sleep(6_000);
    report.steps.push({ label: "after-10s", ...(await evaluate(client, STATE)) });
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
