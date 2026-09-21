#!/usr/bin/env node
/**
 * Measure the find bar's geometry against the transcript it sits in, to describe
 * what is actually visually off.
 *
 * Established first: the bar is opaque and wins its stacking context — 384 of 384
 * sampled pixels inside it are the bar's own background, so no transcript text
 * shows through. The remaining question is geometric: where the bar sits
 * relative to the stream, and whether a content sliver can appear above it.
 *
 * Usage: node scripts/ux-find-bar-geometry.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error("pas de page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); }
});
const cmd = (m, p) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}

const report = await ev(`(() => {
  const bar = document.querySelector(".stream-find");
  const stream = document.querySelector(".stream");
  if (!bar || !stream) return { absent: true };
  const b = bar.getBoundingClientRect();
  const s = stream.getBoundingClientRect();
  const sc = getComputedStyle(stream);
  const bc = getComputedStyle(bar);

  // Where does the first transcript entry start, relative to the bar?
  const first = stream.querySelector(".msg, .log-entry, .stream-entry");
  const fr = first ? first.getBoundingClientRect() : null;

  return {
    stream: {
      top: Math.round(s.top), bottom: Math.round(s.bottom), height: Math.round(s.height),
      paddingTop: sc.paddingTop, paddingBottom: sc.paddingBottom,
      scrollHeight: stream.scrollHeight, clientHeight: stream.clientHeight,
    },
    bar: {
      top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height),
      // Gap between the top of the scroll viewport and the top of the bar.
      gapFromStreamTop: Math.round(b.top - s.top),
      marginTop: bc.marginTop, marginBottom: bc.marginBottom,
      width: Math.round(b.width), streamWidth: Math.round(s.width),
      // The bar is narrower than the stream, so content shows on both sides.
      sideGap: Math.round((s.width - b.width) / 2),
    },
    firstEntry: fr ? { top: Math.round(fr.top), gapBelowBar: Math.round(fr.top - b.bottom) } : null,
    // How much of the stream's visible height the bar occupies when pinned.
    shareOfViewport: Math.round((b.height / s.height) * 100),
  };
})()`);

console.log(JSON.stringify(report, null, 2));
ws.close();
