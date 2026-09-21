#!/usr/bin/env node
/**
 * Capture the panels whose grids were just changed, and assert the layout is
 * still sound at a genuinely narrow width.
 *
 * Zero overflow is necessary but NOT sufficient: a panel can pass every
 * measurement while looking broken. Two earlier overflow "fixes" in this
 * campaign were reverted for exactly that reason, so the numbers are checked
 * against pixels here.
 *
 * Usage: node scripts/ux-review-captures.mjs --port 9227 --out docs/evidence/2026-09-21-ux/overflow
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "docs/evidence/2026-09-21-ux/overflow"; })();
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
async function shot(path) {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  const data = r.result?.data;
  if (!data) throw new Error("capture vide");
  writeFileSync(path, Buffer.from(data, "base64"));
  return Buffer.from(data, "base64").length;
}

const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

mkdirSync(OUT, { recursive: true });

async function openTab(name, root) {
  await ev(`(() => { ${VIS}
    const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
      .find((n) => (n.innerText || "").trim() === ${JSON.stringify(name)});
    if (b) b.click(); return Boolean(b); })()`);
  await sleep(1500);
  return ev(`(() => { ${VIS} return Boolean(document.querySelector(${JSON.stringify(root)})); })()`);
}

/**
 * Force the work panel narrow WITHOUT narrowing the viewport.
 *
 * Read the results with care: the responsive rules key off viewport width, so
 * this produces a state no real window can be in - a narrow panel inside a wide
 * window. At a 1280px viewport `(max-width: 1230px)` does not match, so the
 * Files grid stays two-column and its 342px of tracks overflow the 253px panel.
 * That is an artefact of the harness, and `ux-breakpoint-sweep.mjs` is the tool
 * that answers the real question by resizing the viewport itself.
 */
async function withPanelWidth(px, fn) {
  await ev(`(() => {
    let s = document.getElementById("__ux-narrow");
    if (!s) { s = document.createElement("style"); s.id = "__ux-narrow"; document.head.appendChild(s); }
    s.textContent = ${JSON.stringify(".work-panel { width: " + px + "px !important; flex: 0 0 auto !important; }")};
    return true; })()`);
  await sleep(900);
  try { return await fn(); }
  finally {
    await ev(`(() => { const s = document.getElementById("__ux-narrow"); if (s) s.remove(); return true; })()`);
    await sleep(700);
  }
}
/** Structural assertions that a screenshot would only catch by eye. */
const ASSERT = `(() => { ${VIS}
  const out = {};
  const click = document.querySelector(".desktop-control-click");
  if (click) {
    const r = click.getBoundingClientRect();
    const kids = [...click.children].filter(vis).map((k) => {
      const kr = k.getBoundingClientRect();
      return { cls: (k.getAttribute("class") || k.tagName).split(/\\s+/)[0], text: (k.innerText || k.getAttribute("aria-label") || "").trim().slice(0, 20),
               insideX: kr.left >= r.left - 0.5 && kr.right <= r.right + 0.5, w: Math.round(kr.width) };
    });
    out.clickRow = { w: Math.round(r.width), scrollW: click.scrollWidth, allInside: kids.every((k) => k.insideX), kids };
  }
  const files = document.querySelector(".files-layout");
  if (files) {
    const fr = files.getBoundingClientRect();
    out.files = { w: Math.round(fr.width), scrollW: files.scrollWidth,
      cols: [...files.children].map((k) => Math.round(k.getBoundingClientRect().width)),
      inPanel: [...files.children].every((k) => k.getBoundingClientRect().right <= fr.right + 0.5) };
  }
  const list = document.querySelector(".desktop-window-list");
  if (list) {
    const first = list.querySelector("button, .is-selected");
    if (first) {
      const strong = first.querySelector("strong");
      const span = first.querySelector("span");
      const ell = (n) => n ? { scrollW: n.scrollWidth, clientW: n.clientWidth, ellipsised: n.scrollWidth > n.clientWidth + 1,
                                css: getComputedStyle(n).textOverflow } : null;
      out.windowTitle = { strong: ell(strong), span: ell(span), hint: "ellipsised attendu pour les longs noms d'application" };
    }
  }
  const layout = document.querySelector(".desktop-control-layout");
  if (layout) {
    out.desktopLayout = { w: Math.round(layout.getBoundingClientRect().width), scrollW: layout.scrollWidth,
      cols: [...layout.children].map((k) => Math.round(k.getBoundingClientRect().width)) };
  }
  return out;
})()`;

const log = [];
async function capture(tab, root, label) {
  const ok = await openTab(tab, root);
  if (!ok) { log.push(`${tab} [${label}] : racine absente, capture refusee`); return; }
  const file = `${OUT}/${label}-${tab.toLowerCase()}.png`;
  const bytes = await shot(file);
  const assert = await ev(ASSERT);
  log.push(`${tab} [${label}] -> ${file} (${bytes} octets)`);
  log.push(`  ${JSON.stringify(assert)}`);
}

console.log("=== largeur courante ===");
for (const [tab, root] of [["Files", ".files-panel"], ["Desktop", ".desktop-control-panel"]]) {
  await capture(tab, root, "large");
}

console.log("\n=== panneau etroit force (411px) — etat non realiste, voir l'avertissement ci-dessus ===");
await withPanelWidth(411, async () => {
  for (const [tab, root] of [["Files", ".files-panel"], ["Desktop", ".desktop-control-panel"]]) {
    await capture(tab, root, "etroits-411");
  }
});

console.log("\n=== panneau tres etroit force (320px) — etat non realiste ===");
await withPanelWidth(320, async () => {
  for (const [tab, root] of [["Files", ".files-panel"], ["Desktop", ".desktop-control-panel"]]) {
    await capture(tab, root, "etroits-320");
  }
});

console.log("\n" + log.join("\n"));
ws.close();
