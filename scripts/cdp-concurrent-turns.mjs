#!/usr/bin/env node

/**
 * Concurrent-turn isolation scenario for M0-01 / M0-14, driven through CDP.
 *
 * Starts a long turn in one project, starts a second turn in another project,
 * then waits while the caller kills one host. The script only observes: it does
 * not terminate processes itself.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-concurrent-turns.mjs [--live]
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const LIVE = argv.includes("--live");
const SESSION_A = process.env.MUSE_SESSION_A ?? "Enumerate the three Musketeers";
const SESSION_B = process.env.MUSE_SESSION_B ?? "ISOLATED";
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
  const text = (n) => ((n.innerText || n.getAttribute("aria-label") || n.getAttribute("title") || "").trim());
  const all = () => nodes('button, a, [role="button"], [role="tab"]');
  const clickText = (want) => {
    const hit = all().find((n) => text(n) === want)
      || all().find((n) => text(n).toLowerCase().includes(want.toLowerCase()));
    if (!hit) return false;
    hit.click();
    return true;
  };
  const composer = () => nodes('textarea, [contenteditable="true"]')[0] || null;
  const setField = (f, v) => {
    const P = f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(f, v);
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.focus();
  };
  const snap = () => {
    const body = (document.body.innerText || "").replace(/\\s+/g, " ");
    const f = composer();
    const s = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
    return {
      title: (document.querySelector("h1") || {}).innerText ? document.querySelector("h1").innerText.slice(0, 52) : null,
      connected: /Connected/.test(body), disconnected: /Disconnected/.test(body),
      connectionError: /Connection error/.test(body),
      working: /WORKING/.test(body), stale: /No recent host update/.test(body),
      stopping: /Stopping/.test(body),
      completed: (body.match(/Completed/g) || []).length,
      running: (body.match(/Running/g) || []).length,
      composerDisabled: f ? f.disabled === true : null,
      composerEmpty: f ? (f.value || "").length === 0 : null,
      sessionCount: s.length,
      tail: body.slice(-190)
    };
  };
`;

const openConversation = (client, needle) => evaluate(client, `(() => {
  ${HELPERS}
  const hit = all().find((n) => text(n).toLowerCase().includes(${JSON.stringify(needle)}.toLowerCase()));
  if (!hit) return { opened: false, needle: ${JSON.stringify(needle)} };
  hit.click();
  return { opened: true, label: text(hit).slice(0, 46) };
})()`);

const snapshot = (client) => evaluate(client, `(() => { ${HELPERS} return snap(); })()`);

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-concurrent-turns.v1", live: LIVE, phase: argv[2] ?? null, steps: [] };
  const record = async (label) => {
    const value = await snapshot(client);
    report.steps.push({ label, at: new Date().toISOString().slice(11, 19), ...value });
    return value;
  };
  const startTurn = () => evaluate(client, `(() => {
    ${HELPERS}
    const f = composer();
    if (!f) return { filled: false, reason: "no composer" };
    if (f.disabled) return { filled: false, reason: "composer disabled" };
    setField(f, "Count slowly from one to sixty, one number per line, nothing else.");
    const sent = clickText("Stop") ? "stop-visible" : (clickText("Send") || clickText("Start") ? "clicked" : "no-button");
    return { filled: true, sent };
  })()`);

  try {
    // A long turn per project, in sequence, so both can be running at once.
    report.openA = await openConversation(client, SESSION_A);
    await sleep(3_000);
    report.startA = await startTurn();
    await sleep(2_500);
    await record("A/running");

    report.openB = await openConversation(client, SESSION_B);
    await sleep(3_000);
    report.startB = await startTurn();
    await sleep(2_500);
    await record("B/running");

    // Give the caller time to kill one host, then report both conversations.
    if (argv.includes("--wait-kill")) {
      report.killWindowSeconds = 25;
      for (let second = 0; second < 25; second += 5) {
        await sleep(5_000);
        await record(`during/${second + 5}s`);
      }
    }

    report.backToA = await openConversation(client, SESSION_A);
    await sleep(3_000);
    await record("A/after");

    report.backToB = await openConversation(client, SESSION_B);
    await sleep(3_000);
    await record("B/after");
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
