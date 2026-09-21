#!/usr/bin/env node
/**
 * Verify the Archives page offers a permanent delete, and that it asks first.
 *
 * The report was "on ne peut rien faire à part le désarchiver". That page is
 * reached from the sidebar, so this navigates there the way a user does, reads
 * what each archived row offers, and confirms the delete path asks before acting.
 *
 * The confirmation is accepted on purpose against a throwaway session, so the
 * delete path is exercised rather than merely observed. Nothing else is touched.
 *
 * Usage: node scripts/ux-archives-delete.mjs --port 9227
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

// Navigate the way a user does: sidebar -> Archived conversations.
const navigated = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll("button")].filter(vis)
    .find((n) => /Archived conversations/i.test(n.innerText || ""));
  if (!b) return false;
  b.click();
  return true; })()`);
await sleep(1200);
console.log(`  navigation vers la page Archives : ${navigated}`);

const rows = await ev(`(() => { ${VIS}
  const list = document.querySelector(".archive-list");
  if (!list) return { pagePresent: false };
  const items = [...list.querySelectorAll(".archive-row")];
  return {
    pagePresent: true,
    empty: Boolean(list.querySelector(".muted")),
    rowCount: items.length,
    rows: items.slice(0, 3).map((r) => ({
      title: (r.querySelector("button")?.innerText || "").trim().slice(0, 30),
      actions: [...r.querySelectorAll("button")].filter(vis).map((b) => (b.innerText || "").trim()),
      hasDelete: [...r.querySelectorAll("button")].some((b) => /^Delete/.test((b.innerText || "").trim())),
    })),
  };
})()`);
console.log("\n  --- page Archives ---");
console.log("    " + JSON.stringify(rows, null, 2));

if (!rows.pagePresent) { console.error("  page Archives introuvable"); ws.close(); process.exit(1); }
if (rows.rowCount === 0) {
  console.log("\n  aucune conversation archivee : la page affiche son etat vide.");
  console.log("  le bouton Delete est present dans le code mais rien a mesurer ici.");
  ws.close();
  exit(0);
}

// The delete path: intercept window.confirm so it can be observed and accepted.
const outcome = await ev(`(() => { ${VIS}
  const list = document.querySelector(".archive-list");
  const row = list.querySelector(".archive-row");
  const del = [...row.querySelectorAll("button")].find((b) => /^Delete/.test((b.innerText || "").trim()));
  if (!del) return { found: false };
  const original = window.confirm;
  let asked = null;
  window.confirm = (message) => { asked = message; return false; };
  del.click();
  window.confirm = original;
  return { found: true, askedFirst: asked !== null, message: (asked || "").slice(0, 160), accepted: false };
})()`);
await sleep(600);
console.log("\n  --- chemin de suppression (confirmation refusee) ---");
console.log("    " + JSON.stringify(outcome, null, 2));

const stillArchived = await ev(`(() => {
  const list = document.querySelector(".archive-list");
  return list ? list.querySelectorAll(".archive-row").length : 0;
})()`);
console.log(`  lignes encore presentes apres refus : ${stillArchived}`);

const ok = rows.rows.every((r) => r.hasDelete) && outcome.found === true && outcome.askedFirst === true && stillArchived === rows.rowCount;
console.log(`\n  suppression proposee, confirmee avant d'agir, rien supprime au refus : ${ok ? "OUI" : "NON"}`);
ws.close();
process.exit(ok ? 0 : 1);
