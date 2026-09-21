#!/usr/bin/env node

/**
 * Measure horizontal overflow in the work panel, with asserted preconditions
 * and a self-test that must pass before any number is reported.
 *
 * WHY THIS SCRIPT HAS SO MUCH SCAFFOLDING
 *
 * Five successive versions of this measurement produced confident, useless
 * numbers. Each failure is now guarded against explicitly, because "the
 * measurement looked fine" is exactly how the previous four got through:
 *
 *   1. It measured a DOM that was not rendered (the panel root element was
 *      null) and reported stale values twice with identical figures, which read
 *      as confirmation.  -> preconditions are asserted before measuring.
 *   2. It reported every element whose scrollWidth exceeded its clientWidth,
 *      counting INTENTIONAL truncation as a defect. `.sr-only` is a 1x1 box by
 *      design and the stylesheet has 51 text-overflow:ellipsis rules; together
 *      they produced a 753px "overflow" that is invisible by construction.
 *      -> only content escaping a box that cannot scroll it away counts.
 *   3. `getComputedStyle().paddingRight` returns the STRING "0px", so
 *      `paddingRight * 1` is NaN, `Math.max` propagates NaN, and `NaN > worst`
 *      is always false: every element was silently discarded and the report
 *      said "no overflow" everywhere.  -> lengths are parsed, and a
 *      non-numeric length throws instead of flowing into a comparison.
 *   4. Rows were labelled with the class of the CHILD that stuck out rather
 *      than the leaking container, so every report misattributed the culprit.
 *      -> labelOf() names the overflowing element itself.
 *   5. The predicate skipped self-test probes by class internally, so the
 *      self-test could never find its own probe and declared a working
 *      detector blind.  -> scan() knows nothing about probes; the caller
 *      filters them out.
 *
 * A sixth, more mundane trap: this file builds the in-page predicate as a
 * template literal, so a backtick anywhere inside it terminates the string.
 *
 * Usage:
 *   node scripts/ux-panel-overflow.mjs --port 9227
 *   node scripts/ux-panel-overflow.mjs --port 9227 --tab Desktop
 */
import { exit } from "node:process";

const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const ONLY = (() => { const i = process.argv.indexOf("--tab"); return i >= 0 ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

/** Each tab and the root element that proves it is rendered. */
const TABS = [
  { name: "Content", root: ".artifacts-pane" },
  { name: "Review", root: ".review-panel" },
  { name: "Terminal", root: ".terminal-panel" },
  { name: "Files", root: ".files-panel" },
  { name: "Browser", root: ".browser-panel" },
  { name: "Desktop", root: ".desktop-control-panel" },
  { name: "Memory", root: ".memory-panel" },
];

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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception dans la page");
  const v = r.result?.result?.value;
  if (v === undefined) throw new Error(`undefined (${expression.slice(0, 60)})`);
  return v;
}

/**
 * "Would paint something."
 *
 * NOT `offsetParent !== null`: that is null for <body> and for every
 * `position: fixed` element, which made the self-test probe report itself
 * invisible and a scan return zero rows.
 */
const VIS = `const vis = (n) => {
  if (!n || !n.isConnected) return false;
  const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false;
  for (let p = n.parentElement; p; p = p.parentElement) {
    const pc = getComputedStyle(p);
    if (pc.display === "none") return false;
    if (p.tagName === "DETAILS" && !p.open && p.firstElementChild && p.firstElementChild.tagName !== "SUMMARY") return false;
  }
  return true;
};`;

/** Poll a page-side predicate until it holds, or give up. */
async function waitFor(label, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await ev(predicate);
    if (last === true) { console.log(`  precondition OK   : ${label}`); return true; }
    await sleep(700);
  }
  console.error(`  PRECONDITION ECHOUEE : ${label} (dernier etat : ${JSON.stringify(last)})`);
  return false;
}

/**
 * In-page predicate. Reports, for one tab, the elements whose content escapes a
 * box that is not allowed to scroll it away, plus a self-test result.
 */
