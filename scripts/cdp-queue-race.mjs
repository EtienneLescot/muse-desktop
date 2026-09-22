#!/usr/bin/env node

/**
 * Exercise a queue race (M1-10): queue two turns, then remove them repeatedly
 * while the first turn is still running, and check that no removed turn ever
 * starts.
 *
 * The previous pass only proved a sequential removal. Here the removal is fired
 * from *inside the page context* in a single evaluation, because separate CDP
 * round-trips add tens of milliseconds each and make a real race impossible to
 * aim at.
 *
 * Preconditions are waited for, not assumed — three earlier attempts in this
 * campaign failed precisely by acting on an unverified state.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-queue-race.mjs
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const FIRST = "Count slowly from one to forty, one number per line.";
const QUEUED_A = "RACE-QUEUED-A-3311 say ALPHA";
const QUEUED_B = "RACE-QUEUED-B-7722 say BETA";
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

/** Queue size in storage, plus whether the removed markers ever reached the log. */
const STATE = `(() => {
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0] || null;
  let queued = {};
  try { queued = JSON.parse(localStorage.getItem("muse-desktop.queued-turns.v1") || "{}"); } catch { queued = {}; }
  let rows = 0;
  const texts = [];
  for (const list of Object.values(queued)) {
    if (!Array.isArray(list)) continue;
    rows += list.length;
    for (const item of list) texts.push(String(item.text || "").slice(0, 28));
  }
  const active = (localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, "");
  let log = [];
  try { log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + active) || "[]"); } catch { log = []; }
  const joined = log.map((e) => String(e.text || "")).join("\\n");
  return {
    queuedRows: rows,
    queuedTexts: texts,
    panelVisible: /Queued messages/i.test(body),
    removeButtons: [...document.querySelectorAll("button")].filter((b) => /remove from queue/i.test(b.innerText || "")).length,
    working: /WORKING/.test(body),
    composerLength: field ? field.value.length : null,
    logEntries: log.length,
    raceAInLog: joined.includes("RACE-QUEUED-A-3311"),
    raceBInLog: joined.includes("RACE-QUEUED-B-7722"),
    removeAllInBody: /Remove all/i.test(body)
  };
})()`;

const readState = (client) => evaluate(client, STATE);

async function waitFor(client, label, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readState(client);
    if (predicate(last)) return { label, ok: true, state: last };
    await sleep(1_000);
  }
  return { label, ok: false, state: last };
}

const type = (client, text) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field) return { ok: false, reason: "no composer" };
  if (field.disabled) return { ok: false, reason: "composer disabled" };
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  return { ok: true, length: field.value.length };
})()`);

const submit = (client) => evaluate(client, `(() => {
  const field = [...document.querySelectorAll("textarea")].filter((f) => f.offsetParent !== null)[0];
  if (!field) return { submitted: false, reason: "no composer" };
  if (field.disabled) return { submitted: false, reason: "composer disabled" };
  if (field.value.length === 0) return { submitted: false, reason: "composer empty" };
  // The real send button is the only reliable submission path: synthetic Enter
  // can fire twice (key handlers on keydown and keyup duplicate the queued turn)
  // or zero times (the handler misses it and the text stays in the composer).
  field.focus();
  const send = document.querySelector("button.send");
  if (!send) return { submitted: false, reason: "no send button" };
  if (send.disabled) return { submitted: false, reason: "send button disabled" };
  send.click();
  return { submitted: true, via: "send-button", remaining: field.value.length };
})()`);

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-queue-race.v1", preconditions: [], steps: [] };
  try {
    report.open = await evaluate(client, `(() => {
      const needle = ${JSON.stringify(process.env.MUSE_RACE_SESSION ?? "Count slowly")};
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => new RegExp(needle, "i").test((n.title || "") + " " + (n.innerText || "")));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true, label: (hit.title || hit.innerText || "").slice(0, 60) };
    })()`);
    await sleep(3_500);

    report.preconditions.push(await waitFor(client, "composer vide et connecté",
      (s) => s.composerLength === 0 && s.queuedRows === 0));

    // First turn must actually be running before anything can be queued.
    await type(client, FIRST);
    await submit(client);
    report.preconditions.push(await waitFor(client, "premier tour en cours", (s) => s.working === true, 40_000));

    // Queue two turns.
    await type(client, QUEUED_A);
    await submit(client);
    await waitFor(client, "A en file", (s) => s.queuedRows >= 1, 30_000);
    await type(client, QUEUED_B);
    await submit(client);
    report.preconditions.push(await waitFor(client, "deux tours en file", (s) => s.queuedRows >= 2, 30_000));
    report.steps.push({ label: "two-queued", ...(await readState(client)) });

    // THE RACE: remove every queued entry, and keep removing for a moment, from
    // one evaluation so the clicks cannot be spread by CDP round-trips.
    // THE RACE: remove every queued entry, and keep removing for a moment, from
    // one evaluation so the clicks cannot be spread by CDP round-trips. The
    // result is parked on window because evaluate() wraps its expression in
    // JSON.stringify, which flattens an async IIFE's resolution to {}.
    await evaluate(client, `(async () => {
      const click = () => {
        const button = [...document.querySelectorAll("button")].find((b) => /remove from queue/i.test(b.innerText || ""));
        if (!button) return false;
        button.click();
        return true;
      };
      const attempts = [];
      for (let i = 0; i < 12; i += 1) {
        attempts.push(click());
        await new Promise((r) => setTimeout(r, 90));
      }
      window.__queueRace = { clicks: attempts.filter(Boolean).length, attempts: attempts.length };
      return true;
    })()`);
    report.race = await evaluate(client, `(() => window.__queueRace || null)()`);

    await sleep(2_000);
    report.steps.push({ label: "after-race", ...(await readState(client)) });
    await sleep(8_000);
    report.steps.push({ label: "after-race-settled", ...(await readState(client)) });
    await sleep(10_000);
    report.steps.push({ label: "later", ...(await readState(client)) });
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
