#!/usr/bin/env node
/**
 * Open a conversation, expand the work panel, select the Terminal tab, and
 * report the real WCAG contrast of its control labels.
 *
 * `ux-control-contrast.mjs` returned "aucun controle mesure" on a fresh app
 * because the work panel was collapsed and no conversation was open: the
 * selectors were correct, the state was not. This script asserts each
 * precondition before measuring, the same discipline the other probes use.
 *
 * Usage: node scripts/ux-terminal-contrast.mjs --port 9227 [--theme light|dark]
 */
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const THEME = (() => { const i = process.argv.indexOf("--theme"); return i >= 0 ? process.argv[i + 1] : "light"; })();
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

const CONTRAST = `
  const parseColor = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const effectiveBg = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const bg = parseColor(getComputedStyle(p).backgroundColor);
      if (!bg || bg.a === 0) continue;
      layers.push(bg);
      if (bg.a === 1) break;
    }
    if (layers.length === 0) return { r: 255, g: 255, b: 255, a: 1 };
    let acc = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const rgb = (c) => "rgb(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + ")";
`;

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(predicate)) === true) { console.log(`  precondition OK   : ${label}`); return true; }
    await sleep(700);
  }
  console.error(`  PRECONDITION ECHOUEE : ${label}`);
  return false;
}

// 1. Theme.
await ev(`(() => { ${VIS}
  const want = ${JSON.stringify(THEME)};
  const isDark = document.body.classList.contains("dark");
  if ((want === "dark") === isDark) return "deja";
  const btn = [...document.querySelectorAll("button")].filter(vis).find((b) =>
    /theme|thème|dark|light|sombre|clair/i.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")));
  if (btn) btn.click();
  return "bascule"; })()`);
await sleep(800);
console.log(`  theme : ${await ev(`document.body.classList.contains("dark") ? "dark" : "light"`)} (demande ${THEME})`);

// 2. A conversation must be open: the work panel only exists inside one.
const conv = await waitFor("conversation ouverte",
  `(() => { ${VIS} return [...document.querySelectorAll("textarea")].some(vis) || Boolean(document.querySelector(".composer-card, .composer")); })()`);
if (!conv) {
  // Try to open one from the sidebar.
  const opened = await ev(`(() => { ${VIS}
    const rows = [...document.querySelectorAll("button, [role=button], li, a")].filter(vis)
      .filter((n) => /Session\\s+[0-9a-f]{8}|conversation/i.test(n.innerText || ""));
    const first = rows.find((n) => { const r = n.getBoundingClientRect(); return r.left < window.innerWidth * 0.35 && r.height > 12; });
    if (first) { first.click(); return (first.innerText || "").trim().slice(0, 40); }
    return false; })()`);
  console.log(`  ouverture d'une conversation : ${opened}`);
  await sleep(2500);
  await waitFor("conversation ouverte (2e essai)",
    `(() => { ${VIS} return [...document.querySelectorAll("textarea")].some(vis) || Boolean(document.querySelector(".composer-card, .composer")); })()`);
}

// 3. The work panel must be expanded.
const open = await waitFor("panneau de travail deplie",
  `(() => { ${VIS}
    if (document.querySelector(".terminal-panel") || document.querySelector(".work-panel-body")) return true;
    if ([...document.querySelectorAll("button")].some((b) => vis(b) && (b.getAttribute("aria-label")||"") === "Hide work panel")) return true;
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label")||"") === "Show work panel");
    if (b) { b.click(); return false; }
    return false; })()`, 25_000);
if (!open) { console.error("Le panneau ne s'ouvre pas. Abandon."); ws.close(); process.exit(1); }

// 4. The Terminal tab must actually be showing.
const clicked = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
    .find((n) => (n.innerText || "").trim() === "Terminal");
  if (b) b.click();
  return Boolean(b); })()`);
if (!clicked) { console.error("Onglet Terminal introuvable."); ws.close(); process.exit(1); }
await sleep(1800);
const rendered = await waitFor("onglet Terminal rendu",
  `(() => { ${VIS} return Boolean(document.querySelector(".terminal-panel")); })()`);
if (!rendered) { console.error("Racine .terminal-panel absente : le panneau affiche peut-etre un etat vide. Abandon."); ws.close(); process.exit(1); }

const fillState = process.argv.includes("--state") ? process.argv[process.argv.indexOf("--state") + 1] : "both";
if (fillState === "enabled" || fillState === "both") {
  // Fill the command box so the two buttons leave their disabled state: WCAG
  // exempts disabled controls, so the disabled numbers say nothing about
  // readability. React ignores a direct value assignment, so the native setter
  // is used and an input event dispatched.
  const filled = await ev(`(() => { ${VIS}
    const input = document.querySelector(".terminal-input input");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "echo mesure-de-contraste");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true; })()`);
  console.log(`  champ rempli : ${filled}`);
  await sleep(700);
}

const rows = await ev(`(() => { ${VIS} ${CONTRAST}
  const out = [];
  const scope = document.querySelector(".terminal-panel");
  const targets = [...scope.querySelectorAll("button, input")].filter(vis);
  for (const el of targets) {
    const c = getComputedStyle(el);
    const fg = parseColor(c.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    // The background of the element ITSELF, composited over its ancestors.
    // Reading only the parent's background reported a coloured button as
    // sitting on white, which measured a blue-on-light-blue label as
    // blue-on-white and would have hidden the real relationship.
    const own = parseColor(c.backgroundColor);
    const ownText = own && own.a > 0 ? over(own, bg) : bg;
    const op = Number.parseFloat(c.opacity);
    const alpha = Number.isFinite(op) ? op : 1;
    // An opacity below 1 fades the control AND its text toward the backdrop.
    const paintedBg = alpha < 1 ? over({ ...ownText, a: alpha }, bg) : ownText;
    const fgOnOwn = fg.a < 1 ? over(fg, ownText) : fg;
    const paintedFg = alpha < 1 ? over({ ...fgOnOwn, a: alpha }, bg) : fgOnOwn;
    const r = ratio(paintedFg, paintedBg);
    const size = Number.parseFloat(c.fontSize) || 0;
    const weight = Number.parseInt(c.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const needed = large ? 3 : 4.5;
    out.push({ label: (el.textContent || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 26),
               tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class") || "").slice(0, 24),
               color: rgb(fg), bg: rgb(bg), ownBg: own ? rgb(own) : null, paintedBg: rgb(paintedBg),
               opacity: alpha, disabled: el.disabled === true,
               fontSize: size, needed, ratio: Math.round(r * 100) / 100, pass: r >= needed });
  }
  return out;
})()`);

console.log("");
for (const row of rows) {
  const flags = [row.disabled ? "desactive" : null, row.opacity !== 1 ? `opacity ${row.opacity}` : null].filter(Boolean).join(", ");
  console.log(`  ${row.pass ? "OK   " : "ECHEC"} ${String(row.ratio).padStart(6)}:1 (requis ${row.needed})  ${row.tag}.${row.cls} "${row.label}"  ${row.color} sur ${row.bg}${flags ? "  [" + flags + "]" : ""}`);
}
const failing = rows.filter((r) => !r.pass);
console.log(`\n${rows.length} controle(s) · ${failing.length} sous le seuil`);
const activeRows = failing.filter((r) => !r.disabled);
if (activeRows.length) console.log(`dont ${activeRows.length} ACTIF : ${activeRows.map((r) => `"${r.label}" ${r.ratio}:1`).join(", ")}`);
ws.close();