const PREDICATE = `(() => { ${VIS}
  const PROBE = "__ux-overflow-probe";
  const SKIP = /(^|\\s)sr-only(\\s|$)/;

  /** CSS length -> number, loudly. See trap 3 in the file header. */
  const num = (v, what) => {
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) throw new Error("longueur CSS non numerique pour " + what + " : " + JSON.stringify(v));
    return n;
  };
  const pluses = (a, b) => Math.max(0, a - b);

  /** px escaping the padding box of an element that cannot scroll them away. */
  function escaped(el, c, r, ppc) {
    const padL = num(c.paddingLeft, "paddingLeft") * ppc;
    const padR = num(c.paddingRight, "paddingRight") * ppc;
    let worst = 0;
    for (const kid of el.children) {
      const k = kid.getBoundingClientRect();
      if (k.width === 0 && k.height === 0) continue;
      const over = Math.max(pluses(k.right, r.right - padR), pluses(r.left + padL, k.left));
      if (Number.isFinite(over) && over > worst) worst = over;
    }
    return worst;
  }

  /** Label for the element that overflows - itself, never its child (trap 4). */
  function labelOf(el) {
    const raw = el.getAttribute ? el.getAttribute("class") : null;
    const first = raw ? String(raw).trim().split(/\\s+/)[0] : "";
    return first || el.tagName.toLowerCase();
  }

  /** Horizontal overflow in a subtree. Knows nothing about probes (trap 5). */
  function scan(scope) {
    const out = [];
    for (const el of scope.querySelectorAll("*")) {
      if (!vis(el)) continue;
      if (SKIP.test(String(el.getAttribute("class") || ""))) continue;
      const c = getComputedStyle(el);
      if (c.overflowX !== "visible") continue;
      if (c.display === "inline" && el.clientWidth === 0 && el.clientHeight === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const ppc = el.offsetParent ? (el.offsetWidth / r.width) : 1;
      const worst = escaped(el, c, r, ppc);
      if (worst > 1) out.push({ cls: labelOf(el), plus: Math.round(worst) });
    }
    return out;
  }

  /**
   * Two synthetic cases, both asserted, because checking only the positive one
   * is how a detector that reports intentional clipping as a defect passes its
   * own test.
   */
  function selfTest() {
    const build = (probeClass, overflowValue) => {
      const box = document.createElement("div");
      box.className = PROBE + "-" + probeClass;
      box.setAttribute("style",
        "position:fixed;left:-9999px;top:0;width:100px;overflow-x:" + overflowValue + ";overflow-y:visible");
      const kid = document.createElement("div");
      kid.setAttribute("style", "width:300px;height:10px");
      box.appendChild(kid);
      document.body.appendChild(box);
      const computed = getComputedStyle(box).overflowX;
      const rows = scan(box.parentElement).filter((r) => r.cls.indexOf(PROBE) === 0);
      box.remove();
      return { reported: rows.length > 0, plus: rows[0] ? rows[0].plus : 0, computed };
    };
    const leaky = build("visible", "visible");
    const clipped = build("clipped", "hidden");
    return {
      detected: leaky.reported && leaky.plus === 200 && !clipped.reported && clipped.computed === "hidden",
      plus: leaky.plus,
      leaky: leaky.reported,
      clipped: clipped.reported,
      computedLeaky: leaky.computed,
      computedClipped: clipped.computed,
    };
  }

  const body = document.querySelector(".work-panel-body");
  if (!body) return { body: false, self: null, overflows: [], rows: 0 };
  let self;
  try { self = selfTest(); } catch (e) { self = { detected: false, error: String(e) }; }
  const all = scan(body);
  return {
    body: true,
    self,
    overflows: all.filter((r) => r.cls.indexOf(PROBE) !== 0),
    rows: all.length,
  };
})()`;

