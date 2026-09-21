#!/usr/bin/env node

/**
 * Flag interactive controls that are too small to hit comfortably, and any
 * element that overflows the viewport horizontally.
 *
 * A visual reviewer sees that something "looks cramped"; this says by how much.
 * Target: 24x24 CSS px minimum for a pointer, which is the WCAG 2.2 "Target Size
 * (Minimum)" floor, and no horizontal overflow at the current window size.
 *
 * Usage:
 *   node scripts/ux-target-size-audit.mjs --port 9227
 */
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const MIN = Number(process.env.MUSE_MIN_TARGET ?? 24);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) { console.error(`pas de page applicative sur ${PORT}`); process.exit(1); }

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
  const v = r.result?.result?.value;
  if (v === undefined) throw new Error(`undefined (${expression.slice(0, 40)})`);
  return v;
}

const report = await ev(`(() => {
  const vis = (n) => Boolean(n) && n.offsetParent !== null && !n.closest("details:not([open])");
  const controls = [...document.querySelectorAll("button, a[href], [role=button], [role=tab], input, select, textarea")].filter(vis);
  const small = [];
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.width >= ${MIN} && r.height >= ${MIN}) continue;
    const label = (c.innerText || c.getAttribute("aria-label") || c.getAttribute("placeholder") || c.tagName).trim().slice(0, 34);
    small.push({
      label,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      cls: typeof c.className === "string" ? c.className.slice(0, 30) : "",
      parent: c.parentElement && typeof c.parentElement.className === "string" ? c.parentElement.className.slice(0, 24) : "",
    });
  }
  const docWidth = document.documentElement.scrollWidth;
  const viewWidth = window.innerWidth;
  const overflow = [...document.querySelectorAll("*")]
    .filter(vis)
    .map((n) => ({ n, r: n.getBoundingClientRect() }))
    .filter(({ r }) => r.right > viewWidth + 1 || r.left < -1)
    .slice(0, 8)
    .map(({ n, r }) => ({
      tag: n.tagName,
      cls: typeof n.className === "string" ? n.className.slice(0, 30) : "",
      left: Math.round(r.left),
      right: Math.round(r.right),
    }));
  return {
    viewport: { w: viewWidth, h: window.innerHeight },
    documentWidth: docWidth,
    horizontalScroll: docWidth > viewWidth,
    controlsChecked: controls.length,
    belowMinimum: small,
    overflowing: overflow,
  };
})()`);

console.log(`viewport ${report.viewport.w}x${report.viewport.h} · document ${report.documentWidth}px`);
console.log(`defilement horizontal : ${report.horizontalScroll ? "OUI" : "non"}`);
console.log(`controles examines : ${report.controlsChecked}`);
console.log(`\n${report.belowMinimum.length} controle(s) sous ${MIN}x${MIN} px :`);
for (const s of report.belowMinimum) {
  console.log(`  ${String(s.w).padStart(6)}x${String(s.h).padStart(5)}  "${s.label}"  ${s.cls || s.parent}`);
}
console.log(`\n${report.overflowing.length} element(s) hors viewport :`);
for (const o of report.overflowing) {
  console.log(`  ${o.tag}.${o.cls}  left=${o.left} right=${o.right}`);
}
ws.close();
