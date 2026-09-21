#!/usr/bin/env node
/**
 * Verify what an archived conversation row offers, end to end.
 *
 * The actions were always in the markup; they were invisible because
 * `.session-meta` has `opacity: 0` until hover. A measurement that reads the DOM
 * without checking computed opacity would have "passed" against the broken
 * build, so this reports the rendered opacity and the dialog that opens.
 *
 * Nothing is deleted: the confirmation is opened and then cancelled.
 *
 * Usage: node scripts/ux-archived-delete.mjs --port 9227
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

/** Effective opacity of the actions block, which is what made them invisible. */
const ARCHIVED = `(() => { ${VIS}
  const section = document.querySelector(".archived-section");
  if (!section) return { sectionPresent: false };
  const rows = [...section.querySelectorAll(".session-item")].filter(vis);
  if (rows.length === 0) return { sectionPresent: true, rowCount: 0 };
  const li = rows[0];
  const meta = li.querySelector(".session-meta");
  const buttons = [...li.querySelectorAll("button")].filter(vis).map((b) => ({
    label: (b.innerText || "").trim(),
    danger: b.getAttribute("data-danger") === "true",
    title: b.getAttribute("title"),
    color: getComputedStyle(b).color,
  }));
  return {
    sectionPresent: true,
    rowCount: rows.length,
    metaOpacity: meta ? getComputedStyle(meta).opacity : null,
    metaVisible: meta ? vis(meta) : false,
    buttons,
  };
})()`;

console.log("  --- etat initial de la section archivee ---");
console.log("    " + JSON.stringify(await ev(ARCHIVED)));

// Archive one conversation so the section exists, then re-measure.
const archived = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => /^Archive conversation$/i.test((n.innerText || "").trim()));
  return Boolean(b); })()`);
console.log(`\n  bouton "Archive conversation" accessible dans le menu : ${archived}`);
if (!archived) {
  // The menu is opened per row; open the first row's actions trigger.
  const opened2 = await ev(`(() => { ${VIS}
    const t = [...document.querySelectorAll("button[aria-label^='Actions for']")].filter(vis)[0];
    if (!t) return false;
    t.click();
    return true; })()`);
  await sleep(600);
  const done = await ev(`(() => { ${VIS}
    const b = [...document.querySelectorAll("dialog[open] button")].filter(vis)
      .find((n) => /Archive conversation/i.test(n.innerText || ""));
    if (!b) return false;
    b.click();
    return true; })()`);
  console.log(`  menu ouvert : ${opened2} ; archivage effectue : ${done}`);
  await sleep(900);
}

const after = await ev(ARCHIVED);
console.log("\n  --- apres archivage ---");
console.log("    " + JSON.stringify(after, null, 2));

// Open the delete confirmation and read it, then cancel.
const openedDialog = await ev(`(() => { ${VIS}
  const section = document.querySelector(".archived-section");
  if (!section) return false;
  const b = [...section.querySelectorAll("button")].filter(vis)
    .find((n) => /^Delete/.test((n.innerText || "").trim()));
  if (!b) return false;
  b.click();
  return true; })()`);
await sleep(700);
const dialog = await ev(`(() => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (!d) return { open: false };
  return {
    open: true,
    heading: (d.querySelector("h2")?.innerText || "").trim(),
    body: (d.querySelector("p")?.innerText || "").replace(/\\s+/g, " ").trim(),
    buttons: [...d.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean),
  };
})()`);
console.log(`\n  confirmation ouverte depuis la ligne archivee : ${openedDialog}`);
console.log("    " + JSON.stringify(dialog, null, 2));

// Cancel so nothing is deleted.
await ev(`(() => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
  if (!d) return false;
  const b = [...d.querySelectorAll("button")].find((n) => (n.innerText || "").trim() === "Cancel");
  if (b) b.click();
  return Boolean(b);
})()`);
await sleep(500);
const stillThere = await ev(`(() => {
  const section = document.querySelector(".archived-section");
  return section ? section.querySelectorAll(".session-item").length : 0;
})()`);
console.log(`\n  conversations archivees apres annulation : ${stillThere} (rien supprime)`);
ws.close();
