#!/usr/bin/env node

/**
 * Compare the rendered composer region with and without focus, to decide
 * whether the message field shows a visible focus indicator (M0-12).
 *
 * Computed style alone cannot answer this: the indicator may be drawn by a
 * pseudo-element or a sibling. This captures real pixels through CDP.
 *
 * Requires the CDP-enabled dev build. Usage:
 *   node scripts/cdp-focus-pixels.mjs [--out DIR]
 */
import { argv, exit } from "node:process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const outIndex = argv.indexOf("--out");
const OUT = resolve(outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : ".");
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
  const ready = new Promise((resolveReady, reject) => {
    socket.addEventListener("open", () => resolveReady(), { once: true });
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
      return new Promise((resolveSend, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30_000);
        pending.set(id, { resolve: resolveSend, reject, method, timer });
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

/** Bounding box of the composer, padded so any focus ring is inside the crop. */
const composerBox = (client) => evaluate(client, `(() => {
  const f = document.querySelector('textarea');
  if (!f) return null;
  const node = f.closest('.composer, [class*="composer"]') || f.parentElement;
  const r = node.getBoundingClientRect();
  const pad = 8;
  // Widen to the full footer so a ring drawn outside the field is included,
  // but stay inside the viewport: an out-of-range clip makes the capture fail.
  const x = Math.max(0, Math.floor(r.left - 60));
  const y = Math.max(0, Math.floor(r.top - 30));
  const width = Math.min(Math.ceil(r.width + 120), window.innerWidth - x);
  const height = Math.min(Math.ceil(r.height + 80), window.innerHeight - y);
  return { x, y, width, height };
})()`);

async function capture(client, box, file) {
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 },
  });
  const bytes = Buffer.from(shot.data, "base64");
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-focus-pixels.v1", steps: {} };
  try {
    const box = await composerBox(client);
    if (!box) throw new Error("no composer on screen");
    report.box = box;

    // 1. Focus elsewhere, capture.
    await evaluate(client, `(() => { const a = document.querySelector('a[href], button'); if (a) a.focus(); else document.body.focus(); return true; })()`);
    await sleep(600);
    report.blurred = await capture(client, box, resolve(OUT, "composer-blurred.png"));

    // 2. Focus the message field, capture again.
    await evaluate(client, `(() => { const f = document.querySelector('textarea'); f.focus(); return { focused: document.activeElement === f }; })()`);
    await sleep(600);
    report.focused = await capture(client, box, resolve(OUT, "composer-focused.png"));

    report.identicalPixels = report.blurred.sha256 === report.focused.sha256;
    report.verdict = report.identicalPixels
      ? "la région du compositeur est identique au bit près avec et sans focus : aucun indicateur de focus visible"
      : "la région diffère : un indicateur de focus est rendu";
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
