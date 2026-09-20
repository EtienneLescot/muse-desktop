#!/usr/bin/env node

/**
 * Exercise an IME composition on the composer (M0-03, "IME" criterion).
 *
 * The realistic risk is not that text is lost, it is that a committed
 * composition gets sent when the user only meant to confirm it: with an IME,
 * Enter commits the candidate, it does not submit. This script drives a real
 * composition through CDP's `Input.imeSetComposition` and then presses Enter
 * *while the composition is active*, and measures what the app did.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-ime-compose.mjs
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

/** Composer value plus any composition events observed since the last reset. */
const STATE = `(() => {
  const field = document.querySelector("textarea");
  const host = document.querySelector("[data-entry-count]");
  const active = localStorage.getItem("muse-desktop.active.v1");
  return {
    activeId: active ? active.replace(/"/g, "") : null,
    composerValue: field ? field.value : null,
    composerChars: field ? field.value.length : null,
    composing: field ? field.dataset.imeProbe === "composing" : null,
    entryCount: host ? Number(host.getAttribute("data-entry-count")) : null,
    events: window.__imeEvents || []
  };
})()`;

/** Record real composition events on the composer so we observe, not assume. */
const INSTALL_LISTENER = `(() => {
  const field = document.querySelector("textarea");
  if (!field) return { installed: false };
  if (field.dataset.imeProbe === "listening") return { installed: true, already: true };
  window.__imeEvents = [];
  for (const name of ["compositionstart", "compositionupdate", "compositionend"]) {
    field.addEventListener(name, (e) => {
      window.__imeEvents.push({ type: name, data: e.data === undefined ? null : String(e.data).slice(0, 20) });
    });
  }
  field.dataset.imeProbe = "listening";
  return { installed: true };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-ime-compose.v1", steps: [] };
  const record = async (label) => { report.steps.push({ label, ...(await evaluate(client, STATE)) }); };

  try {
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => /Enumerate the three Musketeers/i.test(n.innerText || ""));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true };
    })()`);
    await sleep(3_500);
    await record("opened");

    report.listener = await evaluate(client, INSTALL_LISTENER);
    report.focus = await evaluate(client, `(() => {
      const field = document.querySelector("textarea");
      if (!field) return { focused: false };
      field.focus();
      window.__imeEvents = [];
      return { focused: document.activeElement === field, disabled: field.disabled };
    })()`);

    // Compose hiragana, then commit to kanji.
    await client.send("Input.imeSetComposition", {
      text: "にほんご", selectionStart: 4, selectionEnd: 4, replacementStart: 0, replacementEnd: 0
    });
    await sleep(700);
    await record("composing-hiragana");

    // ENTER WHILE COMPOSING: with an IME this confirms the candidate, it must
    // not submit the message.
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...enter });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    await sleep(1_500);
    await record("after-enter-during-composition");

    // Commit the composition explicitly.
    await client.send("Input.insertText", { text: "日本語" });
    await sleep(800);
    await record("after-commit");

    // Now a real submit, to confirm the committed text is what gets sent.
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...enter });
    await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...enter });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    await sleep(3_000);
    await record("after-real-submit");

    report.logAfter = await evaluate(client, `(() => {
      const active = localStorage.getItem("muse-desktop.active.v1");
      const id = active ? active.replace(/"/g, "") : null;
      let log = [];
      try { log = JSON.parse(localStorage.getItem("muse-desktop.log.v1." + id) || "[]"); } catch { log = []; }
      const hits = log.filter((e) => (e.text || "").includes("日本語"));
      return { logEntries: log.length, japaneseHits: hits.length, roles: hits.map((h) => h.role), texts: hits.map((h) => (h.text || "").slice(0, 30)) };
    })()`);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
