#!/usr/bin/env node

/**
 * Delete leftover test conversations through the app's own Delete dialog.
 *
 * Why the earlier attempts failed, all three for different reasons:
 *
 *   1. Rewriting `localStorage` did not stick — the app held its own copy of the
 *      session list and wrote it back, and the native side re-introduced the
 *      sessions on the next page load. Only the app's own Delete action kills
 *      the session, as its tooltip says: "Kill session and delete its local
 *      history".
 *   2. The dialog is opened by the per-row **Actions** button
 *      (`aria-label="Actions for …"`), which calls `showModal()`. An earlier
 *      version hunted for a context menu that does not exist.
 *   3. A `Runtime.evaluate` call missing `returnByValue` returns a remote object
 *      reference, so the caller sees `undefined` and cannot tell it apart from a
 *      failure.
 *
 * Safety rule: only rows labelled `Actions for New conversation` are selected.
 * A session that produced a real turn carries a descriptive title and is never
 * touched.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-delete-conversations.mjs            # dry run, 1 row
 *   node scripts/cdp-delete-conversations.mjs --apply    # delete every stub
 */
import { exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9223);
const APPLY = process.argv.includes("--apply");
const MAX_DELETIONS = Number(process.env.MUSE_MAX_DELETIONS ?? 40);
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
    close() { try { socket.close(); } catch { /* closed */ } }
  };
}

/** `returnByValue` is mandatory: without it the value is a remote reference. */
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
  const rows = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter((b) => b.offsetParent !== null);
  const labels = rows.map((b) => b.getAttribute("aria-label") || "");
  return {
    rowCount: labels.length,
    stubs: labels.filter((l) => /Actions for New conversation$/i.test(l) || /Actions for Session /i.test(l)).length,
    titled: labels.filter((l) => !/Actions for New conversation$/i.test(l) && !/Actions for Session /i.test(l)).map((l) => l.replace("Actions for ", "").slice(0, 44)),
    dialogOpen: Boolean(document.querySelector("dialog[open]"))
  };
})()`;

/** Open the Actions dialog for the first stub row. */
const OPEN_DIALOG = `(() => {
  const rows = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter((b) => b.offsetParent !== null);
  const stub = rows.find((b) => {
    const label = b.getAttribute("aria-label") || "";
    return /Actions for New conversation$/i.test(label) || /Actions for Session /i.test(label);
  });
  if (!stub) return { opened: false, reason: "no stub row", labels: rows.map((b) => b.getAttribute("aria-label")) };
  stub.click();
  return { opened: true, label: stub.getAttribute("aria-label") };
})()`;

const CLICK_DELETE = `(() => {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return { clicked: false, reason: "no open dialog" };
  const button = [...dialog.querySelectorAll("button")].find((b) => /^Delete…$/.test((b.innerText || "").trim()));
  if (!button) return { clicked: false, buttons: [...dialog.querySelectorAll("button")].map((b) => (b.innerText || "").trim()) };
  button.click();
  return { clicked: true };
})()`;

const CLICK_CONFIRM = `(() => {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) return { clicked: false, reason: "no open dialog" };
  const button = [...dialog.querySelectorAll("button")].find((b) => /^Delete conversation$/.test((b.innerText || "").trim()));
  if (!button) return { clicked: false, buttons: [...dialog.querySelectorAll("button")].map((b) => (b.innerText || "").trim()) };
  button.click();
  return { clicked: true };
})()`;

const SESSION_COUNT = `(() => {
  const stored = JSON.parse(localStorage.getItem("muse-desktop.sessions.v1") || "[]");
  return { stored: stored.length };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-delete-conversations.v1", apply: APPLY, steps: [] };
  try {
    report.before = await evaluate(client, INVENTORY);
    report.storedBefore = await evaluate(client, SESSION_COUNT);

    // Always exercise one row first, so a dry run proves the whole path.
    report.open = await evaluate(client, OPEN_DIALOG);
    await sleep(700);
    report.dialogOpen = await evaluate(client, INVENTORY);
    report.deleteButton = await evaluate(client, CLICK_DELETE);
    await sleep(600);
    report.confirmButton = await evaluate(client, CLICK_CONFIRM);
    await sleep(1_600);
    report.afterFirst = await evaluate(client, INVENTORY);

    if (!APPLY) {
      report.note = "dry run — one row deleted; pass --apply to continue";
    } else {
      let guard = 1;
      let inventory = report.afterFirst;
      while (inventory.stubs > 0 && guard < MAX_DELETIONS) {
        const opened = await evaluate(client, OPEN_DIALOG);
        if (!opened.opened) { report.steps.push({ stopped: opened }); break; }
        await sleep(700);
        const del = await evaluate(client, CLICK_DELETE);
        if (!del.clicked) { report.steps.push({ stopped: { step: "delete", ...del } }); break; }
        await sleep(600);
        const confirm = await evaluate(client, CLICK_CONFIRM);
        if (!confirm.clicked) { report.steps.push({ stopped: { step: "confirm", ...confirm } }); break; }
        await sleep(1_600);
        const previous = inventory.stubs;
        inventory = await evaluate(client, INVENTORY);
        report.steps.push({ attempt: guard, stubs: inventory.stubs, titled: inventory.titled });
        if (inventory.stubs >= previous) { report.steps.push({ stopped: "stub count did not decrease" }); break; }
        guard += 1;
      }
      report.after = inventory;
      report.storedAfter = await evaluate(client, SESSION_COUNT);
    }
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
