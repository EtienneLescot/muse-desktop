#!/usr/bin/env node

/**
 * Measure the contrast ratio of every visible text node and report the ones
 * below WCAG AA.
 *
 * A visual review can only guess at contrast; this computes it. Each text node's
 * colour is composited against the first opaque ancestor background and measured
 * with the standard relative-luminance formula. That makes a finding reproducible
 * instead of a matter of taste, and it catches the washed-out grey that a
 * screenshot only hints at.
 *
 * Run once per theme: the light palette has its own failures.
 *
 * Usage:
 *   node scripts/ux-contrast-audit.mjs --port 9227
 *   node scripts/ux-contrast-audit.mjs --port 9227 --theme light
 */
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const THEME = (() => { const i = process.argv.indexOf("--theme"); return i >= 0 ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

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

/** Evaluate in the page and return the real value (not a remote reference). */
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text).slice(0, 120));
  const v = r.result?.result?.value;
  if (v === undefined) throw new Error(`evaluate a renvoye undefined (${expression.slice(0, 50)})`);
  return v;
}

if (THEME) {
  const wanted = THEME === "light" ? "Switch to light theme" : "Switch to dark theme";
  const switched = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label") || "") === ${JSON.stringify(wanted)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  console.log(`bascule ${THEME} : ${switched ? "OK" : "bouton introuvable"}`);
  await sleep(2_500);
}

/** Whole computation happens in the page; a plain array is returned. */
const AUDIT = `(() => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });
  const backdrop = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.9) return bg;
      node = node.parentElement;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor);
    return root && root.a > 0.9 ? root : { r: 255, g: 255, b: 255, a: 1 };
  };

  const failures = [];
  const seen = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const raw = (walker.currentNode.textContent || "").trim();
    if (raw.length < 2) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    // A closed <details> leaves its content in the DOM with layout boxes but
    // nothing painted. Counting it produced 1.16 "failures" on popovers that
    // were not on screen at all.
    if (el.closest("details:not([open])")) continue;
    // Same for anything the browser reports as unpainted.
    if (cs.contentVisibility === "hidden") continue;
    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = backdrop(el);
    const fg = fgRaw.a < 1 ? blend(fgRaw, bg) : fgRaw;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const value = ratio(fg, bg);
    if (value >= need) continue;
    const key = raw.slice(0, 40) + "|" + cs.color + "|" + Math.round(size);
    if (seen[key]) continue;
    seen[key] = true;
    const path = [];
    let node = el;
    while (node && node !== document.body && path.length < 3) {
      if (typeof node.className === "string" && node.className) path.unshift(node.className.split(" ")[0]);
      node = node.parentElement;
    }
    failures.push({
      texte: raw.slice(0, 46),
      ratio: Math.round(value * 100) / 100,
      requis: need,
      taille: Math.round(size * 10) / 10,
      gras: weight,
      couleur: cs.color,
      fond: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      chemin: path.join(" > "),
    });
  }
  return failures;
})()`;

const failures = await ev(AUDIT);
const theme = await ev(`document.documentElement.dataset.theme || (document.body.className.match(/light|dark/) || ["?"])[0]`);

console.log(`\ntheme actif : ${theme}`);
console.log(`${failures.length} texte(s) sous le seuil WCAG AA\n`);
for (const f of [...failures].sort((a, b) => a.ratio - b.ratio)) {
  console.log(`  ${String(f.ratio).padStart(5)} (requis ${f.requis})  ${String(f.taille).padStart(4)}px/${String(f.gras).padStart(3)}  "${f.texte}"`);
  console.log(`         ${f.couleur} sur ${f.fond}   ${f.chemin}`);
}
ws.close();
