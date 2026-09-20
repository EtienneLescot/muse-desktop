#!/usr/bin/env node

/**
 * Exercise the in-conversation finder jumping to a hit that sits outside the
 * mounted DOM window (M1-13).
 *
 * Previous attempt failed on a bad selector: it matched the finder *container*
 * (`.stream-find`, which carries the text "Find in conversation") instead of an
 * opener, so the click closed the finder and no search field was ever mounted.
 * This version opens it with the documented Ctrl+F shortcut -- already proven
 * bound in the M0-12 evidence -- and targets the field by its `aria-label`.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-finder-jump.mjs [--entries 2000] [--index 137]
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
const NEEDLE_INDEX = argOf("--index", 137);
const NEEDLE = `FINDER-NEEDLE-${NEEDLE_INDEX}`;
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

const STATE = `(() => {
  const host = document.querySelector('[data-entry-count]');
  const arts = host ? host.querySelectorAll('[role="article"], article') : [];
  const field = document.querySelector('input[aria-label="Search messages"]');
  const body = (document.body.innerText || "").replace(/\\s+/g, " ");
  return {
    windowStart: host ? Number(host.getAttribute("data-window-start")) : null,
    windowEnd: host ? Number(host.getAttribute("data-window-end")) : null,
    mountedArticles: arts.length,
    firstPosinset: arts[0] ? Number(arts[0].getAttribute("aria-posinset")) : null,
    needleInWindow: (host ? host.innerText : "").includes("FINDER-NEEDLE"),
    searchFieldPresent: Boolean(field),
    searchFieldValue: field ? field.value : null,
    bodyHasNeedleText: /FINDER-NEEDLE/.test(body)
  };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-finder-jump.v1", needleIndex: NEEDLE_INDEX, entries: ENTRIES, steps: [] };
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
          text: i === ${NEEDLE_INDEX}
            ? ${JSON.stringify(NEEDLE)} + " unique marker placed outside the mounted window"
            : "Entry " + i + " of the synthetic long conversation.",
          ts: now - (${ENTRIES} - i) * 1000
        });
      }
      localStorage.setItem(${JSON.stringify(picked.key)}, JSON.stringify(entries));
      return entries.length;
    })()`);
    await evaluate(client, "location.reload()").catch(() => undefined);
    await sleep(12_000);
    report.steps.push({ label: "initial", ...(await evaluate(client, STATE)) });

    // Open the finder with the documented shortcut, then type into the field.
    const base = { key: "f", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, modifiers: 2 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, modifiers: 2 });
    await sleep(1_200);
    report.steps.push({ label: "ctrl-f", ...(await evaluate(client, STATE)) });

    const typed = await evaluate(client, `(() => {
      const field = document.querySelector('input[aria-label="Search messages"]');
      if (!field) return { typed: false };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${JSON.stringify(NEEDLE)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return { typed: true, value: field.value };
    })()`);
    report.typed = typed;
    await sleep(1_500);
    report.steps.push({ label: "query", ...(await evaluate(client, STATE)) });

    report.hits = await evaluate(client, `(() => {
      const options = [...document.querySelectorAll('[role="option"]')];
      return { optionCount: options.length, labels: options.slice(0, 4).map((o) => (o.innerText || "").trim().slice(0, 50)) };
    })()`);
    report.steps.push({ label: "hits", ...(await evaluate(client, STATE)) });

    // Activate the first hit: Enter on the field, then a click as fallback.
    const enterBase = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...enterBase });
    await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...enterBase });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...enterBase });
    await sleep(2_500);
    report.steps.push({ label: "after-enter", ...(await evaluate(client, STATE)) });

    report.clicked = await evaluate(client, `(() => {
      const option = document.querySelector('[role="option"]');
      if (!option) return { clicked: false };
      option.click();
      return { clicked: true, label: (option.innerText || "").trim().slice(0, 50) };
    })()`);
    await sleep(2_500);
    report.steps.push({ label: "after-click", ...(await evaluate(client, STATE)) });
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    if (restore) {
      report.restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        const value = localStorage.getItem(${JSON.stringify(restore.key)}) || "";
        return { bytes: value.length, hasSynthetic: value.includes("long-"), hasNeedle: value.includes("FINDER-NEEDLE") };
      })()`).catch((error) => ({ error: String(error.message || error) }));
      await evaluate(client, "location.reload()").catch(() => undefined);
    }
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
