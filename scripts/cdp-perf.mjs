#!/usr/bin/env node

/**
 * Measure render cost for a long transcript (M1-13).
 *
 * The roadmap conditions full sidebar virtualisation on "a real memory and
 * render-time measurement", so this records what the engine reports rather than
 * guessing: navigation timing, the CDP performance metrics delta around a
 * transcript of 2 000 entries, and the mounted DOM size.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-perf.mjs [--entries 2000]
 *
 * Mutates one `localStorage` log key and reloads; the original value is
 * captured first and restored in a `finally` block.
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : fallback;
};
const ENTRIES = argOf("--entries", 2000);
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

/** Keep only the metrics that describe render cost, rounded. */
function pickMetrics(result) {
  const wanted = new Set([
    "Nodes", "Documents", "LayoutCount", "RecalcStyleCount",
    "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration",
    "JSHeapUsedSize", "JSHeapTotalSize", "DomContentLoaded",
  ]);
  const out = {};
  for (const metric of result?.metrics ?? []) {
    if (!wanted.has(metric.name)) continue;
    out[metric.name] = metric.name.endsWith("Size")
      ? Math.round(metric.value / 1024) + " KiB"
      : Math.round(metric.value * 1000) / 1000;
  }
  return out;
}

const DOM_SNIPPET = `(() => {
  const host = document.querySelector('[data-entry-count]');
  const arts = host ? host.querySelectorAll('[role="article"], article') : [];
  return {
    transcriptFound: Boolean(host),
    dataEntryCount: host ? Number(host.getAttribute("data-entry-count")) : null,
    mountedArticles: arts.length,
    domNodesInTranscript: host ? host.querySelectorAll("*").length : null,
    totalDomNodes: document.querySelectorAll("*").length,
    scrollHeight: host ? Math.round(host.scrollHeight) : null
  };
})()`;

const NAVIGATION_SNIPPET = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  if (!nav) return null;
  const paint = performance.getEntriesByType("paint");
  const fcp = paint.find((p) => p.name === "first-contentful-paint");
  return {
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    loadEventMs: Math.round(nav.loadEventEnd),
    firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : null,
    domInteractiveMs: Math.round(nav.domInteractive)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-perf.v1", entries: ENTRIES };
  let restore = null;
  try {
    await client.send("Performance.enable").catch(() => undefined);

    // Baseline on the real profile before touching anything.
    report.baselineMetrics = pickMetrics(await client.send("Performance.getMetrics"));
    report.baselineDom = await evaluate(client, DOM_SNIPPET);
    report.baselineNavigation = await evaluate(client, NAVIGATION_SNIPPET);

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
          text: "Entry " + i + " of the synthetic long conversation, written to give the window something to render.",
          ts: now - (${ENTRIES} - i) * 1000
        });
      }
      localStorage.setItem(${JSON.stringify(picked.key)}, JSON.stringify(entries));
      return { entries: entries.length, bytes: JSON.stringify(entries).length };
    })()`).then((written) => { report.written = written; });

    const startedAt = Date.now();
    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(14_000);
    report.wallClockToSettledMs = Date.now() - startedAt;

    report.loadedMetrics = pickMetrics(await client.send("Performance.getMetrics"));
    report.loadedDom = await evaluate(client, DOM_SNIPPET);
    report.loadedNavigation = await evaluate(client, NAVIGATION_SNIPPET);

    // Cost of one incremental page of 120 older entries.
    const before = pickMetrics(await client.send("Performance.getMetrics"));
    await evaluate(client, `(() => { const h = document.querySelector('[data-entry-count]'); if (h) { h.scrollTop = 0; h.dispatchEvent(new Event('scroll', { bubbles: true })); } return true; })()`);
    await sleep(3_500);
    const after = pickMetrics(await client.send("Performance.getMetrics"));
    report.incrementalPage = {
      domAfter: await evaluate(client, DOM_SNIPPET),
      layoutDelta: Number(after.LayoutDuration) - Number(before.LayoutDuration),
      styleDelta: Number(after.RecalcStyleDuration) - Number(before.RecalcStyleDuration),
      scriptDelta: Number(after.ScriptDuration) - Number(before.ScriptDuration)
    };
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    if (restore) {
      report.restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        const value = localStorage.getItem(${JSON.stringify(restore.key)}) || "";
        return { bytes: value.length, hasSynthetic: value.includes("long-") };
      })()`).catch((error) => ({ error: String(error.message || error) }));
      await evaluate(client, "location.reload()").catch(() => undefined);
    }
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
