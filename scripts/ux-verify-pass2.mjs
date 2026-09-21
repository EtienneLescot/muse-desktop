#!/usr/bin/env node
/**
 * Verify the two UX decisions in the running app:
 *   1. the composer no longer repeats "Local";
 *   2. the Browser tab shows an empty state before any page is loaded.
 *
 * Asserts preconditions (conversation open, work panel expanded, Browser tab
 * rendered) before reporting, and says so when it cannot measure.
 *
 * Usage: node scripts/ux-verify-pass2.mjs --port 9227 [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
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
  if (!r.result?.data) throw new Error("capture vide");
  writeFileSync(path, Buffer.from(r.result.data, "base64"));
  return Buffer.from(r.result.data, "base64").length;
}
const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(predicate)) === true) { console.log(`  precondition OK   : ${label}`); return true; }
    await sleep(600);
  }
  console.error(`  PRECONDITION ECHOUEE : ${label}`);
  return false;
}

/** Every visible occurrence of the stand-alone word "Local". */
const LOCAL_COUNT = `(() => { ${VIS}
  const hits = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode;
    const text = (node.textContent || "").trim();
    if (!/^Local$/.test(text)) continue;
    const el = node.parentElement;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    hits.push({ text, cls: (el.getAttribute("class") || el.tagName).slice(0, 30),
                x: Math.round(r.left), y: Math.round(r.top) });
  }
  return hits; })()`;

const conv = await waitFor("conversation ouverte",
  `(() => { ${VIS} return document.querySelector(".composer, .composer-card") !== null; })()`);
if (!conv) { console.error("Ouvre une conversation. Abandon."); ws.close(); process.exit(1); }

const locals = await ev(LOCAL_COUNT);
console.log(`\n  occurrences de « Local » seul : ${locals.length}`);
for (const l of locals) console.log(`    "${l.text}"  .${l.cls}  (${l.x},${l.y})`);
const composerLocal = locals.some((l) => /composer/.test(l.cls));
console.log(`  chip « Local » dans le composeur : ${composerLocal ? "ENCORE PRESENTE" : "retiree"}`);

const open = await waitFor("panneau de travail deplie",
  `(() => { ${VIS}
    // The panel body is the stable signal; a specific tab's root only exists
    // once that tab is selected, so testing for it here would loop forever on a
    // panel that is already open.
    if (document.querySelector(".work-panel-body")) return true;
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label")||"") === "Show work panel");
    if (b) { b.click(); return false; }
    return false; })()`, 25_000);
if (!open) { console.error("Le panneau ne s'ouvre pas."); ws.close(); process.exit(1); }

const clicked = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis).find((n) => (n.innerText || "").trim() === "Browser");
  if (b) b.click();
  return Boolean(b); })()`);
if (!clicked) { console.error("Onglet Browser introuvable."); ws.close(); process.exit(1); }
await sleep(1800);

const browser = await waitFor("onglet Browser rendu",
  `(() => { ${VIS} return Boolean(document.querySelector(".browser-panel")); })()`);
if (!browser) { console.error("Racine .browser-panel absente."); ws.close(); process.exit(1); }

const state = await ev(`(() => { ${VIS}
  const empty = document.querySelector(".browser-frame-empty");
  const frame = document.querySelector(".browser-frame");
  return {
    emptyStatePresent: Boolean(empty),
    emptyStateVisible: empty ? vis(empty) : false,
    emptyText: empty ? (empty.innerText || "").trim().slice(0, 90) : null,
    framePresent: Boolean(frame),
    subtitle: (() => {
      const s = document.querySelector(".browser-title .muted");
      return s ? s.textContent.trim() : null;
    })(),
    controlsPresent: Boolean(document.querySelector(".browser-controls")),
  }; })()`);
console.log(`\n  etat vide du Browser : ${state.emptyStatePresent ? "PRESENT" : "ABSENT"} (visible: ${state.emptyStateVisible})`);
if (state.emptyText) console.log(`    texte : ${state.emptyText}`);
console.log(`  sous-titre de l'en-tete : ${state.subtitle}`);
console.log(`  iframe presente : ${state.framePresent}   controles presents : ${state.controlsPresent}`);

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  const bytes = await shot(`${OUT}/pass2-browser-etat-vide.png`);
  console.log(`\n  capture : ${OUT}/pass2-browser-etat-vide.png (${bytes} octets)`);
}
ws.close();
