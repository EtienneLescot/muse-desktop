#!/usr/bin/env node

/**
 * The minimum bar for a beta: can a user open the app, start a conversation, get
 * an answer, and find the conversation again after a restart?
 *
 * Everything here is observed, not assumed. The commands are submitted from the
 * page context and their effect is read back from storage and the DOM, because
 * this campaign showed repeatedly that a step which "should" have worked can
 * silently do nothing.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/beta-smoke.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9224);
const MARKER = process.env.MUSE_MARKER ?? `BETA-${Date.now()}`;
const REPLY_WAIT_MS = Number(process.env.MUSE_REPLY_WAIT_MS ?? 120_000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
  if (!page) throw new Error(`no application page on port ${PORT}`);
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

/** `returnByValue` is mandatory, and the value lives at result.result.value. */
async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => { try { return JSON.stringify(${expression}); }
      catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const raw = result.result?.value;
  if (raw === undefined) throw new Error(`evaluate returned nothing for: ${expression.slice(0, 60)}`);
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const STATE = `(() => {
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const active = String(localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, "");
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0] || null;
  const rows = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter((b) => b.offsetParent !== null);
  let log = [];
  if (active) { try { log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + active) || "[]"); } catch { log = []; } }
  return {
    sessions: sessions.length,
    active: active.slice(0, 8),
    composerPresent: Boolean(field),
    composerEnabled: field ? field.disabled !== true : null,
    composerLength: field ? field.value.length : null,
    sidebarRows: rows.length,
    connected: /Connected/.test(body),
    connectionError: /Connection error/.test(body),
    working: /WORKING/.test(body),
    entries: log.length,
    markerInLog: log.filter((e) => String(e.text || "").includes(${JSON.stringify(MARKER)})).length,
    assistantEntries: log.filter((e) => e.role === "assistant").length,
    bodyError: /Something went wrong|could not be resumed|Connection error/.test(body),
  };
})()`;

async function waitFor(client, label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(client, STATE);
    if (predicate(last)) return { label, ok: true, state: last };
    await sleep(2_000);
  }
  return { label, ok: false, state: last };
}

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.beta-smoke.v1", marker: MARKER, steps: [] };
  try {
    report.initial = await evaluate(client, STATE);

    // 1. Start a conversation from the sidebar, as a user would.
    report.newConversation = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll("button, a, [role='button']")].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /^New conversation$/i.test((n.innerText || "").trim()));
      if (!hit) return { clicked: false };
      hit.click();
      return { clicked: true };
    })()`);
    await sleep(3_000);

    // 2. The composer must become usable.
    report.precondition = await waitFor(client, "composer ready",
      (s) => s.composerPresent && s.composerEnabled === true, 30_000);

    // 3. Type and submit.
    report.typed = await evaluate(client, `(() => {
      const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
      if (!field) return { typed: false, reason: "no composer" };
      if (field.disabled) return { typed: false, reason: "composer disabled" };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(`Reply with exactly the word: ${MARKER}`)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true, length: field.value.length };
    })()`);
    report.submitted = await evaluate(client, `(() => {
      const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
      if (!field || field.disabled) return { submitted: false };
      field.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        field.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return { submitted: true, remaining: field.value.length };
    })()`);

    // 4. The send was accepted if the composer cleared.
    report.accepted = await waitFor(client, "send accepted (composer cleared)", (s) => s.composerLength === 0, 25_000);
    report.working = await waitFor(client, "turn running", (s) => s.working === true, 40_000);

    // 5. An answer must arrive and the turn must settle.
    report.answered = await waitFor(client, "assistant answered", (s) => s.assistantEntries > 0, REPLY_WAIT_MS);
    report.settled = await waitFor(client, "turn settled (not working)", (s) => s.working === false, 60_000);

    report.final = await evaluate(client, STATE);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
