#!/usr/bin/env node
/**
 * Prove the find bar actually finds something.
 *
 * A "0 matches" result is ambiguous on its own: it can mean the search is broken
 * or that the term genuinely is absent. This searches for a string that is
 * certainly present in the visible transcript, so a zero would be a real defect
 * rather than a vacuous pass.
 *
 * Usage: node scripts/ux-find-bar-finds.mjs --port 9227 --term <text>
 */
import { exit } from "node:process";
const PORT = (() => { const i = process.argv.indexOf("--port"); return i >= 0 ? Number(process.argv[i + 1]) : 9227; })();
const TERM = (() => { const i = process.argv.indexOf("--term"); return i >= 0 ? process.argv[i + 1] : "BETA"; })();
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

// What the transcript actually contains, so the expectation is grounded.
const text = await ev(`(() => (document.querySelector(".stream")?.innerText || ""))()`);
console.log(`  transcript : ${text.length} caracteres`);
console.log(`  le terme "${TERM}" y figure : ${text.toLowerCase().includes(TERM.toLowerCase()) ? "OUI" : "NON"}`);

await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll(".stream-find button")].filter(vis).find((n) => /Find in conversation/i.test(n.innerText || ""));
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(600);

const focused = await ev(`(() => { const i = document.querySelector(".stream-find input"); if (i) i.focus(); return Boolean(i); })()`);
if (!focused) { console.error("  champ de recherche absent"); ws.close(); process.exit(1); }

for (const ch of TERM) {
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
  await sleep(50);
}
await sleep(900);

const result = await ev(`(() => { ${VIS}
  const count = document.querySelector(".stream-find-count");
  const hits = document.querySelector(".stream-find-hits");
  const marks = document.querySelectorAll("mark, .stream-find-target").length;
  return {
    countText: count ? (count.innerText || "").trim() : null,
    hitsVisible: hits ? vis(hits) : false,
    listedHits: hits ? hits.querySelectorAll("button").length : 0,
    highlightedMarks: marks,
  };
})()`);
console.log("\n  resultat de la recherche :");
console.log("    " + JSON.stringify(result));

const found = /[1-9]/.test(result.countText || "");
console.log(`\n  la recherche trouve quelque chose : ${found ? "OUI" : "NON"}`);

// Close and leave the conversation as found.
await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll(".stream-find button")].filter(vis).find((n) => /^Close$/.test((n.innerText || "").trim()));
  if (b) b.click();
  return Boolean(b); })()`);
ws.close();
process.exit(found ? 0 : 1);
