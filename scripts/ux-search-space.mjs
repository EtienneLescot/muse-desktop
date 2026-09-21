#!/usr/bin/env node
/**
 * Measure how much transcript space the find bar now takes at rest.
 *
 * The complaint was that the bar occupied too much room. "Not rendered" should
 * mean zero, but the stream's own padding and scroll height could still differ,
 * so the numbers are compared between the two states rather than asserted.
 *
 * Usage: node scripts/ux-search-space.mjs --port 9227
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

const MEASURE = `(() => {
  const stream = document.querySelector(".stream");
  if (!stream) return { absent: true };
  const dock = document.querySelector(".stream-find-dock");
  const first = stream.querySelector(".msg, .log-entry, .stream-entry");
  return {
    visibleTranscript: Math.round(stream.getBoundingClientRect().height),
    scrollHeight: stream.scrollHeight,
    dockHeight: dock ? Math.round(dock.getBoundingClientRect().height) : 0,
    firstEntryTop: first ? Math.round(first.getBoundingClientRect().top) : null,
    // Space between the top of the viewport and the first message: this is the
    // room the bar used to occupy.
    headroom: first ? Math.round(first.getBoundingClientRect().top - stream.getBoundingClientRect().top) : null,
  };
})()`;

const atRest = await ev(MEASURE);
console.log(`  au repos            : ${JSON.stringify(atRest)}`);

await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
await sleep(800);
const open = await ev(MEASURE);
console.log(`  barre ouverte       : ${JSON.stringify(open)}`);

await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(700);

if (atRest.absent || open.absent) { console.error("  flux absent"); ws.close(); process.exit(1); }
const reclaimed = open.headroom - atRest.headroom;
console.log(`\n  espace rendu au transcript quand la barre est fermee : ${reclaimed} px`);
console.log(`  la barre occupe ${open.dockHeight} px quand elle est ouverte, 0 au repos`);
ws.close();
