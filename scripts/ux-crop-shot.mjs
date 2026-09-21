#!/usr/bin/env node
/**
 * Capture one control (and its neighbours) from the running app, cropped.
 *
 * Used to confirm a glyph change on real pixels rather than trusting that the
 * path string is what the browser drew.
 *
 * Usage:
 *   node scripts/ux-crop-shot.mjs --port 9227 --selector "button.icon" --index 3 --out shot.png
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const SELECTOR = (() => { const i = process.argv.indexOf("--selector"); return i >= 0 ? process.argv[i + 1] : "button.icon"; })();
const INDEX = (() => { const i = process.argv.indexOf("--index"); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();
const PAD = (() => { const i = process.argv.indexOf("--pad"); return i >= 0 ? Number(process.argv[i + 1]) : 26; })();
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "docs/evidence/2026-09-21-ux/pass2/fork-icon-app.png"; })();
const SCALE = (() => { const i = process.argv.indexOf("--scale"); return i >= 0 ? Number(process.argv[i + 1]) : 4; })();

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

const box = await ev(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(SELECTOR)})]
    .filter((n) => { const c = getComputedStyle(n); return c.display !== "none" && n.getClientRects().length > 0; });
  const el = els[${INDEX}];
  if (!el) return { error: "index absent", count: els.length };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, label: el.getAttribute("aria-label"), count: els.length };
})()`);
if (box.error) { console.error(`${box.error} (${box.count} correspondance(s))`); ws.close(); process.exit(1); }
console.log(`  cible : "${box.label}"  ${Math.round(box.w)}x${Math.round(box.h)} a (${Math.round(box.x)}, ${Math.round(box.y)})`);

const clip = {
  x: Math.max(0, box.x - PAD),
  y: Math.max(0, box.y - PAD),
  width: box.w + PAD * 2,
  height: box.h + PAD * 2,
  scale: SCALE,
};
const shot = await cmd("Page.captureScreenshot", { format: "png", clip });
if (!shot.result?.data) { console.error("capture vide"); ws.close(); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
console.log(`  capture : ${OUT} (${Buffer.from(shot.result.data, "base64").length} octets, zoom ${SCALE}x)`);
ws.close();
