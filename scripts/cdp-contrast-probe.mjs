#!/usr/bin/env node

/**
 * Verify that the documented accessibility media queries actually apply in the
 * running webview (M0-12).
 *
 * `src/App.css` declares two blocks that only activate when the platform asks:
 *   @media (forced-colors: active)   -> system colors on focus rings, borders, links
 *   @media (prefers-contrast: more)  -> muted copy and focus rings reinforced
 *
 * This probe emulates both media features through CDP and reads the computed
 * styles before and after, so the claim is measured rather than assumed. It
 * changes nothing on the machine: the emulation lives inside the page session.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-contrast-probe.mjs
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

/**
 * Read the styles the two blocks are supposed to drive. Each entry focuses a
 * representative control and records its focus ring, borders and link colour.
 */
const STYLE_SNIPPET = `(() => {
  const pick = (selector) => [...document.querySelectorAll(selector)].find((n) => n.offsetParent !== null) || null;
  const focusAndRead = (selector) => {
    const node = pick(selector);
    if (!node) return { selector, present: false };
    node.focus();
    const cs = getComputedStyle(node);
    return {
      selector,
      present: true,
      focusVisible: node.matches(":focus-visible"),
      outlineColor: cs.outlineColor,
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      borderColor: cs.borderColor,
      borderStyle: cs.borderStyle,
      color: cs.color
    };
  };
  const muted = pick(".muted");
  const mutedColor = muted ? getComputedStyle(muted).color : null;
  return {
    forcedColorsMatches: matchMedia("(forced-colors: active)").matches,
    prefersContrastMore: matchMedia("(prefers-contrast: more)").matches,
    controls: [
      focusAndRead("button"),
      focusAndRead("a[href]"),
      focusAndRead("textarea"),
      focusAndRead("input"),
      focusAndRead("summary")
    ],
    mutedColor
  };
})()`;

const setMedia = (client, features) =>
  client.send("Emulation.setEmulatedMedia", { media: "screen", features });

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-contrast-probe.v1" };
  try {
    // 1. Baseline: no emulation.
    await setMedia(client, []);
    await sleep(400);
    report.baseline = await evaluate(client, STYLE_SNIPPET);

    // 2. Emulate Windows High Contrast / forced-colors.
    await setMedia(client, [{ name: "forced-colors", value: "active" }]);
    await sleep(600);
    report.forcedColors = await evaluate(client, STYLE_SNIPPET);

    // 3. Emulate prefers-contrast: more.
    await setMedia(client, [{ name: "prefers-contrast", value: "more" }]);
    await sleep(600);
    report.prefersContrastMore = await evaluate(client, STYLE_SNIPPET);

    // 4. Restore the page to its natural state.
    await setMedia(client, []);
    await sleep(300);
    report.restored = await evaluate(client, STYLE_SNIPPET);

    // 5. Did the emulated blocks actually change anything that matters?
    const forced = report.forcedColors;
    const base = report.baseline;
    report.diff = {
      forcedColorsActiveInPage: forced.forcedColorsMatches,
      prefersContrastActiveInPage: report.prefersContrastMore.prefersContrastMore,
      outlineChangedOnAnyControl: forced.controls.some((c, i) => c.present && base.controls[i].present && c.outlineColor !== base.controls[i].outlineColor),
      borderChangedOnAnyControl: forced.controls.some((c, i) => c.present && base.controls[i].present && c.borderColor !== base.controls[i].borderColor),
      linkColorChanged: (() => {
        const link = forced.controls.find((c) => c.selector === "a[href]");
        const before = base.controls.find((c) => c.selector === "a[href]");
        return Boolean(link && before && link.present && before.present && link.color !== before.color);
      })(),
      mutedColorChangedUnderMoreContrast: report.prefersContrastMore.mutedColor !== base.mutedColor
    };
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
