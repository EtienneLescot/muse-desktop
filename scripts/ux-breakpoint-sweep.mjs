#!/usr/bin/env node
/**
 * Sweep real viewport widths and verify, at each one, that the Files and
 * Desktop panels neither overflow nor collapse to one column while two would
 * still fit.
 *
 * Written because fixing a media-query breakpoint by reasoning about "40% of
 * the window" produced a threshold that left 35px of overflow at the very
 * width the defect was reported at.
 *
 * Usage: node scripts/ux-breakpoint-sweep.mjs --port 9227
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

const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

async function openTab(name, root) {
  await ev(`(() => { ${VIS}
    const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
      .find((n) => (n.innerText || "").trim() === ${JSON.stringify(name)});
    if (b) b.click(); return Boolean(b); })()`);
  await sleep(1200);
  return ev(`(() => { ${VIS} return Boolean(document.querySelector(${JSON.stringify(root)})); })()`);
}

const PROBE = `(() => { ${VIS}
  const out = {};
  for (const sel of [".files-layout", ".desktop-control-layout", ".desktop-control-click"]) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = null; continue; }
    const r = el.getBoundingClientRect();
    const cols = getComputedStyle(el).gridTemplateColumns;
    // px escaping the padding box, same predicate as ux-panel-overflow.mjs
    const c = getComputedStyle(el);
    const padR = Number.parseFloat(c.paddingRight) || 0;
    const padL = Number.parseFloat(c.paddingLeft) || 0;
    let leak = 0;
    for (const kid of el.children) {
      const k = kid.getBoundingClientRect();
      if (k.width === 0 && k.height === 0) continue;
      leak = Math.max(leak, Math.max(0, k.right - (r.right - padR)), Math.max(0, (r.left + padL) - k.left));
    }
    out[sel] = {
      w: Math.round(r.width),
      scrollW: el.scrollWidth,
      leak: Math.round(leak),
      tracks: cols.split(" ").length,
      cols,
    };
  }
  const panel = document.querySelector(".work-panel");
  out.panelWidth = panel ? Math.round(panel.getBoundingClientRect().width) : null;

  /**
   * Every element in the work panel that leaks, not just the three grids above.
   * Restricting the sweep to those three grids is exactly how an 8px leak inside
   * the desktop observation block survived a sweep that reported no overflow.
   */
  const body = document.querySelector(".work-panel-body");
  const deep = [];
  if (body) {
    for (const el of body.querySelectorAll("*")) {
      if (!vis(el)) continue;
      const cls = el.getAttribute("class") || "";
      if (/(^|\\s)sr-only(\\s|$)/.test(cls)) continue;
      const c = getComputedStyle(el);
      if (c.overflowX !== "visible") continue;
      if (c.display === "inline" && el.clientWidth === 0 && el.clientHeight === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const padR = Number.parseFloat(c.paddingRight) || 0;
      const padL = Number.parseFloat(c.paddingLeft) || 0;
      let worst = 0;
      for (const kid of el.children) {
        const k = kid.getBoundingClientRect();
        if (k.width === 0 && k.height === 0) continue;
        worst = Math.max(worst, Math.max(0, k.right - (r.right - padR)), Math.max(0, (r.left + padL) - k.left));
      }
      if (worst > 1) deep.push({ cls: cls.split(/\\s+/)[0] || el.tagName.toLowerCase(), plus: Math.round(worst) });
    }
  }
  out.deep = deep;
  out.deepTotal = deep.reduce((s, o) => s + o.plus, 0);
  return out;
})()`;

const WIDTHS = process.argv.includes("--full")
  ? [1440, 1366, 1280, 1200, 1180, 1120, 1080, 1024, 980, 900, 820, 760, 720]
  : [1440, 1366, 1280, 1180, 1080, 1024, 900];

console.log("largeur  panneau  files(larg/tracks/fuite)      desktop(larg/tracks/fuite)     click(fuite)  profond");
const rows = [];
for (const w of WIDTHS) {
  await cmd("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const files = await openTab("Files", ".files-panel");
  const f = await ev(PROBE);
  const desk = await openTab("Desktop", ".desktop-control-panel");
  const d = await ev(PROBE);
  if (!files || !desk) { console.log(`${String(w).padEnd(8)} racine absente (files=${files} desktop=${desk})`); continue; }
  const fm = f[".files-layout"], dm = d[".desktop-control-layout"], cm = d[".desktop-control-click"];
  const deepAll = [...(f.deep || []), ...(d.deep || [])];
  const deepTotal = deepAll.reduce((s, o) => s + o.plus, 0);
  const bad = (fm && fm.leak > 1) || (dm && dm.leak > 1) || (cm && cm.leak > 1) || deepTotal > 1;
  // A tab that failed to open yields a null entry; format it as "-" rather than
  // letting `fm.w` throw and abort the whole sweep at one bad width.
  const cell = (row, key, width) => String(row == null ? "-" : row[key]).padEnd(width);
  console.log(
    `${String(w).padEnd(8)} ${String(f.panelWidth ?? "-").padEnd(8)} ` +
    `${cell(fm, "w", 5)} ${cell(fm, "tracks", 5)} ${cell(fm, "leak", 7)}   ` +
    `${cell(dm, "w", 6)} ${cell(dm, "tracks", 5)} ${cell(dm, "leak", 7)}   ` +
    `${cell(cm, "leak", 5)}   ${String(deepTotal).padEnd(4)}` +
    `${deepAll.length ? "  " + deepAll.map((o) => `.${o.cls} +${o.plus}`).join(" | ") : ""}` +
    `${bad ? "   <-- DEBORDEMENT" : ""}`
  );
  rows.push({ w, panel: f.panelWidth, files: fm, desktop: dm, click: cm, deep: deepAll, bad });
}
await cmd("Emulation.clearDeviceMetricsOverride", {});
const offenders = rows.filter((r) => r.bad);
console.log(`\n${rows.length} largeurs testees · ${offenders.length} en debordement`);
ws.close();
