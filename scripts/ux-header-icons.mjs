#!/usr/bin/env node
/**
 * Identify the header control at the position the user circled, and report what
 * it actually contains.
 *
 * The screenshot marks a control around x=838, y=24 in a 1267 px wide window,
 * so the same control sits at about x=806 in the 1007 px preview. Rather than
 * guess from the pixels, this lists every interactive control in the header with
 * its box, its accessible name, and the raw markup of its icon, so the element
 * under that point can be named exactly.
 *
 * Usage: node scripts/ux-header-icons.mjs --port 9227
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();

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
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

const report = await ev(`(() => { ${VIS}
  // No <header> element: the top strip is just the first row of the shell, so
  // the band is defined by position instead of by tag.
  const BAND = 56;
  const rows = [];
  for (const el of document.querySelectorAll("button, a, [role=button]")) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.top > BAND || r.bottom < 0) continue;
    const svg = el.querySelector("svg");
    let paths = null;
    if (svg) {
      paths = [...svg.querySelectorAll("path, line, polyline, circle, rect")]
        .map((p) => {
          const d = p.getAttribute("d");
          if (d) return d.slice(0, 90);
          const box = [p.getAttribute("x1"), p.getAttribute("y1"), p.getAttribute("x2"), p.getAttribute("y2")]
            .filter((v) => v !== null).join(",");
          return p.tagName + (box ? ":" + box : "");
        })
        .slice(0, 4);
    }
    rows.push({
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || "").trim()).slice(0, 40),
      cls: (el.getAttribute("class") || "").slice(0, 30),
      x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
      centerX: Math.round(r.left + r.width / 2),
      strokeWidth: svg ? getComputedStyle(svg).strokeWidth : null,
      viewBox: svg ? svg.getAttribute("viewBox") : null,
      paths,
    });
  }
  rows.sort((a, b) => a.x - b.x);
  return { viewport: window.innerWidth, rows };
})()`);

console.log(`viewport=${report.viewport}  ${report.rows.length} controle(s) dans la bande haute\n`);
for (const row of report.rows) {
  console.log(`  x=${String(row.x).padStart(4)} centre=${String(row.centerX).padStart(4)} ${String(row.w)}x${String(row.h)}  ${row.tag}.${row.cls}  "${row.label}"`);
  if (row.paths) {
    console.log(`         viewBox=${row.viewBox} stroke=${row.strokeWidth}`);
    for (const p of row.paths) console.log(`         path ${p}`);
  }
}
ws.close();
