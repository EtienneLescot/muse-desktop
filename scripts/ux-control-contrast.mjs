#!/usr/bin/env node
/**
 * Measure the real WCAG contrast of specific control labels, from computed
 * styles composited down to the first opaque background.
 *
 * Written because an independent visual review reported "Run in Muse" at 1.75:1
 * and "Send" at 1.97:1 on the Terminal panel, and because the existing
 * `ux-contrast-audit.mjs` reported ZERO failures in the same state: that audit
 * samples the default surfaces, so a coloured button on a panel footer was
 * never in its sample. A measurement that cannot see the defect is not evidence
 * that there is no defect.
 *
 * Usage:
 *   node scripts/ux-control-contrast.mjs --port 9227 [--theme light|dark]
 *   node scripts/ux-control-contrast.mjs --port 9227 --selector ".terminal-input button"
 */
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const THEME = (() => { const i = process.argv.indexOf("--theme"); return i >= 0 ? process.argv[i + 1] : "light"; })();
const ONLY = (() => { const i = process.argv.indexOf("--selector"); return i >= 0 ? process.argv[i + 1] : null; })();
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
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}

const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false; return true; };`;

/** Relative luminance and contrast, per WCAG 2.1. Kept in the page so the
 *  measurement uses the browser's own resolved colours, not my parsing. */
const CONTRAST = `
  const parseColor = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  /** Walk up until an opaque background is found, compositing translucent layers. */
  const effectiveBg = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const c = getComputedStyle(p);
      const bg = parseColor(c.backgroundColor);
      if (!bg || bg.a === 0) continue;
      layers.push(bg);
      if (bg.a === 1) break;
    }
    if (layers.length === 0) return { r: 255, g: 255, b: 255, a: 1 };
    let acc = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
`;

async function setTheme(theme) {
  // The app stores the theme in localStorage under a known key; the header
  // toggle is the source of truth, so drive the app rather than the storage.
  const applied = await ev(`(() => { ${VIS}
    const want = ${JSON.stringify(theme)};
    const isDark = document.body.classList.contains("dark");
    if ((want === "dark") === isDark) return "deja " + want;
    const btn = [...document.querySelectorAll("button")].filter(vis).find((b) => {
      const label = (b.getAttribute("aria-label") || "") + " " + (b.textContent || "");
      return /theme|thème|dark|light|sombre|clair/i.test(label);
    });
    if (!btn) return "bouton de theme introuvable";
    btn.click();
    return "bascule cliquee";
  })()`);
  await sleep(900);
  const state = await ev(`document.body.classList.contains("dark") ? "dark" : "light"`);
  return { applied, state };
}

console.log(`theme demande : ${THEME}`);
const themeResult = await setTheme(THEME);
console.log(`  ${themeResult.applied} -> etat reel : ${themeResult.state}`);

// The Terminal tab owns the two buttons under review; open it first.
await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
    .find((n) => (n.innerText || "").trim() === "Terminal");
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(1500);

const SELECTOR = ONLY ?? ".terminal-input button, .terminal-actions button, .terminal-input input";
const rows = await ev(`(() => { ${VIS} ${CONTRAST}
  const out = [];
  for (const el of document.querySelectorAll(${JSON.stringify(SELECTOR)})) {
    if (!vis(el)) continue;
    const c = getComputedStyle(el);
    const fg = parseColor(c.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    const composed = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(composed, bg);
    const size = Number.parseFloat(c.fontSize) || 0;
    const weight = Number.parseInt(c.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    out.push({
      label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24),
      tag: el.tagName.toLowerCase(),
      color: c.color,
      bg: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      alpha: c.opacity,
      disabled: el.disabled === true,
      fontSize: size,
      large,
      ratio: Math.round(r * 100) / 100,
      needed: large ? 3 : 4.5,
      pass: r >= (large ? 3 : 4.5),
    });
  }
  return out;
})()`);

console.log("");
if (rows.length === 0) console.log("  aucun controle mesure (onglet Terminal ouvert ?)");
for (const row of rows) {
  const flags = [
    row.disabled ? "desactive" : null,
    row.alpha !== "1" ? `opacity ${row.alpha}` : null,
    row.large ? "grand texte" : "texte normal",
  ].filter(Boolean).join(", ");
  console.log(`  ${row.pass ? "OK  " : "ECHEC"} ${String(row.ratio).padStart(6)}:1  (requis ${row.needed})  ${row.tag} "${row.label}"  ${row.color} sur ${row.bg}  [${flags}]`);
}
const failing = rows.filter((r) => !r.pass && !r.disabled);
console.log(`\n${rows.length} controle(s) · ${failing.length} echec(s) hors controles desactives`);
ws.close();
