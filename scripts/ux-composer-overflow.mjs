#!/usr/bin/env node
/**
 * Guard: the composer's control row must never clip its own controls.
 *
 * The row holds five pills, and one of them carries a 25-character model id
 * ("muse-spark-1.3-contributor"). The four others cannot shrink — their labels
 * are `white-space: nowrap` — so a row that refuses to wrap has only two
 * outcomes, both wrong: the chip is squeezed until its label disappears, or it
 * escapes the composer's padding box and is cut mid-glyph.
 *
 * That is what happened. An earlier fix capped `.composer-model > button` at
 * 22ch; when that button became the `<details>` picker the selector stopped
 * matching anything, and nothing replaced it. Measured before the fix: at a
 * 1296px viewport the control row scrolled 579px inside 536, the chip needed
 * 199px inside a 154px box, and at 1100px its label collapsed to 0px.
 *
 * The composer is not monotonic in the viewport (416px wide at a 1024px
 * viewport, 610px at 900px — the work panel takes a share), so this asserts the
 * invariant at each width instead of trusting one breakpoint.
 *
 * Ellipsis is deliberately NOT a failure. `displayLabel` comes from the host
 * catalog, so a longer label than the one measured here is possible, and the
 * stylesheet answers that with an intentional ellipsis. What must never happen
 * is the row overflowing, a control painting outside the composer, or the chip
 * collapsing; truncation is reported as information.
 *
 * Usage: node scripts/ux-composer-overflow.mjs [--port 9227]
 */
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : 9227;
})();
const WIDTHS = [1440, 1366, 1296, 1200, 1100, 1024, 900, 820, 760, 700, 640];
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !String(t.url).startsWith("chrome-error"));
if (!page) {
  console.error("pas de page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const f = JSON.parse(typeof e.data === "string" ? e.data : "");
  if (f.id === undefined) return;
  const p = pending.get(f.id);
  if (p) {
    pending.delete(f.id);
    p(f);
  }
});
const cmd = (m, p) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exception");
  return r.result?.result?.value;
}

const VIS = `const vis = (n) => { if (!n || !n.isConnected) return false; const c = getComputedStyle(n);
  if (c.display === "none" || c.visibility === "hidden") return false;
  if (c.display !== "contents" && n.getClientRects().length === 0) return false;
  // A closed <details> keeps a rect for its content: Chrome hides it through
  // content-visibility, so display, visibility and getClientRects all still say
  // "rendered". The model popover lives there, 300px wide, and would otherwise
  // be reported as escaping the composer by more than 200px at every width.
  if (n.closest("details:not([open])")) return false;
  return true; };`;

const PROBE = `(() => { ${VIS}
  const composer = document.querySelector(".composer");
  const row = document.querySelector(".composer-actions");
  const context = document.querySelector(".composer-context");
  if (!composer || !row || !context) return { missing: true };
  const cr = composer.getBoundingClientRect();
  const cs = getComputedStyle(composer);
  const innerRight = cr.right - (Number.parseFloat(cs.paddingRight) || 0);
  const innerLeft = cr.left + (Number.parseFloat(cs.paddingLeft) || 0);
  let escape = 0;
  for (const node of row.querySelectorAll("*")) {
    if (!vis(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    escape = Math.max(escape, Math.round(r.right - innerRight), Math.round(innerLeft - r.left));
  }
  const trigger = document.querySelector(".model-control-compact .model-trigger");
  const label = trigger ? trigger.querySelector("strong") : null;
  return {
    viewport: window.innerWidth,
    rowScroll: row.scrollWidth - row.clientWidth,
    contextScroll: context.scrollWidth - context.clientWidth,
    escape: Math.max(0, escape),
    chipWidth: trigger ? Math.round(trigger.getBoundingClientRect().width) : null,
    labelText: label ? label.innerText.trim() : null,
    labelVisible: label ? label.clientWidth : null,
    labelNeeds: label ? label.scrollWidth : null,
  }; })()`;

// Assert the precondition before trusting any number: an empty conversation
// renders no composer, and a missing model control measures nothing.
const ready = await ev(`(() => { ${VIS}
  return Boolean(document.querySelector(".composer-actions") && document.querySelector(".model-control-compact .model-trigger")); })()`);
if (!ready) {
  console.error("precondition: composer ou selecteur de modele absent — ouvre une conversation avant de mesurer");
  ws.close();
  process.exit(1);
}
const labelText = await ev(`document.querySelector(".model-control-compact .model-trigger strong").innerText.trim()`);
console.log(`modele affiche : ${JSON.stringify(labelText)}`);
console.log("largeur  ligne(+px)  contexte(+px)  hors boite  pastille  libelle(visible/besoin)");

const failures = [];
for (const width of WIDTHS) {
  await cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
  const m = await ev(PROBE);
  if (m.missing) {
    failures.push({ width, why: "composer absent" });
    continue;
  }
  const bad = [];
  if (m.rowScroll > 1) bad.push(`ligne +${m.rowScroll}px`);
  if (m.contextScroll > 1) bad.push(`contexte +${m.contextScroll}px`);
  if (m.escape > 1) bad.push(`hors boite +${m.escape}px`);
  if (m.chipWidth !== null && m.chipWidth < 90) bad.push(`pastille ${m.chipWidth}px`);
  // Reported, never a failure: the stylesheet ellipsises on purpose when a
  // catalog label cannot fit, and the host owns that label's length.
  const truncated =
    m.labelVisible !== null && m.labelNeeds !== null && m.labelVisible < m.labelNeeds;
  console.log(
    `  ${String(width).padEnd(6)} ${String(m.rowScroll).padEnd(10)} ${String(m.contextScroll).padEnd(14)} ` +
    `${String(m.escape).padEnd(11)} ${String(m.chipWidth).padEnd(9)} ${m.labelVisible}/${m.labelNeeds}` +
    `${truncated ? "   repli ellipse" : ""}${bad.length ? "   <-- " + bad.join(" | ") : ""}`,
  );
  if (bad.length > 0) failures.push({ width, why: bad.join(" | ") });
}
await cmd("Emulation.clearDeviceMetricsOverride", {});

console.log("");
if (failures.length === 0) {
  console.log(`${WIDTHS.length} largeurs testees, aucun rognage`);
  ws.close();
  process.exit(0);
}
for (const f of failures) console.log(`  KO  ${f.width}px : ${f.why}`);
console.log(`\n${failures.length} largeur(s) sur ${WIDTHS.length} rognent les controles du composeur`);
ws.close();
process.exit(1);
