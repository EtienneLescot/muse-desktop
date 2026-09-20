#!/usr/bin/env node

/**
 * Accessibility probe for M0-12, driven through CDP.
 *
 * Measures what the running webview actually does: effective keyboard focus
 * order, whether focus is visibly indicated, whether documented shortcuts are
 * bound, and WCAG contrast ratios for visible text. It reports measurements,
 * not a pass/fail verdict -- the acceptance criteria are in the roadmap.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-a11y-probe.mjs [--conversation "needle"]
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const NEEDLE = (() => {
  const index = argv.indexOf("--conversation");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "Enumerate the three Musketeers";
})();
const TABS = Number(process.env.MUSE_A11Y_TABS ?? 24);
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

/** Describe the currently focused element and whether its focus is visible. */
const ACTIVE_DESCRIPTOR = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: el ? el.tagName : null, body: true };
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.value || "").trim().slice(0, 40);
  return {
    tag: el.tagName,
    cls: (el.className || "").toString().split(/\\s+/).slice(0, 2).join(" "),
    label,
    ariaKeyshortcuts: el.getAttribute("aria-keyshortcuts"),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow === "none" ? "none" : cs.boxShadow.slice(0, 40),
    visible: rect.width > 0 && rect.height > 0
  };
})()`;

async function pressTab(client) {
  const base = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab" };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, modifiers: 0 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, modifiers: 0 });
  await sleep(120);
}

/** Contrast ratios for visible text, computed in the page against real colours. */
const CONTRAST_SNIPPET = `(() => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const opaqueBackground = (start) => {
    let node = start;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (fg, bg) => {
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const samples = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode() && samples.length < 60) {
    const text = (walker.currentNode.textContent || "").trim();
    if (text.length < 3) continue;
    const el = walker.currentNode.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = opaqueBackground(el);
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    samples.push({
      text: text.slice(0, 26), size: Math.round(size), weight, large,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      required: large ? 3 : 4.5
    });
  }
  const failing = samples.filter((s) => s.ratio < s.required);
  return { sampled: samples.length, failing: failing.length, worst: failing.slice(0, 6) };
})()`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-a11y-probe.v1", needle: NEEDLE, steps: {} };
  try {
    // Open a conversation so the transcript and composer exist.
    report.open = await evaluate(client, `(() => {
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => n.offsetParent !== null);
      const hit = nodes.find((n) => ((n.innerText || "").toLowerCase()).includes(${JSON.stringify(NEEDLE.toLowerCase())}));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true, label: (hit.innerText || "").trim().slice(0, 40) };
    })()`);
    await sleep(3_000);

    // Reset focus to the document, then walk the tab order.
    await evaluate(client, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    await sleep(300);
    const order = [];
    for (let step = 0; step < TABS; step += 1) {
      await pressTab(client);
      const described = await evaluate(client, ACTIVE_DESCRIPTOR);
      order.push(described);
    }
    report.tabOrder = order.map((entry, index) => ({
      step: index + 1,
      tag: entry.tag,
      cls: entry.cls,
      label: entry.label,
      outline: entry.outlineStyle === "none" && entry.boxShadow === "none" ? "AUCUN" : [entry.outlineStyle, entry.outlineWidth, entry.boxShadow].filter(Boolean).join(" / ").slice(0, 60),
      shortcuts: entry.ariaKeyshortcuts
    }));
    const unique = new Set(report.tabOrder.map((e) => `${e.tag}|${e.cls}|${e.label}`));
    report.tabOrderSummary = {
      steps: report.tabOrder.length,
      uniqueStops: unique.size,
      withoutVisibleFocus: report.tabOrder.filter((e) => e.outline === "AUCUN").length,
      withShortcuts: report.tabOrder.filter((e) => e.shortcuts).map((e) => ({ label: e.label, shortcuts: e.shortcuts }))
    };

    // Documented shortcuts: does Ctrl/Cmd+F open the in-conversation finder?
    const beforeFind = await evaluate(client, `(() => /Find in conversation/i.test((document.body.innerText || "")))()`);
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 });
    await sleep(700);
    const afterFind = await evaluate(client, `(() => {
      const el = document.activeElement;
      return { finderVisible: /Find in conversation/i.test(document.body.innerText || ""),
               activePlaceholder: el ? (el.getAttribute("placeholder") || "") : null,
               activeLabel: el ? (el.getAttribute("aria-label") || "") : null };
    })()`);
    report.findShortcut = { before: beforeFind, after: afterFind };

    // Transcript keyboard affordances.
    report.transcript = await evaluate(client, `(() => {
      const el = document.querySelector('[aria-keyshortcuts]');
      const candidates = [...document.querySelectorAll('[aria-keyshortcuts]')].map((n) => ({
        tag: n.tagName, cls: (n.className || "").toString().split(/\\s+/)[0], shortcuts: n.getAttribute("aria-keyshortcuts")
      }));
      return { withKeyshortcuts: candidates.length, candidates: candidates.slice(0, 8),
               transcriptFound: Boolean(el) };
    })()`);

    report.contrast = await evaluate(client, CONTRAST_SNIPPET);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
