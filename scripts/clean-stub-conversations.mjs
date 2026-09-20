#!/usr/bin/env node

/**
 * Remove the leftover untitled test conversations from the app's session store.
 *
 * Earlier attempts and why this one is shaped the way it is:
 *
 *   1. Rewriting storage while the app ran did not stick — the app held its own
 *      copy of the session list and wrote it back, resurrecting what was
 *      removed. Hence: the app is stopped first.
 *   2. Driving the sidebar's Delete button does not work headlessly: it only
 *      renders once the collapsible details panel is open, and the async page
 *      evaluation used to click through it returned an empty result.
 *   3. A `Runtime.evaluate` call missing `returnByValue` yields `undefined`
 *      rather than the value, which silently looked like a failure.
 *
 * Safety rule: only sessions whose title is **still the generic placeholder**
 * (`Session <first 8 chars of the id>`) are removed. A session acquires a
 * descriptive title only once a turn has produced one, so a descriptive title
 * means real work and is never touched.
 *
 * Usage (the app must be closed):
 *   node scripts/clean-stub-conversations.mjs            # dry run
 *   node scripts/clean-stub-conversations.mjs --apply    # delete
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9223);
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error(`no CDP page target on port ${PORT}`);
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

/**
 * Evaluate an expression and return its value.
 *
 * `returnByValue` is required: without it CDP hands back a remote object
 * reference and the caller sees `undefined`, which is indistinguishable from the
 * expression having failed.
 */
async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => { try { return JSON.stringify(${expression}); }
      catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const INVENTORY = `(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const active = String(localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, "");
  const isStub = (s) => String(s.title || "") === "Session " + String(s.session_id || "").slice(0, 8);
  return {
    count: sessions.length,
    active: active.slice(0, 8),
    activeIsStub: sessions.some((s) => String(s.session_id) === active && isStub(s)),
    stubs: sessions.filter(isStub).map((s) => String(s.session_id).slice(0, 8)),
    kept: sessions.filter((s) => !isStub(s)).map((s) => String(s.title || "").slice(0, 44))
  };
})()`;

const CLEAN = `(() => {
  const sessions = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  const isStub = (s) => String(s.title || "") === "Session " + String(s.session_id || "").slice(0, 8);
  const keep = sessions.filter((s) => !isStub(s));
  const dropIds = sessions.filter(isStub).map((s) => String(s.session_id));

  let removedKeys = 0;
  const prefixes = ["muse-desktop.log.v1.", "muse-desktop.outbox.v1.", "muse-desktop.git-turn.v1.", "muse-desktop.draft."];
  for (const key of Object.keys(localStorage)) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix) && dropIds.includes(key.slice(prefix.length))) {
        localStorage.removeItem(key);
        removedKeys += 1;
      }
    }
  }
  try {
    const queued = JSON.parse(localStorage.getItem("muse-desktop.queued-turns.v1") || "{}");
    for (const id of dropIds) delete queued[id];
    localStorage.setItem("muse-desktop.queued-turns.v1", JSON.stringify(queued));
  } catch { /* ignore malformed queue */ }

  localStorage.setItem("muse-desktop.sessions.v1", JSON.stringify(keep));
  const keepIds = keep.map((s) => String(s.session_id));
  const active = String(localStorage.getItem("muse-desktop.active.v1") || "").replace(/"/g, "");
  if (!keepIds.includes(active) && keepIds.length) {
    localStorage.setItem("muse-desktop.active.v1", JSON.stringify(keepIds[0]));
  }
  return { removed: dropIds.length, removedKeys, kept: keep.length };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.clean-stub-conversations.v1", apply: APPLY };
  try {
    report.before = await evaluate(client, INVENTORY);
    if (APPLY) {
      report.clean = await evaluate(client, CLEAN);
      await sleep(1_200);
      report.after = await evaluate(client, INVENTORY);
    } else {
      report.note = "dry run — pass --apply to delete";
    }
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
