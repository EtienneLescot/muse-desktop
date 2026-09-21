#!/usr/bin/env node
/**
 * Verify popover dismissal app-wide, and — just as important — that content
 * disclosures are left alone.
 *
 * The two `<details>` families must behave oppositely, so a test that only proves
 * "popovers close" would pass while the app quietly collapsed every approval
 * card, writer result and engine error on the next click. Both halves are
 * asserted here.
 *
 * Usage: node scripts/ux-popover-dismiss.mjs --port 9227
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

/** Every `<details>`, split by the marker, with its open state. */
const INVENTORY = `(() => { ${VIS}
  const all = [...document.querySelectorAll("details")].filter(vis);
  const popovers = all.filter((d) => d.hasAttribute("data-popover"));
  const disclosures = all.filter((d) => !d.hasAttribute("data-popover"));
  const summaryOf = (d) => {
    const s = d.querySelector("summary");
    return s ? { ariaExpanded: s.getAttribute("aria-expanded") } : null;
  };
  return {
    popoverCount: popovers.length,
    popovers: popovers.map((d) => ({ cls: d.className.slice(0, 34), open: d.hasAttribute("open"), ...summaryOf(d) })),
    disclosureCount: disclosures.length,
    disclosuresOpen: disclosures.filter((d) => d.hasAttribute("open")).map((d) => d.className.slice(0, 34)),
  }; })()`;

console.log("  --- inventaire initial ---");
const before = await ev(INVENTORY);
console.log(`  popovers marques : ${before.popoverCount}`);
for (const p of before.popovers) console.log(`    .${p.cls}  open=${p.open}  aria-expanded=${p.ariaExpanded}`);
console.log(`  divulgations (non marquees) : ${before.disclosureCount}, dont ouvertes : ${JSON.stringify(before.disclosuresOpen)}`);

// 1. Open a popover, then click outside it.
const opened = await ev(`(() => { ${VIS}
  const t = document.querySelector(".model-trigger");
  if (!t) return false;
  t.click();
  return true; })()`);
await sleep(700);
const openState = await ev(INVENTORY);
const openModel = openState.popovers.find((p) => /model/.test(p.cls));
console.log(`\n  1. apres clic sur le declencheur Modele : open=${openModel?.open} aria-expanded=${openModel?.ariaExpanded}`);

// A genuine outside click, in the transcript.
const outside = await ev(`(() => {
  const target = document.querySelector(".stream") || document.body;
  const r = target.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + 40);
  const el = document.elementFromPoint(x, y);
  if (!el) return { clicked: false };
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y }));
  return { clicked: true, on: (el.getAttribute("class") || el.tagName).slice(0, 30) };
})()`);
await sleep(700);
const afterOutside = await ev(INVENTORY);
const modelAfter = afterOutside.popovers.find((p) => /model/.test(p.cls));
console.log(`  2. apres clic exterieur (${JSON.stringify(outside)}) : open=${modelAfter?.open}`);
console.log(`     divulgations encore ouvertes : ${JSON.stringify(afterOutside.disclosuresOpen)}`);

// 2. Escape must also close it.
await ev(`(() => { const t = document.querySelector(".model-trigger"); if (t) t.click(); return true; })()`);
await sleep(600);
const reopened = await ev(INVENTORY);
console.log(`\n  3. rouvert : open=${reopened.popovers.find((p) => /model/.test(p.cls))?.open}`);
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(600);
const afterEscape = await ev(INVENTORY);
console.log(`  4. apres Echap : open=${afterEscape.popovers.find((p) => /model/.test(p.cls))?.open}`);
console.log(`     divulgations encore ouvertes : ${JSON.stringify(afterEscape.disclosuresOpen)}`);

const ok =
  opened === true &&
  openModel?.open === true &&
  modelAfter?.open === false &&
  afterEscape.popovers.find((p) => /model/.test(p.cls))?.open === false &&
  JSON.stringify(afterEscape.disclosuresOpen) === JSON.stringify(before.disclosuresOpen);

console.log(`\n  popover ferme au clic exterieur et a Echap, divulgations intactes : ${ok ? "OUI" : "NON"}`);
ws.close();
process.exit(ok ? 0 : 1);
