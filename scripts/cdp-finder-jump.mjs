#!/usr/bin/env node

/**
 * Exercise the in-conversation finder jumping to a hit that sits outside the
 * mounted DOM window (M1-13), once per motion preference.
 *
 * Previous attempt failed on a bad selector: it matched the finder *container*
 * (`.stream-find`, which carries the text "Find in conversation") instead of an
 * opener, so the click closed the finder and no search field was ever mounted.
 * This version opens it with the documented Ctrl+F shortcut -- already proven
 * bound in the M0-12 evidence -- and targets the field by its `aria-label`.
 *
 * For each of `prefers-reduced-motion: no-preference` and `reduce` (emulated
 * with Emulation.setEmulatedMedia): back to the latest messages (End), Ctrl+F,
 * type the needle, ArrowDown + Enter (keyboard only), then record the window
 * move, the finder status line ("… message N of M"), the scrollIntoView
 * behaviour the app asked for, the scroll frames actually observed and the
 * mounted DOM size (the bound). Since 06/10/2026 it also follows the hit's
 * offset on screen: scroll anchoring can move scrollTop one frame after an
 * instant jump while the hit stays put (hitMovesAfterLanding).
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-finder-jump.mjs [--entries 2000] [--index 137] [--out report.json]
 *
 * Mutates the active conversation's `localStorage` log key and reloads; the
 * original value is captured first and restored in a `finally` block. Point it
 * at a test conversation.
 */
