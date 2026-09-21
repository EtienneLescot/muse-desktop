#!/usr/bin/env node
/**
 * Inventory what an archived conversation row actually offers, and what its
 * destructive action does about confirming first.
 *
 * The report was "on ne peut rien faire à part le désarchiver". Two delete
 * affordances do exist in the markup, so either they are not visible in practice
 * or something else is wrong. Measuring the rendered row answers which.
 *
 * Deliberately read-only: nothing is clicked, so no conversation is deleted.
 *
 * Usage: node scripts/ux-archived-row-actions.mjs --port 9227
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

const report = await ev(`(() => { ${VIS}
  const archived = document.querySelector(".archived-section");
  const rows = archived ? [...archived.querySelectorAll(".session-item")].filter(vis) : [];
  const describe = (li) => {
    const buttons = [...li.querySelectorAll("button")].filter(vis).map((b) => {
      const r = b.getBoundingClientRect();
      const c = getComputedStyle(b);
      const label = (b.innerText || "").trim();
      return {
        label,
        title: b.getAttribute("title"),
        cls: (b.getAttribute("class") || "").slice(0, 24),
        w: Math.round(r.width), h: Math.round(r.height),
        danger: c.color,
        // The actions live in the session-meta block, which may be hidden until
        // the row is hovered.
        visible: r.width > 0 && r.height > 0,
        opacity: c.opacity,
        inMeta: Boolean(b.closest(".session-meta")),
      };
    });
    const meta = li.querySelector(".session-meta");
    return {
      title: (li.querySelector(".session-title")?.innerText || "").trim().slice(0, 34),
      buttons,
      metaDisplay: meta ? getComputedStyle(meta).display : null,
      metaOpacity: meta ? getComputedStyle(meta).opacity : null,
      metaVisibility: meta ? getComputedStyle(meta).visibility : null,
    };
  };
  return {
    archivedSectionPresent: Boolean(archived),
    archivedCount: rows.length,
    collapsed: (() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /archiv/i.test(b.getAttribute("aria-label") || "") || /Archived/i.test(b.innerText || ""));
      return btn ? (btn.getAttribute("aria-expanded") ?? "no-aria-expanded") : null;
    })(),
    rows: rows.slice(0, 3).map(describe),
  };
})()`);

console.log(JSON.stringify(report, null, 2));
ws.close();
