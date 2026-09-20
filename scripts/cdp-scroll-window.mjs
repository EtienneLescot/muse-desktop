#!/usr/bin/env node

/**
 * Exercise the incremental loading of older transcript entries (M1-13) on a
 * synthetic long conversation: scroll to the top, then observe the window move
 * and the DOM stay bounded.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-scroll-window.mjs [--entries 2000]
 *
 * Mutates one `localStorage` log key and reloads twice; the original value is
 * captured first and restored in a `finally` block.
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const index = argv.indexOf("--entries");
const ENTRIES = index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : 2000;
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

/** Window attributes plus the scroll metrics of the transcript container. */
const STATE = `(() => {
  const host = document.querySelector('[data-entry-count]');
  if (!host) return { transcriptFound: false };
  const articles = host.querySelectorAll('[role="article"], article');
  const first = articles[0];
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    transcriptFound: true,
    dataEntryCount: Number(host.getAttribute("data-entry-count")),
    windowStart: Number(host.getAttribute("data-window-start")),
    windowEnd: Number(host.getAttribute("data-window-end")),
    mountedArticles: articles.length,
    domNodes: host.querySelectorAll("*").length,
    firstPosinset: first ? Number(first.getAttribute("aria-posinset")) : null,
    firstEntryLabel: first ? (first.innerText || "").replace(/\\s+/g, " ").slice(0, 46) : null,
    scrollTop: Math.round(host.scrollTop),
    scrollHeight: Math.round(host.scrollHeight),
    clientHeight: Math.round(host.clientHeight),
    atTop: host.scrollTop < 120,
    hasLoadOlderButton: /Load older messages/i.test(body)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-scroll-window.v1", requestedEntries: ENTRIES, steps: [] };
  let restore = null;
  try {
    const picked = await evaluate(client, `(() => {
      const active = localStorage.getItem("muse-desktop.active.v1");
      const id = active ? active.replace(/"/g, "") : null;
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.log.v1."));
      const key = id && localStorage.getItem("muse-desktop.log.v1." + id) ? "muse-desktop.log.v1." + id : keys[0];
      return { key, original: key ? localStorage.getItem(key) : null };
    })()`);
    if (!picked.key) throw new Error("no transcript log key found");
    restore = { key: picked.key, value: picked.original };
    report.target = { key: picked.key, originalBytes: (picked.original ?? "").length };

    await evaluate(client, `(() => {
      const now = Date.now();
      const entries = [];
      for (let i = 0; i < ${ENTRIES}; i += 1) {
        entries.push({
          clientMessageId: "long-" + i, id: "long-" + i,
          role: i % 2 === 0 ? "user" : "assistant",
          text: "Entry " + i + " of the synthetic long conversation.",
          ts: now - (${ENTRIES} - i) * 1000
        });
      }
      localStorage.setItem(${JSON.stringify(picked.key)}, JSON.stringify(entries));
      return entries.length;
    })()`);
    await commit(await evaluate(client, "location.reload()").catch(() => null), client);
    await sleep(12_000);
    report.steps.push({ label: "initial", ...(await evaluate(client, STATE)) });

    // Scroll to the top: `onScroll` calls loadOlderMessages when scrollTop < 120.
    for (let round = 1; round <= 3; round += 1) {
      await evaluate(client, `(() => {
        const host = document.querySelector('[data-entry-count]');
        if (!host) return null;
        host.scrollTop = 0;
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        return host.scrollTop;
      })()`);
      await sleep(2_500);
      report.steps.push({ label: `after-scroll-${round}`, ...(await evaluate(client, STATE)) });
    }

    // The explicit affordance, as a second path.
    const clicked = await evaluate(client, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /Load older messages/i.test(b.innerText || ''));
      if (!btn) return { clicked: false };
      btn.click();
      return { clicked: true, label: (btn.innerText || '').trim() };
    })()`);
    report.loadOlderButton = clicked;
    await sleep(2_500);
    report.steps.push({ label: "after-button", ...(await evaluate(client, STATE)) });
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    if (restore) {
      report.restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        return (localStorage.getItem(${JSON.stringify(restore.key)}) || "").length;
      })()`).catch((error) => ({ error: String(error.message || error) }));
      await evaluate(client, "location.reload()").catch(() => undefined);
    }
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** Reloading drops the CDP execution context; nothing to await but the call. */
async function commit(result) { return result; }

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