import { argv, exit } from "node:process";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : fallback;
};
const outIndex = argv.indexOf("--out");
const OUT = outIndex >= 0 ? argv[outIndex + 1] : null;
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
  const status = document.querySelector('.stream-find-count');
  return {
    entryCount: host ? Number(host.getAttribute("data-entry-count")) : null,
    windowStart: host ? Number(host.getAttribute("data-window-start")) : null,
    windowEnd: host ? Number(host.getAttribute("data-window-end")) : null,
    mountedArticles: arts.length,
    mountedNodes: host ? host.querySelectorAll("*").length : null,
    firstPosinset: arts[0] ? Number(arts[0].getAttribute("aria-posinset")) : null,
    needleInWindow: (host ? host.innerText : "").includes("FINDER-NEEDLE"),
    searchFieldPresent: Boolean(field),
    searchFieldValue: field ? field.value : null,
    findStatus: status ? status.innerText.trim() : null,
    findStatusRole: status ? status.getAttribute("role") : null,
    bodyHasNeedleText: /FINDER-NEEDLE/.test(body)
  };
})()`;

/** Spy on the scroll the app asks for, and sample what the stream really does. */
const INSTRUMENT = `(() => {
  const host = document.querySelector('[data-entry-count]');
  window.__findJump = { calls: [], frames: [] };
  if (!window.__findJumpSpy) {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (window.__findJump) window.__findJump.calls.push({ behavior: options && typeof options === "object" ? options.behavior || null : null, entryIndex: this.getAttribute("data-entry-index") });
      return original.apply(this, arguments);
    };
    window.__findJumpSpy = true;
  }
  const t0 = performance.now();
  window.__findJump.targetTops = [];
  const sample = () => {
    if (!window.__findJump || performance.now() - t0 > 4000) return;
    window.__findJump.frames.push(Math.round(host.scrollTop));
    // What the reader sees move: the hit's offset in the transcript's viewport.
    const target = host.querySelector('[data-entry-index="${NEEDLE_INDEX}"]');
    window.__findJump.targetTops.push(target ? Math.round(target.getBoundingClientRect().top - host.getBoundingClientRect().top) : null);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return true;
})()`;

async function key(client, keyName, code, vk, modifiers = 0, text) {
  const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (text) await client.send("Input.dispatchKeyEvent", { type: "char", text, ...base });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function jump(client, motion) {
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const run = { motion, matchMedia: await evaluate(client, `window.matchMedia("(prefers-reduced-motion: reduce)").matches`) };
  // Back to the latest messages so the needle is outside the mounted window.
  await evaluate(client, `(() => { const h = document.querySelector('[data-entry-count]'); h.focus(); return h.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); })()`);
  await sleep(1_500);
  run.before = await evaluate(client, STATE);
  await key(client, "f", "KeyF", 70, 2);
  await sleep(1_000);
  run.typed = await evaluate(client, `(() => {
    const field = document.querySelector('input[aria-label="Search messages"]');
    if (!field) return { typed: false };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${JSON.stringify(NEEDLE)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
    return { typed: true };
  })()`);
  await sleep(1_200);
  run.hits = await evaluate(client, `[...document.querySelectorAll('#conversation-search-results [role="option"]')].map((o) => (o.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60))`);
  await key(client, "ArrowDown", "ArrowDown", 40);
  await sleep(300);
  run.selected = await evaluate(client, `document.querySelector('input[aria-label="Search messages"]').getAttribute("aria-activedescendant")`);
  await evaluate(client, INSTRUMENT);
  await key(client, "Enter", "Enter", 13, 0, "\r");
  await sleep(2_500);
  run.after = await evaluate(client, STATE);
  const spy = await evaluate(client, "window.__findJump");
  const frames = spy.frames;
  const distinct = frames.filter((value, index) => index === 0 || value !== frames[index - 1]);
  // scrollTop also moves when scroll anchoring absorbs entries settling to
  // their real size above the hit; the hit's own offset says whether it moved.
  const viewport = await evaluate(client, `document.querySelector('[data-entry-count]').clientHeight`);
  const landedAt = spy.targetTops.findIndex((top) => top !== null && top >= 0 && top <= viewport);
  const afterLanding = landedAt < 0 ? [] : spy.targetTops.slice(landedAt);
  run.scroll = {
    requestedBehavior: spy.calls.map((c) => c.behavior),
    targetEntryIndex: spy.calls.map((c) => c.entryIndex),
    framesSampled: frames.length,
    distinctScrollPositions: distinct.length,
    intermediatePositions: Math.max(0, distinct.length - 2),
    hitLandedAtPx: landedAt < 0 ? null : afterLanding[0],
    hitMovesAfterLanding: afterLanding.filter((top, index) => index > 0 && top !== afterLanding[index - 1]).length,
  };
  await key(client, "Escape", "Escape", 27);
  await sleep(500);
  return run;
}

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-finder-jump.v2", needleIndex: NEEDLE_INDEX, entries: ENTRIES, runs: [] };
  let restore = null;
  try {
    const picked = await evaluate(client, `(() => {
      const active = localStorage.getItem("muse-desktop.active.v1");
      const id = active ? active.replace(/"/g, "") : null;
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("muse-desktop.log.v1."));
      const key = id && localStorage.getItem("muse-desktop.log.v1." + id) ? "muse-desktop.log.v1." + id : null; // never fall back to another conversation
      return { key, original: key ? localStorage.getItem(key) : null };
    })()`);
    if (!picked.key) throw new Error("no transcript log key found");
    restore = { key: picked.key, value: picked.original };
    report.target = { originalBytes: (picked.original ?? "").length };

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
    report.initial = await evaluate(client, STATE);
    for (const motion of ["no-preference", "reduce"]) report.runs.push(await jump(client, motion));
    const runs = Object.fromEntries(report.runs.map((r) => [r.motion, r]));
    report.verdict = {
      jumpedOutsideWindow: report.runs.every((r) => !r.before.needleInWindow && r.after.needleInWindow && r.after.windowStart <= NEEDLE_INDEX),
      statusAnnounced: report.runs.every((r) => new RegExp(`message ${NEEDLE_INDEX + 1} of ${r.after.entryCount}`).test(r.after.findStatus ?? "") && r.after.findStatusRole === "status"),
      smoothWithoutPreference: runs["no-preference"]?.scroll.requestedBehavior.includes("smooth") ?? false,
      instantWhenReduced: (runs.reduce?.scroll.requestedBehavior.every((b) => b === "auto") && runs.reduce.scroll.intermediatePositions === 0) ?? false,
      hitStillOnceLandedWhenReduced: (runs.reduce?.scroll.requestedBehavior.every((b) => b === "auto") && runs.reduce.scroll.hitLandedAtPx !== null
        && runs.reduce.scroll.hitMovesAfterLanding === 0) ?? false,
      domBound: Math.max(...report.runs.map((r) => r.after.mountedArticles)),
    };
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    await client.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
    if (restore) {
      report.restored = await evaluate(client, `(() => {
        localStorage.setItem(${JSON.stringify(restore.key)}, ${JSON.stringify(restore.value ?? "")});
        const value = localStorage.getItem(${JSON.stringify(restore.key)}) || "";
        return { bytes: value.length, identical: value === ${JSON.stringify(restore.value ?? "")}, hasNeedle: value.includes("FINDER-NEEDLE") };
      })()`).catch((error) => ({ error: String(error.message || error) }));
      await evaluate(client, "location.reload()").catch(() => undefined);
    }
    client.close();
  }
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.verdict ?? report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