// 1. A conversation must be displayed.
const composer = await waitFor("vue conversation affichee",
  `(() => { ${VIS} return [...document.querySelectorAll("textarea")].some(vis) && Boolean(document.querySelector("h1")); })()`);
if (!composer) { console.error("Ouvre une conversation avant de mesurer. Abandon."); ws.close(); process.exit(1); }

// 2. The work panel must be expanded: its tabs only exist in the DOM when it is.
const open = await waitFor("panneau de travail deplie",
  `(() => { ${VIS} if ([...document.querySelectorAll("button")].some((b) => vis(b) && (b.getAttribute("aria-label")||"") === "Hide work panel")) return true;
    const b = [...document.querySelectorAll("button")].find((n) => (n.getAttribute("aria-label")||"") === "Show work panel");
    if (b) b.click();
    return false; })()`, 20_000);
if (!open) { console.error("Le panneau ne s'ouvre pas. Abandon."); ws.close(); process.exit(1); }

console.log("");
const results = [];
let SELF_OK = false;
for (const tab of TABS) {
  if (ONLY && tab.name !== ONLY) continue;

  const clicked = await ev(`(() => { ${VIS}
    const b = [...document.querySelectorAll("button, [role=tab]")].filter(vis)
      .find((n) => (n.innerText || "").trim() === ${JSON.stringify(tab.name)});
    if (!b) return false;
    b.click();
    return true; })()`);
  if (!clicked) { console.log(`${tab.name.padEnd(9)} ONGLET INTROUVABLE — ignore`); continue; }
  await sleep(1_600);

  // The proof that the tab is really showing: its own root element is present.
  const rendered = await ev(`(() => { ${VIS} return Boolean(document.querySelector(${JSON.stringify(tab.root)})); })()`);
  if (!rendered) {
    console.log(`${tab.name.padEnd(9)} RACINE ABSENTE (${tab.root}) — mesure refusee`);
    results.push({ tab: tab.name, rendered: false, overflows: null, total: null });
    continue;
  }

  const scan = await ev(PREDICATE);
  if (!scan.body) {
    console.log(`${tab.name.padEnd(9)} CORPS DE PANNEAU ABSENT — mesure refusee`);
    results.push({ tab: tab.name, rendered: false, overflows: null, total: null });
    continue;
  }

  if (!SELF_OK) {
    if (!scan.self.detected) {
      console.error(`\nAUTO-TEST ECHOUE : le detecteur ne se comporte pas correctement sur des cas synthetiques.`);
      console.error(`  debordement visible de 200px : signale=${scan.self.leaky} valeur=+${scan.self.plus}px  (attendu true / +200)`);
      console.error(`  debordement coupe (hidden)   : signale=${scan.self.clipped}  (attendu false)`);
      console.error(`  overflowX calcule            : visible=${scan.self.computedLeaky} coupe=${scan.self.computedClipped}`);
      if (scan.self.error) console.error(`  exception : ${scan.self.error}`);
      console.error(`Les chiffres ne veulent rien dire tant que ceci echoue.\n`);
      ws.close(); process.exit(2);
    }
    SELF_OK = true;
    console.log(`  auto-test OK      : +${scan.self.plus}px detecte (visible), ignore (overflow-x:hidden)`);
  }

  const { overflows } = scan;
  const total = overflows.reduce((sum, o) => sum + o.plus, 0);
  const detail = overflows.length ? "  " + overflows.map((o) => `.${o.cls} +${o.plus}`).join(" | ") : "  OK";
  console.log(`${tab.name.padEnd(9)} rendu=oui  debordements=${overflows.length}  total=+${total}px${detail}`);
  results.push({ tab: tab.name, rendered: true, overflows, total });
}

const measured = results.filter((r) => r.rendered);
const worst = measured.reduce((a, b) => (a && a.total >= b.total ? a : b), null);
console.log(`\n${measured.length} onglet(s) mesure(s) · pire : ${worst ? `${worst.tab} (+${worst.total}px)` : "aucun"}`);
ws.close();
