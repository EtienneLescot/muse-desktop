#!/usr/bin/env node
/**
 * Exercise the find bar after the dock change: open it, type a query, confirm
 * matches are found and listed, then close it.
 *
 * The dock change moved the sticky container and the full-width backdrop, so the
 * interactive path has to be re-proved rather than assumed — especially the
 * results panel, which lives inside the same dock.
 *
 * Usage: node scripts/ux-find-bar-interact.mjs --port 9227
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

const open = await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll(".stream-find button")].filter(vis)
    .find((n) => /Find in conversation/i.test(n.innerText || ""));
  if (!b) return false;
  b.click();
  return true; })()`);
console.log(`  ouverture par le bouton : ${open}`);
await sleep(700);

const typed = await ev(`(() => { ${VIS}
  const input = document.querySelector(".stream-find input");
  if (!input) return false;
  input.focus();
  return document.activeElement === input; })()`);
console.log(`  champ focalise : ${typed}`);

for (const ch of "audio") {
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
  await sleep(50);
}
await sleep(900);

const state = await ev(`(() => { ${VIS}
  const dock = document.querySelector(".stream-find-dock");
  const input = document.querySelector(".stream-find input");
  const count = document.querySelector(".stream-find-count");
  const hits = document.querySelector(".stream-find-hits");
  const dr = dock ? dock.getBoundingClientRect() : null;
  return {
    query: input ? input.value : null,
    countText: count ? (count.innerText || "").trim() : null,
    hitsVisible: hits ? vis(hits) : false,
    hitCount: hits ? hits.querySelectorAll("button").length : 0,
    dock: dr ? { top: Math.round(dr.top), width: Math.round(dr.width), height: Math.round(dr.height) } : null,
    streamWidth: Math.round((document.querySelector(".stream")?.getBoundingClientRect().width) ?? 0),
    // Content behind the dock while it is open and pinned.
    stackInDock: (() => {
      if (!dr) return [];
      const x = Math.round(dr.left + dr.width * 0.02);
      const y = Math.round(dr.top + dr.height / 2);
      return document.elementsFromPoint(x, y).slice(0, 3)
        .map((n) => (n.getAttribute("class") || n.tagName).toString().slice(0, 28));
    })(),
  };
})()`);
console.log("");
console.log(JSON.stringify(state, null, 2));

// Close again so the conversation is left as found.
await ev(`(() => { ${VIS}
  const b = [...document.querySelectorAll(".stream-find button")].filter(vis)
    .find((n) => /^Close$/.test((n.innerText || "").trim()));
  if (b) b.click();
  return Boolean(b); })()`);
await sleep(400);
const closed = await ev(`(() => { const i = document.querySelector(".stream-find input"); return i === null; })()`);
console.log(`\n  ferme apres usage : ${closed}`);
ws.close();
