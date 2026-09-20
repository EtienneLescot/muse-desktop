#!/usr/bin/env node

/**
 * Measure the bounded transcript window on a synthetic long conversation
 * (M1-13): 2 000 persisted entries, then read the DOM window the app actually
 * mounts. Restores the original log afterwards.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-long-transcript.mjs [--entries 2000] [--keep]
 *
 * The measurement mutates one `localStorage` log key and reloads the page. The
 * original value is captured first and written back in a `finally` block, so a
 * failure does not leave the profile modified.
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const index = argv.indexOf("--entries");
const ENTRIES = index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : 2000;
const KEEP = argv.includes("--keep");
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
    if (frame.error) entry.reject(new Error(`${frame.method}: ${frame.error.message}`));
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

/** Read the transcript's observability attributes and mounted node count. */
const WINDOW_SNIPPET = `(() => {
  const host = document.querySelector('[data-entry-count]');
  if (!host) return { transcriptFound: false };
  const entries = host.querySelectorAll('[role="article"], article');
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    transcriptFound: true,
    dataEntryCount: host.getAttribute("data-entry-count"),
    dataWindowStart: host.getAttribute("data-window-start"),
    dataWindowEnd: host.getAttribute("data-window-end"),
    ariaLabel: host.getAttribute("aria-label"),
    ariaKeyshortcuts: host.getAttribute("aria-keyshortcuts"),
    mountedArticles: entries.length,
    mountedNodes: host.querySelectorAll("*").length,
    setsizeSample: entries[0] ? entries[0].getAttribute("aria-setsize") : null,
    posinsetSample: entries[0] ? entries[0].getAttribute("aria-posinset") : null,
    hasLoadOlder: /Load older messages/i.test(body),
    hasLatest: /Latest messages/i.test(body),
    hasFinder: /Find in conversation/i.test(body)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-long-transcript.v1", requestedEntries: ENTRIES, steps: {} };
  let restore = null;
  try {
    // Pick the conversation to lengthen: the active one, else the first log key.
    const picked = await evaluate(client, `(() => {
      const active = localStorage.getItem("muse-desktop.active.v1");
      const id = active ? active.replace(/^"|"$/g, "") : null;
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.log.v1."));
      const key = (id && localStorage.getItem("muse-desktop.log.v1." + id)) ? "muse-desktop.log.v1." + id : keys[0];
      return { key, sessionId: key ? key.replace("muse-desktop.log.v1.", "") : null, logKeys: keys.length };
    })()`);
    report.target = picked;
    if (!picked.key) throw new Error("no transcript log key found in localStorage");

    const original = await evaluate(client, `localStorage.getItem(${JSON.stringify(picked.key)})`);
    restore = { key: picked.key, value: original };
    report.original = { bytes: (original ?? "").length, entries: (() => { try { return JSON.parse(original ?? "[]").length; } catch { return null; } })() };

    // Build a long log with the shape the app persists.
    const written = await evaluate(client, `(() => {
      const base = (() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(picked.key)}) || "[]"); } catch { return []; } })();
      const first = base[0] || { clientMessageId: "seed", id: "seed-0", role: "user", text: "seed", ts: Date.now() };
      const now = Date.now();
      const entries = [];
      for (let i = 0; i < ${ENTRIES}; i += 1) {
        entries.push({
          clientMessageId: "long-" + i,
          id: "long-" + i,
          role: i % 2 === 0 ? "user" : "assistant",
          text: "Long transcript entry " + i + " — filler line to give the window something to measure.",
          ts: now - (${ENTRIES} - i) * 1000
        });
      }
      localStorage.setItem(${JSON.stringify(picked.key)}, JSON.stringify(entries));
      return { entries: entries.length, bytes: JSON.stringify(entries).length, seedUsed: first ? true : false };
    })()`);
    report.written = written;

    // Reload so boot hydration reads the new log.
    await client.send("Page.enable").catch(() => undefined);
    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(12_000);

    // Open the lengthened conversation.
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const withCount = nodes.find((n) => /Long transcript entry 0/i.test(n.innerText || "")) || nodes[0];
      return { found: Boolean(withCount) };
    })()`);
    report.afterReload = await evaluate(client, WINDOW_SNIPPET);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    if (restore && !KEEP) {
      const restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        return { key: ${JSON.stringify(restore.key)}, bytes: (localStorage.getItem(${JSON.stringify(restore.key)}) || "").length };
      })()`).catch((error) => ({ error: String(error.message || error) }));
      report.restored = restored;
      await evaluate(client, "location.reload()").catch(() => undefined);
    } else if (restore && KEEP) {
      report.restored = "skipped (--keep)";
    }
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
